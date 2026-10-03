import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, presetConfig } from "./config.ts";
import { StatuslinePanel } from "./panel.ts";
import { sampleSnapshot } from "./render.ts";
import { FooterSession } from "./session.ts";

export default function statusline(pi: ExtensionAPI): void {
  const store = new ConfigStore(join(getAgentDir(), "extensions", "pi-statusline", "config.json"));
  let config = presetConfig();
  let session: FooterSession | undefined;
  let generation = 0;

  pi.on("session_start", async (_event, ctx) => {
    const token = ++generation;
    session?.dispose(); session = undefined;
    if (ctx.mode !== "tui") return;
    const loaded = await store.load(config);
    if (token !== generation) return;
    config = loaded.config;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    session = new FooterSession(ctx, config);
    session.refresh(true);
    session.install();
  });
  pi.on("session_shutdown", () => { generation++; session?.dispose(); session = undefined; });
  pi.on("agent_start", (_event, ctx) => { session?.setContext(ctx); session?.startRun(); session?.schedule(true); });
  pi.on("turn_start", (_event, ctx) => { session?.setContext(ctx); session?.startTurn(); session?.schedule(true); });
  pi.on("agent_before_settle", (event) => { session?.runtime.beforeSettle(event.outcome); });
  pi.on("agent_settled", (_event, ctx) => { session?.setContext(ctx); session?.settle(); session?.schedule(true); });
  pi.on("ui_prompt_start", () => { session?.runtime.uiStart(); session?.schedule(true); });
  pi.on("ui_prompt_end", () => { session?.runtime.uiEnd(); session?.schedule(true); });
  pi.on("tool_execution_start", (event, ctx) => { session?.setContext(ctx); session?.runtime.toolStart(event.toolCallId, event.toolName); session?.schedule(true); });
  pi.on("session_before_compact", (_event, ctx) => {
    session?.setContext(ctx); session?.compaction.start(); session?.runtime.compaction(true); session?.schedule(true);
  });
  pi.on("message_start", (event, ctx) => {
    session?.setContext(ctx);
    if (event.message.role === "assistant") { session?.setLive(undefined); session?.runtime.messageStart(event.message); }
    session?.schedule(true);
  });
  pi.on("message_update", (event, ctx) => {
    session?.setContext(ctx);
    if (event.message.role === "assistant") { session?.setLive(event.message); session?.runtime.stream(event.assistantMessageEvent); session?.runtime.message(event.message); }
    session?.schedule();
  });
  pi.on("message_end", (event, ctx) => {
    session?.setContext(ctx);
    if (event.message.role === "assistant") { session?.setLive(event.message); session?.runtime.message(event.message, true); }
    session?.schedule(true);
  });
  const refresh = (_event: unknown, ctx: ExtensionContext) => { session?.setContext(ctx); session?.schedule(true); };
  const resetLive = (event: unknown, ctx: ExtensionContext) => { session?.setLive(undefined); refresh(event, ctx); };
  pi.on("agent_end", resetLive);
  pi.on("turn_end", (event, ctx) => { if (event.message.role === "assistant") session?.runtime.message(event.message, true); session?.runtime.turnEnd(); refresh(event, ctx); });
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("session_compact", (event, ctx) => {
    session?.compaction.finish("success", event.compactionEntry.id); session?.runtime.compaction(false); resetLive(event, ctx);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    session?.compaction.finish(event.aborted ? "cancelled" : "failed", undefined, event.errorMessage); session?.runtime.compaction(false); refresh(event, ctx);
  });
  pi.on("session_tree", resetLive);
  pi.on("tool_execution_end", (event, ctx) => { session?.setContext(ctx); session?.runtime.toolEnd(event.toolCallId); session?.requestGit(); session?.schedule(true); });
  pi.on("user_bash", (_event, ctx) => { session?.setContext(ctx); session?.requestGit(); });

  pi.registerCommand("statusline", {
    description: "Configure the statusline, or on | off | reload",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Statusline configuration requires Pi terminal mode.", "info"); return; }
      const token = generation;
      const current = session;
      if (!current) return;
      current.setContext(ctx);
      const command = args.trim();
      if (command === "off") { current.disable(); return; }
      if (command === "on") { current.apply({ ...config, enabled: true }); return; }
      if (command === "reload") {
        const loaded = await store.load(config);
        if (token !== generation) return;
        config = loaded.config;
        if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
        current.dispose();
        session = new FooterSession(ctx, config);
        session.refresh(true); session.install();
        return;
      }
      if (command) { ctx.ui.notify("Usage: /statusline [on|off|reload]", "info"); return; }
      current.refresh(true);
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => new StatuslinePanel({
        config, theme: () => ctx.ui.theme,
        snapshot: () => {
          const example = ctx.sessionManager.getLeafId() === null;
          return { data: example ? sampleSnapshot() : current.snapshot(), example };
        },
        requestRender: () => tui.requestRender(), height: () => tui.terminal.rows,
        done: () => done(),
        save: async (next) => {
          if (token !== generation) throw new Error("Session changed; reopen settings");
          await store.save(next);
          if (token !== generation) return;
          config = next; current.apply(config);
        },
      }));
    },
  });
}
