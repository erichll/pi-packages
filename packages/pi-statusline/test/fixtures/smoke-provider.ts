/** Local-only provider for PTY smoke testing. Never contacts a service. */
import { createAssistantMessageEventStream, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) done(); else signal?.addEventListener("abort", done, { once: true });
  });
}

export default function smokeProvider(pi: ExtensionAPI): void {
  let failCompaction = false;
  pi.registerProvider("statusline-smoke", {
    name: "Statusline offline smoke", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-only",
    api: "statusline-smoke-api" as Api,
    models: ["demo", "alternate"].map((id) => ({ id, name: `Smoke ${id}`, input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const prompt = last?.role === "user" ? typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join(" ") : "";
      const tools = prompt === "tools";
      const message = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: "stop",
        content: tools ? [{ type: "toolCall", id: `smoke-${Date.now()}`, name: "smoke_parent", arguments: {} }] : [{ type: "text", text: "" }],
        usage: { input: 23000, output: 0, cacheRead: 800, cacheWrite: 0, totalTokens: 23800, cost: { input: 0.023, output: 0, cacheRead: 0.00008, cacheWrite: 0, total: 0.02308 } },
      } as AssistantMessage;
      void (async () => {
        const abort = () => {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message }); stream.end();
        };
        stream.push({ type: "start", partial: message });
        if (failCompaction) {
          failCompaction = false; await pause(200, options?.signal);
          message.stopReason = "error"; message.errorMessage = "Offline synthetic compaction failure";
          stream.push({ type: "error", reason: "error", error: message }); stream.end(); return;
        }
        if (prompt === "slow") await pause(15000, options?.signal);
        if (options?.signal?.aborted) { abort(); return; }
        if (tools) {
          message.stopReason = "toolUse"; message.usage.output = 10; message.usage.totalTokens += 10;
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          const block = message.content[0];
          if (block?.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
          stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
        }
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        for (const text of ["Offline streaming ", "中文验证 😀 ", "complete."]) {
          await pause(180, options?.signal);
          if (options?.signal?.aborted) { abort(); return; }
          const block = message.content[0];
          if (block?.type === "text") block.text += text;
          message.usage.output += 20; message.usage.totalTokens += 20;
          message.usage.cost.output += 0.00004; message.usage.cost.total += 0.00004;
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        }
        const content = message.content[0];
        stream.push({ type: "text_end", contentIndex: 0, content: content?.type === "text" ? content.text : "", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      })();
      return stream;
    },
  });
  pi.registerTool({ name: "smoke_child", label: "Smoke child", description: "Offline nested tool", parameters: { type: "object", properties: {} }, async execute(_id, _args, signal, update) {
    update?.({ content: [{ type: "text", text: "Offline tool update" }], details: {} });
    await pause(1200, signal); return { content: [{ type: "text", text: "Offline child finished" }], details: {} };
  } });
  pi.registerTool({ name: "smoke_parent", label: "Smoke parent", description: "Offline nested tool and UI wait", parameters: { type: "object", properties: {} }, async execute(_id, _args, _signal, _update, ctx) {
    await ctx.executeTool("smoke_child", {});
    await ctx.ui.confirm("Smoke input", "Continue offline tool?");
    return { content: [{ type: "text", text: "Offline parent finished" }], details: {} };
  } });
  pi.on("session_start", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setStatus("smoke", "smoke status ready"); });
  pi.registerCommand("smoke-fail-compact", { description: "Smoke: fail next compaction", handler: async () => { failCompaction = true; } });
  pi.registerCommand("smoke-theme", { description: "Smoke: change theme", handler: async (_args, ctx) => { ctx.ui.setTheme("light"); } });
  pi.registerCommand("smoke-model", { description: "Smoke: change model and thinking", handler: async (_args, ctx) => {
    const model = ctx.modelRegistry.find("statusline-smoke", "alternate");
    if (model) await pi.setModel(model); pi.setThinkingLevel("low");
  } });
}
