import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  hasSandboxAcknowledgement,
  loadPiSubagentsNativeRuntime,
  nativeSubagentCallBlockReason,
  NATIVE_CHILD_TOOLS,
  PI_SANDBOX_ACKNOWLEDGEMENT,
  terminalChildrenHaveSandboxAcknowledgement,
} from "../src/pi-subagents-native.ts";

function upstreamConfig(root: string, enabled: boolean): void {
  const path = join(root, "extensions", "subagent", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scheduledRuns: { enabled } }));
}

test("protected call guard admits only explicit async direct launches", () => {
  assert.equal(nativeSubagentCallBlockReason({ agent: "worker", task: "x", async: true }), undefined);
  assert.match(nativeSubagentCallBlockReason({ workflowScript: "return 1", async: true }) ?? "", /disabled because.*ambient extensions/);
  assert.match(nativeSubagentCallBlockReason({ workflowScriptPath: "flow.js", async: true }) ?? "", /disabled because.*ambient extensions/);
  assert.match(nativeSubagentCallBlockReason({ agent: "worker" }) ?? "", /async: true/);
  assert.match(nativeSubagentCallBlockReason({ agent: "worker", async: false }) ?? "", /async: true/);
  assert.match(nativeSubagentCallBlockReason({ workflow: "owned", async: true }) ?? "", /named workflows/);
  assert.match(nativeSubagentCallBlockReason({ chain: [], async: true }) ?? "", /supports only/);
  for (const action of ["schedule.list", "schedule.run", "create", "update", "delete", "eject", "enable", "disable", "reset", "refine", "resume"]) {
    assert.ok(nativeSubagentCallBlockReason({ action }), action);
  }
  for (const action of ["list", "get", "status", "debug.run", "stop", "interrupt", "steer", "dismiss", "validate"]) {
    assert.equal(nativeSubagentCallBlockReason({ action }), undefined, action);
  }
});

test("acknowledgement proof is found in nested child results", () => {
  assert.equal(hasSandboxAcknowledgement({ results: [{ state: "completed" }] }), false);
  assert.equal(hasSandboxAcknowledgement({ results: [{
    runtimeAcknowledgedExtensions: {
      version: 1,
      source: "child-runtime",
      ids: [PI_SANDBOX_ACKNOWLEDGEMENT],
    },
  }] }), true);
  assert.equal(terminalChildrenHaveSandboxAcknowledgement({ results: [{ agent: "worker", state: "running" }] }), true);
  assert.equal(terminalChildrenHaveSandboxAcknowledgement({ results: [{ agent: "worker", state: "completed" }] }), false);
  assert.equal(terminalChildrenHaveSandboxAcknowledgement({ results: [{
    agent: "worker",
    state: "completed",
    runtimeAcknowledgedExtensions: { ids: [PI_SANDBOX_ACKNOWLEDGEMENT] },
  }] }), true);
});

test("0.65 runtime validates native agents and registers the strong ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-native-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    upstreamConfig(root, false);
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "ambient-off.md"), [
      "---", "name: ambient-off", "description: ambient disabled", "extensions:", "---", "test",
    ].join("\n"));
    writeFileSync(join(agentsDir, "nested.md"), [
      "---", "name: nested", "description: nested", "allowNestedSubagents: true", "---", "test",
    ].join("\n"));
    const runtime = await loadPiSubagentsNativeRuntime(["worker", "reviewer", "scout"]);
    assert.deepEqual(runtime.validateAllowedAgents(process.cwd()), ["worker", "reviewer", "scout"]);
    const handle = runtime.registerCeiling("native-test-session", ["worker"]);
    const key = Symbol.for("pi-subagents.capability-ceiling.v1");
    const registry = (globalThis as unknown as Record<symbol, Map<string, Map<symbol, { ceiling: { allowedAgents: string[]; allowedTools: string[] } }>>>)[key];
    const registration = [...registry.get("native-test-session")!.values()][0]!;
    assert.deepEqual(registration.ceiling.allowedAgents, ["worker"]);
    assert.deepEqual(registration.ceiling.allowedTools, [...NATIVE_CHILD_TOOLS].sort());
    handle.dispose();
    assert.equal(registry.has("native-test-session"), false);

    await assert.rejects(
      loadPiSubagentsNativeRuntime(["developer"]).then((candidate) => candidate.validateAllowedAgents(process.cwd())),
      /requires canonical agent names.*developer.*worker/,
    );
    await assert.rejects(
      loadPiSubagentsNativeRuntime(["codex-exec"]).then((candidate) => candidate.validateAllowedAgents(process.cwd())),
      /rejects runner 'external-cli'/,
    );
    await assert.rejects(
      loadPiSubagentsNativeRuntime(["ambient-off"]).then((candidate) => candidate.validateAllowedAgents(process.cwd())),
      /requires ambient extensions/,
    );
    await assert.rejects(
      loadPiSubagentsNativeRuntime(["nested"]).then((candidate) => candidate.validateAllowedAgents(process.cwd())),
      /rejects allowNestedSubagents/,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected runtime fails closed unless scheduled runs are disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-native-schedule-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    upstreamConfig(root, true);
    const runtime = await loadPiSubagentsNativeRuntime(["worker"]);
    assert.throws(() => runtime.validateAllowedAgents(process.cwd()), /scheduledRuns\.enabled=false/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
