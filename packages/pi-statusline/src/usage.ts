import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CostProvenance, UsageTotals } from "./types.ts";

const NUMERIC_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costProvenance: "unknown" };
}
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function costProvenance(cost: unknown): CostProvenance {
  if (!cost || typeof cost !== "object") return "unknown";
  const flag = (cost as Record<string, unknown>).totalFromProvider;
  if (flag === true) return "provider";
  if (flag === false) return "estimated";
  return "unknown";
}
/** `unknown` is the identity, so missing flags do not mark an otherwise uniform total. */
export function mergeCostProvenance(current: CostProvenance, next: CostProvenance): CostProvenance {
  if (next === "unknown" || current === next) return current;
  if (current === "unknown") return next;
  return "mixed";
}
export function readUsage(value: unknown): UsageTotals {
  if (!value || typeof value !== "object") return emptyUsage();
  const usage = value as Record<string, unknown>;
  const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>).total : 0;
  return {
    input: finite(usage.input), output: finite(usage.output), cacheRead: finite(usage.cacheRead), cacheWrite: finite(usage.cacheWrite),
    cost: finite(cost), costProvenance: costProvenance(usage.cost),
  };
}
export function entryUsage(entry: SessionEntry): UsageTotals {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return readUsage(entry.usage);
  if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) return readUsage(entry.message.usage);
  return emptyUsage();
}
function add(target: UsageTotals, value: UsageTotals, sign = 1): void {
  for (const key of NUMERIC_KEYS) target[key] += sign * value[key];
}
function provenanceOf(parts: Iterable<UsageTotals>): CostProvenance {
  let result: CostProvenance = "unknown";
  for (const part of parts) result = mergeCostProvenance(result, part.costProvenance);
  return result;
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
    const parts = [...this.contributions.values()];
    if (this.live && !this.persistedMessages.has(messageKey(this.live))) {
      const live = readUsage(this.live.usage);
      add(total, live);
      parts.push(live);
    }
    total.costProvenance = provenanceOf(parts);
    return total;
  }
}
