import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import {
  findPiPackageRootFromEntry,
  hasSandboxAcknowledgement,
  isCompatiblePiSubagentsVersion,
  loadPiSubagentsNativeRuntime,
  nativeSubagentCallBlockReason,
  NATIVE_CHILD_TOOLS,
  PI_SANDBOX_ACKNOWLEDGEMENT,
  piSubagentsInternalModulePath,
  resolvePiSubagentsHostAliases,
  resolvePiSubagentsModuleExtension,
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

test("version gate accepts 0.66.0 and above and fails closed below it", () => {
  assert.equal(isCompatiblePiSubagentsVersion("0.66.0"), true);
  assert.equal(isCompatiblePiSubagentsVersion("0.66.1"), true);
  assert.equal(isCompatiblePiSubagentsVersion("0.66.2-beta.1"), true);
  assert.equal(isCompatiblePiSubagentsVersion("0.67.0"), true);
  assert.equal(isCompatiblePiSubagentsVersion("0.69.0"), true);
  assert.equal(isCompatiblePiSubagentsVersion("1.66.0"), false);
  assert.equal(isCompatiblePiSubagentsVersion("0.65.9"), false);
  assert.equal(isCompatiblePiSubagentsVersion("0.66"), false);
  assert.equal(isCompatiblePiSubagentsVersion("unknown"), false);
  assert.equal(isCompatiblePiSubagentsVersion(undefined), false);
  assert.equal(isCompatiblePiSubagentsVersion(42), false);
});

test("package layout resolution accepts the source and compiled module layouts", () => {
  assert.equal(
    resolvePiSubagentsModuleExtension({
      "./capability-ceiling": "./src/api/capability-ceiling.ts",
    }),
    ".ts",
  );
  assert.equal(
    resolvePiSubagentsModuleExtension({
      "./capability-ceiling": {
        types: "./src/api/capability-ceiling.d.ts",
        default: "./src/api/capability-ceiling.js",
      },
    }),
    ".js",
  );
  assert.equal(piSubagentsInternalModulePath("src/agents/agents", ".js"), "src/agents/agents.js");
  assert.equal(piSubagentsInternalModulePath("src/agents/agents.ts", ".ts"), "src/agents/agents.ts");
  for (const drift of [
    undefined,
    {},
    { "./capability-ceiling": 42 },
    { "./capability-ceiling": "./dist/api/capability-ceiling.js" },
    { "./capability-ceiling": "./src/api/ceiling.ts" },
    { "./capability-ceiling": { default: "./src/api/capability-ceiling.mjs" } },
  ]) {
    assert.throws(
      () => resolvePiSubagentsModuleExtension(drift as never),
      /capability-ceiling export changed/,
    );
  }
});

test("host alias resolution prefers the running Pi package and degrades without one", async () => {
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piRoot = await findPiPackageRootFromEntry(piEntry);
  assert.ok(piRoot, "the development @earendil-works/pi-coding-agent install must resolve");
  assert.equal(await findPiPackageRootFromEntry(tmpdir()), undefined);

  const aliases = await resolvePiSubagentsHostAliases({
    entry: piEntry,
    moduleUrl: "file:///nonexistent/pi-sandbox-module.ts",
    env: {},
  });
  const tui = aliases["@earendil-works/pi-tui"];
  assert.ok(tui, "pi-tui must be aliased from the running Pi package");
  assert.equal(
    tui,
    await realpath(createRequire(join(piRoot, "package.json")).resolve("@earendil-works/pi-tui")),
    "the alias must point at the pi-tui copy the host loader would use",
  );

  assert.deepEqual(
    await resolvePiSubagentsHostAliases({
      entry: tmpdir(),
      moduleUrl: "file:///nonexistent/pi-sandbox-module.ts",
      env: {},
    }),
    {},
    "an unresolvable host must leave resolution to jiti so the load error stays explicit",
  );
});

test("host aliases resolve pi-tui where the extension tree alone cannot", async () => {
  const aliases = await resolvePiSubagentsHostAliases({
    entry: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    moduleUrl: "file:///nonexistent/pi-sandbox-module.ts",
    env: {},
  });
  assert.ok(Object.keys(aliases).length > 0);

  // An isolated tree with no @earendil-works/pi-tui anywhere above it, like an
  // installed extension whose pi-tui peer was never hoisted next to it.
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-host-alias-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const consumer = join(root, "consumer.js");
    writeFileSync(consumer, [
      'import { Key } from "@earendil-works/pi-tui";',
      'export const hasKey = typeof Key !== "undefined";',
    ].join("\n"));
    const consumerUrl = pathToFileURL(consumer).href;
    const options = { interopDefault: false, fsCache: false } as const;
    await assert.rejects(
      createJiti(consumerUrl, options).import(consumerUrl),
      /@earendil-works\/pi-tui/,
    );
    const module = (await createJiti(consumerUrl, { ...options, alias: aliases }).import(
      consumerUrl,
    )) as { hasKey?: unknown };
    assert.equal(module.hasKey, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installed pi-subagents runtime validates native agents and registers the strong ceiling", async () => {
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
    assert.ok(registry, "capability ceiling registry must be registered on globalThis");
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
