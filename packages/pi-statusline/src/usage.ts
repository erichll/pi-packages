import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UsageTotals } from "./types.ts";

export function emptyUsage(): UsageTotals { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function readUsage(value: unknown): UsageTotals {
  if (!value || typeof value !== "object") return emptyUsage();
  const usage = value as Record<string, unknown>;
  const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>).total : 0;
  return { input: finite(usage.input), output: finite(usage.output), cacheRead: finite(usage.cacheRead), cacheWrite: finite(usage.cacheWrite), cost: finite(cost) };
}
export function entryUsage(entry: SessionEntry): UsageTotals {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return readUsage(entry.usage);
  if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) return readUsage(entry.message.usage);
  return emptyUsage();
}
function add(target: UsageTotals, value: UsageTotals, sign = 1): void {
  for (const key of Object.keys(target) as (keyof UsageTotals)[]) target[key] += sign * value[key];
}
function messageKey(message: AssistantMessage): string { return `${message.provider}/${message.model}/${message.timestamp}`; }

/** Persisted totals plus one replaceable in-flight response, never summed per streaming event. */
export class UsageCache {
  private totals = emptyUsage();
  private contributions = new Map<string, UsageTotals>();
  private persistedMessages = new Set<string>();
  private count = 0;
  private live: AssistantMessage | undefined;
  reset(): void {
    this.totals = emptyUsage(); this.contributions.clear(); this.persistedMessages.clear(); this.count = 0; this.live = undefined;
  }
  update(entries: readonly SessionEntry[], rebuild = false): void {
    if (rebuild || entries.length < this.count) this.reset();
    // SessionManager appends immutable records; revisit the previous tail as a defensive measure.
    for (const entry of entries.slice(Math.max(0, this.count - 1))) {
      const previous = this.contributions.get(entry.id);
      if (previous) add(this.totals, previous, -1);
      const usage = entryUsage(entry);
      add(this.totals, usage);
      this.contributions.set(entry.id, usage);
      if (entry.type === "message" && entry.message.role === "assistant") this.persistedMessages.add(messageKey(entry.message));
    }
    this.count = entries.length;
  }
  setLive(message: AssistantMessage | undefined): void { this.live = message; }
  snapshot(): UsageTotals {
    const total = { ...this.totals };
    if (this.live && !this.persistedMessages.has(messageKey(this.live))) add(total, readUsage(this.live.usage));
    return total;
  }
}
