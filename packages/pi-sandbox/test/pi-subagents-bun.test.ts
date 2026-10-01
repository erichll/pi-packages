import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hasBun = spawnSync("bun", ["--version"], { timeout: 5_000 }).status === 0;

test("Pi supplies missing host peers to the protected loader on Node, Bun, and compiled Bun", {
  skip: hasBun ? false : "Bun compiler unavailable",
  timeout: 90_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-host-modules-"));
  const modules = join(root, "node_modules");
  const peerRoot = dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
  const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const agentDir = join(root, "agent");
  const configPath = join(agentDir, "extensions/subagent/config.json");
  const probe = join(root, "probe.ts");
  const resultPath = join(root, "probe-result.json");
  const binary = join(root, "pi");
  try {
    mkdirSync(modules);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(
      fileURLToPath(new URL("../src/pi-subagents-native.ts", import.meta.url)),
      join(root, "pi-subagents-native.ts"),
    );
    // Copy, rather than symlink, pi-subagents so its imports cannot see the
    // checkout's hoisted host peers. Only install its regular dependencies.
    cpSync(peerRoot, join(modules, "pi-subagents"), {
      recursive: true,
      filter: (source) => source === peerRoot || !source.slice(peerRoot.length).split(/[/\\]/).includes("node_modules"),
    });
    const dependencies = JSON.parse(readFileSync(join(peerRoot, "package.json"), "utf8")).dependencies;
    const require = createRequire(import.meta.url);
    for (const name of Object.keys(dependencies)) {
      const manifest = require.resolve(`${name}/package.json`);
      symlinkSync(dirname(manifest), join(modules, name), "dir");
    }
    const consumerRequire = createRequire(join(modules, "pi-subagents", "package.json"));
    for (const peer of ["@earendil-works/pi-tui", "typebox"]) {
      assert.throws(() => consumerRequire.resolve(peer), /Cannot find module/);
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ scheduledRuns: { enabled: false } }));
    writeFileSync(probe, `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import {
        loadPiSubagentsNativeRuntime, nativeSubagentCallBlockReason, NATIVE_CHILD_TOOLS,
      } from './pi-subagents-native.ts';
      import { resolveCurrentSubagentCapabilityCeiling } from 'pi-subagents/capability-ceiling';
      export default function(pi) {
        pi.on('session_start', async (_event, ctx) => {
          try {
            const runtime = await loadPiSubagentsNativeRuntime(['worker', 'reviewer', 'scout']);
            if (process.env.PI_TUI_TEST_DENY_SCHEDULES === '1') {
              assert.throws(() => runtime.validateAllowedAgents(ctx.cwd), /scheduledRuns.enabled=false/);
              writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ schedulesRejected: true }));
              return;
            }
            const allowed = runtime.validateAllowedAgents(ctx.cwd);
            assert.deepEqual(allowed, ['worker', 'reviewer', 'scout']);
            const handle = runtime.registerCeiling('host-module-test', allowed);
            // Read through the host-loaded public API to verify that the inner
            // loader's registration reaches the upstream registry.
            const ceiling = resolveCurrentSubagentCapabilityCeiling('host-module-test');
            assert.deepEqual(ceiling.allowedTools, [...NATIVE_CHILD_TOOLS].sort());
            assert.deepEqual(ceiling.allowedAgents, [...allowed].sort());
            handle.dispose();
            assert.equal(resolveCurrentSubagentCapabilityCeiling('host-module-test'), undefined);
            assert.match(nativeSubagentCallBlockReason({ agent: 'worker', task: 'x' }), /async: true/);
            assert.match(nativeSubagentCallBlockReason({ workflowScript: 'return 1', async: true }), /ambient extensions/);
            const unknown = await loadPiSubagentsNativeRuntime(['missing-agent-for-test']);
            assert.throws(() => unknown.validateAllowedAgents(ctx.cwd), /cannot resolve/);
            writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ allowed, tools: ceiling.allowedTools }));
          } catch (error) {
            console.error(error);
            process.exitCode = 1;
          } finally { ctx.shutdown(); }
        });
      }
    `);
    const build = spawnSync("bun", ["build", "--compile", "--no-compile-autoload-bunfig", join(piDist, "bun/cli.js"), "--outfile", binary], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr);
    const cases = [
      { name: "Node Pi", command: process.execPath, args: [join(piDist, "bundle/cli.js")] },
      { name: "plain Bun Pi", command: "bun", args: [join(piDist, "bun/cli.js")] },
      { name: "compiled Bun Pi", command: binary, args: [] },
    ];
    for (const runtime of cases) {
      await t.test(runtime.name, () => {
        rmSync(resultPath, { force: true });
        const run = spawnSync(runtime.command, [...runtime.args, "-ne", "-e", probe, "--no-session", "-p"], {
          cwd: root,
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: dirname(piDist) },
          encoding: "utf8", timeout: 20_000,
        });
        assert.equal(run.status, 0, run.stderr);
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        assert.deepEqual(result.allowed, ["worker", "reviewer", "scout"]);
        assert.deepEqual(result.tools, ["bash", "find", "grep", "ls", "read"]);
      });
    }
    await t.test("compiled Bun still rejects enabled schedules", () => {
      rmSync(resultPath, { force: true });
      writeFileSync(configPath, JSON.stringify({ scheduledRuns: { enabled: true } }));
      const run = spawnSync(binary, ["-ne", "-e", probe, "--no-session", "-p"], {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: dirname(piDist), PI_TUI_TEST_DENY_SCHEDULES: "1" },
        encoding: "utf8", timeout: 20_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), { schedulesRejected: true });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
