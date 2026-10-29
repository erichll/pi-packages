import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPiSandbox } from "../src/index.ts";
import { NATIVE_CHILD_TOOLS, PI_SANDBOX_ACKNOWLEDGEMENT } from "../src/pi-subagents-native.ts";

// Own file: pi-subagents fixes its async runtime root when first loaded.

function protectedStatus(runId: string, sessionId: string) {
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

test("a saved session registers the ceiling by session id and file path, and steers by file-path ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-saved-session-"));
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
  const piSessionId = "saved-session-id";
  const sessionFile = join(root, "sessions", "2026-10-29_saved-session-id.jsonl");
  const ctx = {
    cwd: process.cwd(), hasUI: false,
    sessionManager: { getSessionId: () => piSessionId, getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
  const asyncRoot = join(process.env.PI_SUBAGENTS_TEMP_ROOT, "async-subagent-runs");
  const persist = (id: string, status: unknown) => {
    mkdirSync(join(asyncRoot, id), { recursive: true });
    writeFileSync(join(asyncRoot, id, "status.json"), JSON.stringify(status));
  };
  try {
    // Read back through the installed upstream public API, which background
    // launches use to derive the child's tool ceiling.
    const { resolveCurrentSubagentCapabilityCeiling } = await import("pi-subagents/capability-ceiling") as {
      resolveCurrentSubagentCapabilityCeiling(id: string | undefined): {
        allowedAgents?: string[]; allowedTools?: string[]; sources: string[];
      } | undefined;
    };
    const assertRestricted = (key: string) => {
      const ceiling = resolveCurrentSubagentCapabilityCeiling(key);
      assert.ok(ceiling, `ceiling must resolve for ${key}`);
      assert.deepEqual(ceiling.allowedTools, [...NATIVE_CHILD_TOOLS].sort());
      assert.deepEqual(ceiling.allowedAgents, ["worker"]);
      assert.deepEqual(ceiling.sources, [PI_SANDBOX_ACKNOWLEDGEMENT]);
    };
    await registerPiSandbox(pi, { subagentProvider: "pi-subagents", allowedNativeAgents: ["worker"] });
    await handlers.get("session_start")!({}, ctx);
    assertRestricted(piSessionId);
    assertRestricted(sessionFile);

    const call = (input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName: "subagent", input }, ctx);
    assert.equal(await call({ agent: "worker", task: "probe", async: true }), undefined);
    assertRestricted(piSessionId);
    assertRestricted(sessionFile);

    // pi-subagents records status.sessionId as the session file path.
    persist("file-owned-run", protectedStatus("file-owned-run", sessionFile));
    persist("id-owned-run", protectedStatus("id-owned-run", piSessionId));
    persist("unacknowledged-run", {
      ...protectedStatus("unacknowledged-run", sessionFile),
      steps: [{ agent: "worker", status: "running" }],
    });
    assert.equal(await call({ action: "steer", id: "file-owned-run", options: { steeringRecovery: false } }), undefined);
    const idOwned = await call({ action: "steer", id: "id-owned-run", options: { steeringRecovery: false } });
    assert.equal(idOwned.block, true);
    assert.match(idOwned.reason, /not owned by this session/);
    const unacknowledged = await call({ action: "steer", id: "unacknowledged-run", options: { steeringRecovery: false } });
    assert.equal(unacknowledged.block, true);
    assert.match(unacknowledged.reason, /runtime acknowledgement/);
    assertRestricted(piSessionId);
    assertRestricted(sessionFile);

    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(resolveCurrentSubagentCapabilityCeiling(piSessionId), undefined);
    assert.equal(resolveCurrentSubagentCapabilityCeiling(sessionFile), undefined);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.temp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous.temp;
    rmSync(root, { recursive: true, force: true });
  }
});
