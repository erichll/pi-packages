import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionRuntime,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensions,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerPiSandbox } from "../src/index.ts";

function activeTools(extensions: Extension[]): ToolInfo[] {
  const tools = new Map<string, ToolInfo>();
  for (const extension of extensions) {
    for (const registered of extension.tools.values()) {
      if (!tools.has(registered.definition.name)) {
        tools.set(registered.definition.name, {
          name: registered.definition.name,
          description: registered.definition.description,
          parameters: registered.definition.parameters,
          promptGuidelines: registered.definition.promptGuidelines,
          sourceInfo: registered.sourceInfo,
        });
      }
    }
  }
  return [...tools.values()];
}

async function loadLocal(
  runtime: ExtensionRuntime,
  eventBus: ReturnType<typeof createEventBus>,
): Promise<Extension> {
  return loadExtensionFromFactory(
    (pi: ExtensionAPI) =>
      registerPiSandbox(pi, {
        subagentProvider: "pi-subagents",
        allowedNativeAgents: ["worker"],
      }),
    process.cwd(),
    eventBus,
    runtime,
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  );
}

async function loadExternal(
  extensionPath: string,
  runtime: ExtensionRuntime,
  eventBus: ReturnType<typeof createEventBus>,
): Promise<Extension> {
  const result = await loadExtensions(
    [extensionPath],
    process.cwd(),
    eventBus,
    runtime,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  return result.extensions[0]!;
}

const piSubagentsPath = fileURLToPath(import.meta.resolve("pi-subagents"));
const piSubagentsPackage = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../../node_modules/pi-subagents/package.json", import.meta.url), "utf8"),
  ),
) as { version?: unknown };

test(
  "real pi-subagents owns subagent in either extension load order",
  async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-smoke-agent-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const configPath = join(agentDir, "extensions", "subagent", "config.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ scheduledRuns: { enabled: false } }));
      // Compatibility floor: the external provider must be new enough to
      // deliver the 0.45.x async completion surface exercised by the release
      // gate. Assert a >= 0.45.0 version instead of pinning an exact build so
      // the smoke test keeps passing across patch bumps within the target line.
      const version = String(piSubagentsPackage.version ?? "0.0.0");
      const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
      assert.ok(
        Number.isInteger(major) && major >= 0 && Number.isInteger(minor) && (major > 0 || minor >= 45),
        `expected pi-subagents >= 0.45.0, got ${version}`,
      );
      for (const order of [
        ["pi-sandbox", "pi-subagents"],
        ["pi-subagents", "pi-sandbox"],
      ] as const) {
        const eventBus = createEventBus();
        const runtime = createExtensionRuntime();
        let local: Extension;
        let external: Extension;
        if (order[0] === "pi-sandbox") {
          local = await loadLocal(runtime, eventBus);
          external = await loadExternal(piSubagentsPath, runtime, eventBus);
        } else {
          external = await loadExternal(piSubagentsPath, runtime, eventBus);
          local = await loadLocal(runtime, eventBus);
        }
        const extensions =
          order[0] === "pi-sandbox" ? [local, external] : [external, local];
        const tools = activeTools(extensions);
        runtime.getAllTools = () => tools;
        runtime.getActiveTools = () => tools.map((tool) => tool.name);

        const subagentTools = tools.filter((tool) => tool.name === "subagent");
        assert.equal(subagentTools.length, 1);
        assert.match(
          subagentTools[0]!.sourceInfo.path,
          /(?:^|[/\\])pi-subagents(?:[/\\]|$)/,
        );
        const bashTool = tools.find((tool) => tool.name === "bash");
        assert.ok(bashTool);
        assert.match(
          bashTool.sourceInfo.path,
          /(?:^|[/\\])pi-sandbox(?:[/\\]|$)/,
        );
        assert.equal(local.tools.has("subagent"), false);

        const notifications: Array<{ message: string; level: string }> = [];
        const context = {
          cwd: process.cwd(),
          hasUI: true,
          sessionManager: { getSessionId: () => `coexistence-${order.join("-")}` },
          ui: {
            notify(message: string, level: string) {
              notifications.push({ message, level });
            },
          },
        } as unknown as ExtensionContext;
        for (const handler of local.handlers.get("session_start") ?? []) {
          await handler({ type: "session_start" }, context);
        }
        assert.ok(
          notifications.some(
            ({ message, level }) =>
              level === "info" &&
              message.includes("pi-subagents protected native-background mode active") &&
              message.includes(
                "tool boundary, not outer worker process isolation",
              ),
          ),
        );

        for (const extension of extensions) {
          for (const handler of extension.handlers.get("session_shutdown") ??
            []) {
            await handler({ type: "session_shutdown" }, context);
          }
        }
        eventBus.clear();
      }
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
);
