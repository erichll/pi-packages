import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function cleanText(text: string): string {
  return stripTerminalSequences(text.replace(/[\r\n\t]/g, " ")).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "").trim();
}
/** Details never echo URLs, credentials or unbounded provider errors. */
export function safeReason(text: string): string {
  return cleanText(text).replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(api[-_]?key|token|authorization|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 180);
}
