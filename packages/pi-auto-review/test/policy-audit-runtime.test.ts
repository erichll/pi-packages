import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PolicyAuditStore } from "../src/policy-audit/store.ts";

const bunAvailable = spawnSync("bun", ["--version"], { timeout: 5_000 }).status === 0;
const bunTest = bunAvailable ? test : test.skip;

bunTest("Bun passes the audit persistence, migration, redaction, and failure contract", { timeout: 30_000 }, () => {
  const suite = fileURLToPath(new URL("./policy-audit.test.ts", import.meta.url));
  const run = spawnSync("bun", ["test", suite], { encoding: "utf8", timeout: 25_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

function bunWriter(directory: string, requestId: string): Promise<{ recorded: boolean; total: number }> {
  const worker = fileURLToPath(new URL("./fixtures/policy-audit-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [worker, directory, requestId], { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        assert.equal(code, 0, stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}

bunTest("Node and Bun share a WAL database, HMAC key, and cross-process deduplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-audit-cross-runtime-"));
  let store: PolicyAuditStore | undefined;
  try {
    // Start with a Bun-created database, then keep a Node connection open while
    // two Bun processes compete to record the same request.
    assert.deepEqual(await bunWriter(root, "shared"), { recorded: true, total: 1 });
    const key = readFileSync(join(root, "policy-audit.key"));
    store = await PolicyAuditStore.open({ directory: root, retentionDays: 180 });
    const event = {
      requestId: "shared", surface: "bash", signature: "git status", bashCategory: "simple",
      risk: "read_only" as const, pathClass: "unknown" as const, features: [],
      result: "allow" as const, resolution: "user_approved", origin: "project", forwarded: false,
    };
    assert.equal(store.record("/work/shared-project", event), false);
    assert.equal(store.record("/work/shared-project", { ...event, requestId: "node" }), true);
    const writes = await Promise.allSettled([bunWriter(root, "concurrent"), bunWriter(root, "concurrent")]);
    const results = writes.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.equal(results.filter((result) => result.recorded).length, 1);
    assert.ok(results.every((result) => result.total === 3));
    const result = store.query({ days: 30, top: 20, minCount: 1, scope: "current", projectPath: "/work/shared-project" });
    assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), 3);
    assert.equal(store.record("/work/shared-project", { ...event, requestId: "node-final" }), true);
    store.close();
    assert.deepEqual(await bunWriter(root, "shared"), { recorded: false, total: 4 });
    assert.deepEqual(readFileSync(join(root, "policy-audit.key")), key);
    assert.equal(existsSync(join(root, "policy-audit.sqlite-wal")), false);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

bunTest("Bun-compiled Pi loads the audit backend and produces a persistent report", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-audit-compiled-"));
  const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const auditModule = fileURLToPath(new URL("../src/policy-audit/index.ts", import.meta.url));
  const binary = join(root, "pi");
  const extension = join(root, "probe.ts");
  const directory = join(root, "audit");
  try {
    writeFileSync(extension, `
      import { PolicyAuditController } from ${JSON.stringify(auditModule)};
      export default function(pi) {
        pi.on('session_start', async (_event, ctx) => {
          const warnings = [];
          const audit = new PolicyAuditController({
            config: () => ({ enabled: true, retentionDays: 180 }),
            cwd: () => ctx.cwd, directory: ${JSON.stringify(directory)},
            warn: message => warnings.push(message),
          });
          try {
            audit.warmup();
            audit.record({
              requestId: 'compiled-request', surface: 'bash', value: 'git status /private/secret-path',
              result: 'allow', resolution: 'user_approved', origin: 'project',
            });
            const result = await audit.report({ days: 30, top: 20, minCount: 1, scope: 'current' });
            console.log(JSON.stringify({ ...result, warnings }));
          } catch (error) {
            console.error(error);
            process.exitCode = 1;
          } finally {
            await audit.close();
            ctx.shutdown();
          }
        });
      }
    `);
    const build = spawnSync("bun", ["build", "--compile", "--no-compile-autoload-bunfig", join(piDist, "bun/cli.js"), "--outfile", binary], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, ["-ne", "-e", extension, "--no-session", "-p"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_PACKAGE_DIR: dirname(piDist) },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.report.total, 1);
    assert.equal(result.report.version, 3);
    assert.doesNotMatch(run.stdout, /secret-path|compiled-request/);
    assert.match(result.markdown, /git status/);
    const store = await PolicyAuditStore.open({ directory, retentionDays: 180 });
    try {
      const saved = store.query({ days: 30, top: 20, minCount: 1, scope: "current", projectPath: root });
      assert.equal(saved.rows.reduce((sum, row) => sum + row.count, 0), 1);
    } finally { store.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
