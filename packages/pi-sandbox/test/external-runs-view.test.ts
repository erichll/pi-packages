import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createExternalRunsView } from "../src/external-runs-view.ts";
import { externalRunsViewEnabledWhen } from "../src/external-runs-view.ts";
import { createExternalWorkerSupervisor } from "../src/external-supervisor.ts";

// pi loads extensions via jiti (see node_modules/.../core/extensions/loader.js),
// so the extension's runtime `import("pi-subagents/external-runs")` succeeds in
// production. The standalone node --experimental-strip-types test harness has no
// jiti interceptor, so we load the real module through jiti here and inject it
// via createExternalRunsView's optional loader — mirroring production behavior.
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
import { fileURLToPath } from "node:url";
const realExternalRunsPath = fileURLToPath(
  import.meta.resolve("pi-subagents/external-runs"),
);
const jiti = createJiti(resolve(".") + "/", {
  fsCache: false,
  moduleCache: false,
  interopDefault: true,
  nativeModules: ["node:fs", "node:path", "node:url", "node:crypto", "node:net", "node:os"],
  tsconfig: {
    compilerOptions: { allowImportingTsExtensions: true, module: "esnext" },
  },
});
const realExternalRuns = await jiti.import(realExternalRunsPath);
const loadRealExternalRuns = async () => realExternalRuns;

function uniqueSession(): string {
  return `pkg-sandbox-view-${randomUUID()}`;
}

const allowedFields = new Set([
  "id",
  "sessionId",
  "source",
  "label",
  "state",
  "startedAt",
  "updatedAt",
  "endedAt",
  "currentAction",
  "preview",
  "reportPath",
  "transcriptPath",
]);

function rpcRequest(
  socketPath: string,
  value: Record<string, unknown>,
): Promise<{ action: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as { action: string });
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
  });
}

test("FleetView enablement is restricted to pi-subagents + enforce", () => {
  assert.equal(externalRunsViewEnabledWhen("off", "enforce"), false);
  assert.equal(externalRunsViewEnabledWhen("builtin", "enforce"), false);
  assert.equal(externalRunsViewEnabledWhen("pi-subagents", "off"), false);
  assert.equal(externalRunsViewEnabledWhen("pi-subagents", "enforce"), true);
  // Never enabled with isolation in any non-enforced or mismatched state.
  assert.equal(externalRunsViewEnabledWhen("other", "enforce"), false);
});

test("FleetView view registers a running record and clears it on close", async () => {  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  assert.equal(view.enabled, true);
  view.registered({ id: "w1", cwd: join(tmpdir(), "ws"), startedAt: Date.now() });
  const snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.id, "w1");
  assert.equal(snap[0]!.state, "running");
  assert.equal(snap[0]!.source, "pi-sandbox");
  assert.equal(snap[0]!.label, "isolated pi-subagents worker");
  assert.equal(snap[0]!.preview, join(tmpdir(), "ws"));
  view.close();
  assert.equal(realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true }).length, 0);
});

test("FleetView view avoids duplicate registration for the same worker id", async () => {
  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  view.registered({ id: "w1", cwd: join(tmpdir(), "a"), startedAt: Date.now() });
  view.registered({ id: "w1", cwd: join(tmpdir(), "b"), startedAt: Date.now() });
  const snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.equal(snap.length, 1);
  view.close();
});

test("FleetView view unregisters on worker unregister and clears all on close", async () => {
  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  view.registered({ id: "w1", cwd: join(tmpdir(), "a"), startedAt: Date.now() });
  view.registered({ id: "w2", cwd: join(tmpdir(), "b"), startedAt: Date.now() });
  view.unregistered("w1");
  let snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.deepEqual(snap.map((r: { id: string }) => r.id).sort(), ["w2"]);
  view.close();
  snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.equal(snap.length, 0);
});

test("FleetView view never unregisters runs it did not register", async () => {
  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  realExternalRuns.registerExternalRun({
    id: "other",
    sessionId,
    source: "someone-else",
    label: "other run",
    state: "running",
    startedAt: Date.now(),
  });
  view.unregistered("other");
  const snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.source, "someone-else");
  view.close();
});

test("FleetView view disables safely when the dynamic import fails", async () => {
  const view = await createExternalRunsView(uniqueSession(), async () => {
    throw new Error("simulated import failure");
  });
  assert.equal(view.enabled, false);
  assert.match(view.error ?? "", /simulated import failure/);
  view.registered({ id: "w1", cwd: join(tmpdir(), "a"), startedAt: Date.now() });
  view.unregistered("w1");
  view.close();
});

test("FleetView view swallows registry-full errors on register", async () => {
  const view = await createExternalRunsView(uniqueSession(), async () => ({
    registerExternalRun() {
      throw new Error("External-run registry supports at most 100 cached runs.");
    },
    unregisterExternalRun() {
      return true;
    },
  }));
  assert.equal(view.enabled, true);
  view.registered({ id: "w1", cwd: join(tmpdir(), "a"), startedAt: Date.now() });
  view.unregistered("w1");
  view.close();
});

test("FleetView snapshot carries only minimal display fields (no prompt/secret)", async () => {
  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  view.registered({
    id: "w1",
    cwd: join(tmpdir(), "ws"),
    startedAt: Date.now(),
  });
  const snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
  assert.equal(snap.length, 1);
  assert.ok(
    Object.keys(snap[0]!).every((k) => allowedFields.has(k)),
    "snapshot record must only contain pi-subagents display fields",
  );
  assert.equal(snap[0]!.preview, join(tmpdir(), "ws"));
  const serialized = JSON.stringify(snap[0]!).toLowerCase();
  assert.ok(!/prompt|secret|token|credential/.test(serialized), "no secrets or prompts in snapshot");
  view.close();
});

test("supervisor lifecycle callbacks feed the FleetView and honor unregister", async () => {
  const sessionId = uniqueSession();
  const view = await createExternalRunsView(sessionId, loadRealExternalRuns);
  const lifecycle: Array<"registered" | "unregistered"> = [];
  const supervisor = await createExternalWorkerSupervisor(
    () => ({
      command: "external worker",
      cwd: process.cwd(),
      sessionId: "parent",
      scopeKey: "parent:turn:1",
    }),
    {
      registered: (w) => {
        lifecycle.push("registered");
        view.registered(w);
      },
      unregistered: (w) => {
        lifecycle.push("unregistered");
        view.unregistered(w.id);
      },
    },
  );
  try {
    const registration = {
      version: 1,
      capability: supervisor.capability,
      id: "reg-1",
      type: "register",
      workerId: "wfleet",
      cwd: process.cwd(),
    };
    assert.equal((await rpcRequest(supervisor.socketPath, registration)).action, "allow");
    assert.deepEqual(lifecycle, ["registered"]);
    let snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.id, "wfleet");
    assert.equal(snap[0]!.source, "pi-sandbox");
    assert.equal(snap[0]!.preview, process.cwd());

    const unregister = { ...registration, id: "unreg-1", type: "unregister" };
    assert.equal((await rpcRequest(supervisor.socketPath, unregister)).action, "allow");
    assert.deepEqual(lifecycle, ["registered", "unregistered"]);
    snap = realExternalRuns.snapshotExternalRuns(sessionId, { ignoreMalformed: true });
    assert.equal(snap.length, 0);
  } finally {
    await supervisor.close();
    view.close();
  }
});

test("createExternalRunsView rejects an invalid session id without throwing", async () => {
  const view = await createExternalRunsView("  ", async () => {
    throw new Error("should not be reached");
  });
  assert.equal(view.enabled, false);
});