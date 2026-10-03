import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Clock } from "./runtime.ts";
import { safeReason } from "./text.ts";

export interface CompactionSnapshot {
  active: boolean;
  elapsedMs: number;
  count: number;
  last?: { status: "success" | "failed" | "cancelled"; reason?: string };
  showFailure: boolean;
}
export class CompactionState {
  private clock: Clock;
  private started: number | null = null;
  private ids = new Set<string>();
  private last: CompactionSnapshot["last"];
  private showFailure = false;
  constructor(clock: Clock = () => performance.now()) { this.clock = clock; }
  start(): void { if (this.started === null) this.started = this.clock(); this.showFailure = false; }
  finish(status: "success" | "failed" | "cancelled", id?: string, reason?: string): void {
    this.started = null; if (status === "success" && id) this.ids.add(id);
    this.last = { status, ...(reason ? { reason: safeReason(reason) } : {}) }; this.showFailure = status !== "success";
  }
  activity(): void { this.showFailure = false; }
  update(entries: readonly SessionEntry[]): void {
    // getEntries contains the entire file, including compactions on other branches.
    this.ids = new Set(entries.filter((entry) => entry.type === "compaction").map((entry) => entry.id));
  }
  snapshot(): CompactionSnapshot {
    return { active: this.started !== null, elapsedMs: this.started === null ? 0 : Math.max(0, this.clock() - this.started), count: this.ids.size, last: this.last, showFailure: this.showFailure };
  }
}
