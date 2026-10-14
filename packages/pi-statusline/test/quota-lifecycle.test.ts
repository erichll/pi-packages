import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import statusline from "../src/index.ts";
import { testTheme } from "./helpers.ts";

test("native response hooks drive Usage, idle countdown, invalidation and old-config migration without auth access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-statusline-quota-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const configDir = join(directory, "extensions", "pi-statusline");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ segments: [{ id: "model" }, { id: "context" }, { id: "directory" }] }));
  const now = 2000000000000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  let footer: (Component & { dispose?(): void }) | undefined;
  let renders = 0;
  const notifications: string[] = [];
  const theme = testTheme() as Theme;
  const provider = { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {}, getGitBranch: () => null, getAvailableProviderCount: () => 1 };
  const ctx = {
    mode: "tui", cwd: directory, model: { provider: "cliproxyapi", id: "test", name: "Test", api: "cliproxyapi-codex-responses", baseUrl: "http://localhost:8317", contextWindow: 200000 },
    get modelRegistry() { throw new Error("Quota must not look up credentials"); },
    sessionManager: { getSessionId: () => "session", getLeafId: () => null, getEntries: () => [] },
    getContextUsage: () => ({ tokens: 9200, contextWindow: 200000, percent: 4.6 }),
    ui: { theme, notify(message: string) { notifications.push(message); }, setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
      footer?.dispose?.(); footer = factory?.({ requestRender() { renders++; } } as TUI, theme, provider);
    } },
  } as unknown as ExtensionContext;
  statusline({ on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; } } as unknown as ExtensionAPI);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  const row = () => footer!.render(300).map(stripTerminalSequences).join("\n");
  const quotaHeaders = {
    "x-codex-primary-used-percent": "40", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(now / 1000 + 10980),
    "x-codex-secondary-used-percent": "21", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(now / 1000 + 4 * 86400 + 9 * 3600),
    Authorization: "never-store-this", "x-ratelimit-remaining-tokens": "42",
  };
  const response = async (headers: Record<string, string> = quotaHeaders) => {
    await fire("before_provider_request", { payload: {} });
    await fire("after_provider_response", { status: 200, headers });
    t.mock.timers.tick(0);
  };
  try {
    await fire("session_start"); assert.doesNotMatch(row(), /40%|21%|42%|27%/);
    await command("quota", ctx);
    assert.equal(notifications.at(-1), "Usage: /statusline [on|off|reload]", "diagnostic command has been removed");
    await response();
    assert.match(row(), /4\.6%  󰦖 ████░░░░░░ 40%\[3h3m\].*21%\[4d9h\]/);
    assert.doesNotMatch(row(), /Usage |resets in|never-store-this|42/);
    const before = renders;
    t.mock.timers.tick(60000);
    assert.ok(renders > before, "idle countdown requests a render without a new inference");
    assert.match(row(), /\[3h2m\]/);
    await response({}); assert.doesNotMatch(row(), /40%|21%/);
    await response();
    ctx.model = { ...ctx.model!, id: "other" }; await fire("model_select"); assert.doesNotMatch(row(), /40%|21%/);
    await fire("after_provider_response", { status: 200, headers: quotaHeaders }); assert.doesNotMatch(row(), /40%|21%/, "late callback is ignored");
    await response(); assert.match(row(), /40%/);
    await fire("provider_stream_event", { provider: "cliproxyapi", api: ctx.model!.api, model: "routed-elsewhere", data: {} });
    assert.doesNotMatch(row(), /40%|21%/, "routed request must not be attributed to the selected model");
    await response(); await command("off", ctx);
    await fire("after_provider_response", { status: 200, headers: quotaHeaders });
    await command("on", ctx); assert.doesNotMatch(row(), /40%|21%/);
    await response(); await command("reload", ctx); assert.doesNotMatch(row(), /40%|21%/);
    await response(); await fire("session_start"); assert.doesNotMatch(row(), /40%|21%/);
    await fire("before_provider_request", { payload: {} });
    const streamFrame = (data: unknown) => fire("provider_stream_event", { provider: ctx.model!.provider, model: ctx.model!.id, api: ctx.model!.api, data });
    await streamFrame({ type: "response.created" });
    await streamFrame({ type: "codex.rate_limits", rate_limits: {
      primary: { used_percent: 42, window_minutes: 300, reset_at: now / 1000 + 10980 },
      secondary: { used_percent: 27, window_minutes: 10080, reset_at: now / 1000 + 4 * 86400 + 9 * 3600 },
    }, credits: { balance: "never-store-this" } });
    t.mock.timers.tick(0);
    assert.match(row(), /42%.*27%/);
    await streamFrame({ type: "response.output_text.delta", delta: "never-store-this" });
    await streamFrame({ type: "response.completed" });
    assert.match(row(), /42%.*27%/, "later ordinary WS frames preserve the request's quota");
    assert.doesNotMatch(row(), /never-store-this/);
    await fire("before_provider_request", { payload: {} });
    await streamFrame({ type: "response.created" });
    assert.doesNotMatch(row(), /42%|27%/, "a new no-quota WS response cannot retain the prior upstream account's quota");
  } finally {
    await fire("session_shutdown"); t.mock.timers.reset();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
