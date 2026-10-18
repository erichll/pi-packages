import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPiSandbox } from "../src/index.ts";
import {
  loadPiSubagentsNativeRuntime,
  nativeSteeringStatusBlockReason,
  nativeSubagentCallBlockReason,
  NATIVE_CHILD_TOOLS,
  PI_SANDBOX_ACKNOWLEDGEMENT,
} from "../src/pi-subagents-native.ts";

function protectedStatus(runId = "protected-run", sessionId = "old-session") {
  return {
    runId, sessionId, mode: "single", state: "running",
    capabilityCeiling: {
      version: 1, denyExtensions: false,
      allowedTools: [...NATIVE_CHILD_TOOLS], allowedAgents: ["worker"],
      sources: [PI_SANDBOX_ACKNOWLEDGEMENT],
    },
    steps: [{
      agent: "worker", status: "running",
      runtimeAcknowledgedExtensions: {
        version: 1, source: "child-runtime", ids: [PI_SANDBOX_ACKNOWLEDGEMENT], omitted: 0,
      },
    }],
  };
}

test("protected management is allowlisted and steering cannot recover a child", () => {
  const steer = { action: "steer", id: "protected-run", options: { steeringRecovery: false } };
  assert.equal(nativeSubagentCallBlockReason(steer), undefined);
  assert.equal(nativeSubagentCallBlockReason({ action: "steer", runId: "protected-run", steeringRecovery: false }), undefined);
  for (const input of [
    { action: "append-step" }, { action: "unknown.future.action" }, { action: "command.yield" },
    { action: 1, agent: "worker", async: true },
    { action: "steer", id: "protected-run" },
    { ...steer, steeringRecovery: true },
    { ...steer, steeringRecovery: false, options: { steeringRecovery: true } },
    { ...steer, options: [] }, { ...steer, options: null },
    { ...steer, options: { dir: "/tmp/elsewhere", steeringRecovery: false } },
    { ...steer, id: "../escape" }, { ...steer, id: "." },
    { ...steer, id: "" }, { ...steer, id: undefined },
    { ...steer, runId: "different-run" },
    { ...steer, options: { index: 1, steeringRecovery: false } },
  ]) assert.ok(nativeSubagentCallBlockReason(input), JSON.stringify(input));
});

test("a run's ownership, ceiling and own acknowledgement are separate requirements", () => {
  const valid = protectedStatus();
  const check = (value: unknown, agents = ["worker"]) =>
    nativeSteeringStatusBlockReason(value, "protected-run", agents, (id) => id === "old-session");
  assert.equal(check(valid), undefined);
  for (const invalid of [
    null, {}, { ...valid, runId: "wrong" }, { ...valid, sessionId: "foreign" },
    { ...valid, mode: "workflow" }, { ...valid, state: "completed" },
    { ...valid, steps: [] }, { ...valid, steps: [valid.steps[0], valid.steps[0]] },
    { ...valid, steps: [{ ...valid.steps[0], status: "pending" }] },
    { ...valid, steps: [{ ...valid.steps[0], agent: "external-cli" }] },
    { ...valid, steps: [{ agent: "worker", status: "running" }],
      runtimeAcknowledgedExtensions: valid.steps[0]!.runtimeAcknowledgedExtensions },
    { ...valid, steps: [{ agent: "worker", status: "running", output: PI_SANDBOX_ACKNOWLEDGEMENT }] },
    ...[
      { sources: [] }, { allowedTools: ["bash", "write"] }, { allowedAgents: [] },
      { denyExtensions: true }, { version: 2 },
    ].map((change) => ({ ...valid, capabilityCeiling: { ...valid.capabilityCeiling, ...change } })),
  ]) assert.ok(check(invalid), JSON.stringify(invalid));
  assert.ok(check(valid, ["reviewer"]), "new session's agent whitelist still applies");
});

test("real in-process succession permits protected steering only; host files and hook fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-succession-"));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, temp: process.env.PI_SUBAGENTS_TEMP_ROOT };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, "runtime");
  const config = join(process.env.PI_CODING_AGENT_DIR, "extensions", "subagent", "config.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ scheduledRuns: { enabled: false } }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const pi = {
    registerTool() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any) { handlers.set(event, handler); },
    getActiveTools: () => ["subagent", "bash"],
    getAllTools: () => [{ name: "subagent", sourceInfo: { source: "npm:pi-subagents", path: "/trusted/pi-subagents/index.js" } }],
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), hasUI: false,
    sessionManager: { getSessionId: () => "successor-session" },
  } as unknown as ExtensionContext;
  const asyncRoot = join(process.env.PI_SUBAGENTS_TEMP_ROOT, "async-subagent-runs");
  const persist = (id: string, status: unknown) => {
    mkdirSync(join(asyncRoot, id), { recursive: true });
    writeFileSync(join(asyncRoot, id, "status.json"), JSON.stringify(status));
  };
  try {
    const packageRoot = dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
    const succession = await import(pathToFileURL(join(packageRoot, "src/shared/session-succession.js")).href);
    succession.recordSessionReplacement("successor-session", "old-session");
    const runtime = await loadPiSubagentsNativeRuntime(["worker"]);
    const valid = protectedStatus();
    persist("protected-run", valid);
    assert.equal(await runtime.steeringTargetBlockReason("successor-session", "protected-run", ["worker"]), undefined);
    assert.ok(await runtime.steeringTargetBlockReason("unrelated-session", "protected-run", ["worker"]));
    assert.ok(await runtime.steeringTargetBlockReason("successor-session", "protected", ["worker"]), "prefixes cannot retarget another run");
    assert.ok(await runtime.steeringTargetBlockReason("successor-session", "../protected-run", ["worker"]));
    persist("unprotected-run", { ...valid, runId: "unprotected-run", capabilityCeiling: undefined });
    assert.ok(await runtime.steeringTargetBlockReason("successor-session", "unprotected-run", ["worker"]));

    if (process.platform !== "win32") {
      symlinkSync(join(asyncRoot, "protected-run"), join(asyncRoot, "linked-run"), "dir");
      assert.ok(await runtime.steeringTargetBlockReason("successor-session", "linked-run", ["worker"]));
      mkdirSync(join(asyncRoot, "linked-status"));
      symlinkSync(join(asyncRoot, "protected-run", "status.json"), join(asyncRoot, "linked-status", "status.json"));
      assert.ok(await runtime.steeringTargetBlockReason("successor-session", "linked-status", ["worker"]));
    }
    persist("corrupt-run", {});
    writeFileSync(join(asyncRoot, "corrupt-run", "status.json"), "not-json");
    assert.ok(await runtime.steeringTargetBlockReason("successor-session", "corrupt-run", ["worker"]));

    await registerPiSandbox(pi, { subagentProvider: "pi-subagents", allowedNativeAgents: ["worker"] });
    await handlers.get("session_start")!({}, ctx);
    const call = (input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName: "subagent", input }, ctx);
    assert.equal(await call({ action: "steer", id: "protected-run", options: { steeringRecovery: false } }), undefined);
    assert.equal((await call({ action: "steer", id: "unprotected-run", options: { steeringRecovery: false } })).block, true);
    assert.equal((await call({ action: "steer", id: "protected-run" })).block, true);
    assert.equal((await call({ action: "append-step", id: "protected-run" })).block, true);
    assert.equal(await call({ action: "status", id: "unprotected-run" }), undefined);
    assert.equal(await call({ action: "stop", id: "unprotected-run" }), undefined);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.temp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous.temp;
    rmSync(root, { recursive: true, force: true });
  }
});
