/** Local-only provider for manual/PTY smoke testing. Never contacts a service. */
import { createAssistantMessageEventStream, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function smokeProvider(pi: ExtensionAPI): void {
  pi.registerProvider("statusline-smoke", {
    name: "Statusline offline smoke", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-only",
    api: "statusline-smoke-api" as Api,
    models: ["demo", "alternate"].map((id) => ({ id, name: `Smoke ${id}`, input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } })),
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: "stop",
        content: [{ type: "text", text: "" }],
        usage: { input: 23000, output: 0, cacheRead: 800, cacheWrite: 0, totalTokens: 23800, cost: { input: 0.023, output: 0, cacheRead: 0.00008, cacheWrite: 0, total: 0.02308 } },
      } as AssistantMessage;
      void (async () => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        for (const text of ["Offline streaming ", "中文验证 😀 ", "complete."]) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          if (options?.signal?.aborted) {
            message.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); return;
          }
          const block = message.content[0];
          if (block?.type === "text") block.text += text;
          message.usage.output += 20;
          message.usage.totalTokens += 20;
          message.usage.cost.output += 0.00004;
          message.usage.cost.total += 0.00004;
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        }
        const content = message.content[0];
        stream.push({ type: "text_end", contentIndex: 0, content: content?.type === "text" ? content.text : "", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      })();
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setStatus("smoke", "smoke status ready"); });
  pi.registerCommand("smoke-theme", { description: "Smoke: change theme", handler: async (_args, ctx) => { ctx.ui.setTheme("light"); } });
  pi.registerCommand("smoke-model", { description: "Smoke: change model and thinking", handler: async (_args, ctx) => {
    const model = ctx.modelRegistry.find("statusline-smoke", "alternate");
    if (model) await pi.setModel(model);
    pi.setThinkingLevel("low");
  } });
}
