import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isStandaloneExecutable,
  resolveBrokerExecPath,
  runtimeFilesystemPaths,
  type RuntimeProcess,
} from "../src/runtime.ts";
import { resolvePiInvocation } from "../src/subagent.ts";

function compiledHost(execPath: string, entry = "/$bunfs/root/pi"): RuntimeProcess {
  return { execPath, argv: ["bun", entry], versions: { bun: "1.3.14" } };
}

test("compiled Pi launches directly while Node and plain Bun retain their CLI entry", () => {
  for (const entry of ["/$bunfs/root/pi", "/~BUN/root/pi", "file:///%7EBUN/root/pi"]) {
    const host = compiledHost("/tmp/pi", entry);
    assert.equal(isStandaloneExecutable(host), true);
    assert.deepEqual(resolvePiInvocation(host), { command: "/tmp/pi", args: [] });
  }
  for (const versions of [{}, { bun: "1.3.14" }]) {
    const host = { execPath: process.execPath, argv: ["runtime", "/pi/dist/cli.js"], versions };
    assert.equal(isStandaloneExecutable(host), false);
    assert.equal(resolveBrokerExecPath({ PATH: "" }, host), process.execPath);
    assert.deepEqual(resolvePiInvocation(host), { command: process.execPath, args: ["/pi/dist/cli.js"] });
  }
  const sea = { execPath: "/tmp/pi", argv: ["/tmp/pi"], versions: {}, features: { sea: true } };
  assert.deepEqual(resolvePiInvocation(sea), { command: "/tmp/pi", args: [] });
});

test("compiled hosts resolve Node through PATH without re-executing themselves", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-runtime-"));
  try {
    const pi = join(root, "pi");
    writeFileSync(pi, "must never execute", { mode: 0o755 });
    const host = compiledHost(pi);
    const alias = join(root, "alias");
    const hardlink = join(root, "hardlink");
    const node = join(root, "node-bin");
    for (const dir of [alias, hardlink, node]) mkdirSync(dir);
    symlinkSync(pi, join(alias, "node"));
    linkSync(pi, join(hardlink, "node"));
    symlinkSync(process.execPath, join(node, "node"));

    const unsafePath = ["", ".", "relative-bin", alias, hardlink].join(delimiter);
    assert.throws(() => resolveBrokerExecPath({ PATH: unsafePath }, host), /standalone Pi requires Node.js/);
    const env = { PATH: [unsafePath, node].join(delimiter) };
    assert.equal(resolveBrokerExecPath(env, host), realpathSync(process.execPath));

    const paths = runtimeFilesystemPaths(env, host);
    assert.ok(paths.allowRead.includes(pi));
    assert.ok(paths.denyWrite.includes(pi));
    assert.ok(!paths.allowRead.includes(dirname(root)));
    assert.ok(!paths.allowRead.includes("/"));
    assert.ok(!paths.denyWrite.includes(root));
    assert.ok(!paths.denyWrite.includes(dirname(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime policy does not infer broad permissions from arbitrarily placed executables", () => {
  for (const execPath of ["/tmp/node", "/node"]) {
    const host = { execPath, argv: [execPath, "/pi/cli.js"], versions: {} };
    assert.deepEqual(runtimeFilesystemPaths({}, host), { allowRead: [execPath], denyWrite: [execPath] });
  }
});

test("Node subagents reuse the CLI behind the host's pi symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-cli-"));
  try {
    const cli = join(root, "cli.js");
    const executable = join(root, "pi");
    writeFileSync(cli, "");
    symlinkSync(cli, executable);
    const host = { execPath: process.execPath, argv: [process.execPath, executable], versions: {} };
    assert.deepEqual(resolvePiInvocation(host), { command: process.execPath, args: [realpathSync(cli)] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
test("a real Bun compiled host forks one Node broker and exchanges IPC", {
  skip: bun.status !== 0 ? "Bun compiler unavailable" : false,
  timeout: 60_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-compiled-"));
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/srt-broker-probe.mjs", import.meta.url));
  const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const entry = join(root, "probe.ts");
  const binary = join(root, "pi");
  try {
    writeFileSync(entry, `
      import { existsSync, mkdirSync } from 'node:fs';
      import { runSandboxedCommand } from ${JSON.stringify(join(source, "runner.ts"))};
      import { resolvePiInvocation } from ${JSON.stringify(join(source, "subagent.ts"))};
      export default function(pi) {
      pi.on('session_start', async (_event, ctx) => {
      let output = '';
      const result = await runSandboxedCommand({
        cwd: process.cwd(), command: 'probe',
        broker: { modulePath: process.env.BROKER },
        onData(data) { output += data.toString(); },
        async review() { return 'deny'; },
      });
      const temporary = process.cwd() + '/failed-command-tmp';
      mkdirSync(temporary);
      let failure;
      try {
        await runSandboxedCommand({
          cwd: process.cwd(), command: 'printf should-not-run',
          env: { ...process.env, PATH: '' },
          createTempDir() { return temporary; },
          onData() { throw new Error('unexpected child output'); },
          async review() { return 'deny'; },
        });
      } catch (error) { failure = error.message; }
      console.log(JSON.stringify({ result, broker: JSON.parse(output), invocation: resolvePiInvocation(), pid: process.pid, failure, temporaryExists: existsSync(temporary) }));
      ctx.shutdown();
      });
      }
    `);
    const build = spawnSync("bun", ["build", "--compile", "--no-compile-autoload-bunfig", join(piDist, "bun/cli.js"), "--outfile", binary], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, ["-ne", "-e", entry, "--no-session", "-p"], {
      cwd: root, env: {
        ...process.env, BROKER: fixture,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_PACKAGE_DIR: dirname(piDist),
      },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const value = JSON.parse(run.stdout);
    assert.equal(value.result.exitCode, 0);
    assert.equal(value.broker.execPath, realpathSync(process.execPath));
    assert.equal(value.broker.ppid, value.pid);
    assert.notEqual(value.broker.pid, value.pid);
    assert.deepEqual(value.broker.argv.slice(1), [fixture]);
    assert.deepEqual(value.invocation, { command: binary, args: [] });
    assert.ok(value.broker.allowRead.includes(binary));
    assert.ok(!value.broker.allowRead.includes("/"));
    assert.match(value.failure, /standalone Pi requires Node.js.*no usable node executable/);
    assert.equal(value.temporaryExists, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
