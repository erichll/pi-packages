import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import statusline from "../src/index.ts";
import { assistant, testTheme } from "./helpers.ts";

// Exercise registered public handlers, not a second copy of the state machine.
test("extension wiring spans agent_end/continuation, cancellation, UI/tools, compaction and replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  let footer: (Component & { dispose?(): void }) | undefined, settings = "", contextReads = 0;
  const notifications: string[] = [];
  const provider = { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {}, getGitBranch: () => null, getAvailableProviderCount: () => 1 };
  const tui = { requestRender() {}, terminal: { rows: 100 } } as unknown as TUI;
  const theme = testTheme() as Theme;
  const ctx = {
    mode: "tui", hasUI: true, cwd: dir, model: { id: "model", name: "Model", provider: "example", contextWindow: 200000 },
    sessionManager: { getSessionId: () => "session", getLeafId: () => null, getEntries: () => [] },
    getContextUsage: () => { contextReads++; return { tokens: 1000, percent: 0.5, contextWindow: 200000 }; },
    ui: {
      theme, notify(message: string) { notifications.push(message); },
      setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) { footer?.dispose?.(); footer = factory?.(tui, theme, provider); },
      async custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) { const panel = factory(tui, theme, {}, () => {}); settings = panel.render(200).map(stripTerminalSequences).join("\n"); },
    },
  } as unknown as ExtensionContext;
  const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  const row = () => footer!.render(200).map(stripTerminalSequences).join("\n");
  statusline({ get events() { throw new Error("No provider-specific event bus should be required"); }, get getSettings() { throw new Error("Footer statistics must not need compaction settings"); }, on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; } } as unknown as ExtensionAPI);
  try {
    await fire("session_start"); assert.match(row(), /Compactions 0/); assert.doesNotMatch(row(), /Idle|Until compact/);
    await command("details", ctx); assert.equal(settings, "");
    assert.equal(notifications.at(-1), "Usage: /statusline [on|off|reload]");
    await command("", ctx); assert.match(settings, /Statusline settings/);
    assert.doesNotMatch(settings, /Current \/ last run details|Statusline details/);
    await fire("agent_start"); await fire("turn_start"); const first = assistant();
    await fire("message_start", { message: first });
    await fire("message_update", { message: first, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: first } });
    await fire("message_end", { message: first }); await fire("turn_end", { message: first });
    await fire("agent_end"); assert.match(row(), /Elapsed.*Turns 1/);
    await fire("agent_start"); await fire("turn_start");
    await fire("tool_execution_start", { toolCallId: "parent", toolName: "bash" });
    await fire("tool_execution_start", { toolCallId: "child", toolName: "read" }); assert.match(row(), /Tools 2 active/);
    await fire("tool_execution_end", { toolCallId: "parent" }); await fire("tool_execution_end", { toolCallId: "child" });
    await fire("ui_prompt_start"); assert.match(row(), /Awaiting input/); await fire("ui_prompt_end");
    await fire("agent_before_settle", { outcome: "completed" }); await fire("agent_settled");
    assert.match(row(), /Turns 2/); assert.doesNotMatch(row(), /Tools 2 active|Awaiting input|No content/);
    assert.doesNotMatch(row(), /Running|Done/); assert.match(row(), /Elapsed/);
    await fire("agent_start"); await fire("turn_start");
    await fire("message_end", { message: { ...assistant(2), stopReason: "aborted" } });
    await fire("agent_end"); await fire("agent_settled"); // Pi skips before-settle on abort
    assert.match(row(), /Turns 1/); assert.doesNotMatch(row(), /Awaiting input|No content/);
    await fire("session_before_compact"); assert.match(row(), /Compacting/);
    await fire("session_compact_failed", { aborted: true }); assert.match(row(), /Compaction cancelled/);
    await fire("session_before_compact"); await fire("session_compact", { compactionEntry: { id: "compact" } });
    assert.doesNotMatch(row(), /Compacting|Compaction cancelled/);
    await command("off", ctx); assert.equal(footer, undefined);
    const reads = contextReads; await fire("message_update", { message: assistant(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: assistant() } });
    await delay(120); assert.equal(contextReads, reads);
    await command("on", ctx); assert.ok(footer);
    await command("reload", ctx); assert.doesNotMatch(row(), /Elapsed|Idle/);
    await fire("session_start"); assert.doesNotMatch(row(), /Elapsed|Idle/);
    await fire("session_shutdown");
  } finally {
    await fire("session_shutdown"); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
