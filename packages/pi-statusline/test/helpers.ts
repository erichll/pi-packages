import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, styleText } from "@earendil-works/pi-tui";
import { COLORS } from "../src/config.ts";
import type { RenderTheme } from "../src/render.ts";

export function testTheme(appearance: "dark" | "light" = "dark"): RenderTheme {
  const colors = Object.fromEntries(COLORS.map((key, i) => [key, parseColor(`#${(0x224466 + i * 0x050503).toString(16)}`)])) as unknown as Theme["colors"];
  return { colors, appearance, style: (text, options) => styleText(text, options as Parameters<typeof styleText>[1], "truecolor") };
}
export function usage(input = 100, output = 20, cost = 0.1) {
  return { input, output, cacheRead: 40, cacheWrite: 10, totalTokens: input + output + 50, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
export function assistant(timestamp = 1, data = usage()): AssistantMessage {
  return { role: "assistant", provider: "example", model: "example-model", api: "openai-completions", content: [], stopReason: "stop", timestamp, usage: data } as AssistantMessage;
}
export function messageEntry(id: string, message = assistant(Number(id) || 1)): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message };
}
