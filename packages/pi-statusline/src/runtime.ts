import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./text.ts";
import { emptyUsage, readUsage } from "./usage.ts";
import type { UsageTotals } from "./types.ts";

export type Clock = () => number;
export interface RuntimeSnapshot {
  runId: string | null;
  status: "Idle" | "Running" | "Done" | "Cancelled" | "Failed";
  elapsedMs: number;
  turns: number;
  toolCalls: number;
  tools: { name: string; elapsedMs: number }[];
  awaitingInput: boolean;
  noContentMs: number | null;
  usage: UsageTotals | null;
  avg: number | null;
  cache: number | null;
}

/** A run survives agent_end, retries and boundary continuations until agent_settled. */
export class RuntimeState {
  private clock: Clock;
  private startMs = 0;
  private endMs = 0;
  private runId: string | null = null;
  private state: RuntimeSnapshot["status"] = "Idle";
  private outcome: AgentActivityOutcome = "completed";
  private aborted = false;
  private turns = 0;
  private tools = new Map<string, { name: string; start: number }>();
  private seenTools = new Set<string>();
  private prompts = 0;
  private modelActive = false;
  private compacting = false;
  private lastContent = 0;
  private messages = new Map<string, UsageTotals>();
  private activeMessage: string | undefined;
  private messageAliases = new Map<string, string>();
  private sequence = 0;
  constructor(clock: Clock = () => performance.now()) { this.clock = clock; }
  get running(): boolean { return this.state === "Running"; }
  get id(): string | null { return this.runId; }
  reset(): void {
    this.runId = null; this.state = "Idle"; this.startMs = 0; this.endMs = 0;
    this.outcome = "completed"; this.aborted = false; this.turns = 0; this.tools.clear(); this.seenTools.clear();
    this.prompts = 0; this.modelActive = false; this.compacting = false;
    this.messages.clear(); this.messageAliases.clear(); this.activeMessage = undefined; this.sequence = 0;
  }
  start(): boolean {
    if (this.running) return false;
    const prompts = this.prompts;
    this.reset(); this.prompts = prompts;
    this.runId = randomUUID(); this.startMs = this.clock(); this.lastContent = this.startMs; this.state = "Running";
    return true;
  }
  beforeSettle(outcome: AgentActivityOutcome): void { if (this.running && !this.aborted) this.outcome = outcome; }
  observeAbort(): void { if (this.running) { this.aborted = true; this.outcome = "aborted"; } }
  settle(): void {
    if (!this.running) return;
    this.endMs = this.clock();
    this.state = { completed: "Done", aborted: "Cancelled", error: "Failed" }[this.outcome] as RuntimeSnapshot["status"];
    this.modelActive = false; this.tools.clear(); this.activeMessage = undefined;
  }
  turnStart(): void {
    if (!this.running) return;
    // A continuation/retry supersedes the previous attempt's observed outcome.
    this.outcome = "completed"; this.aborted = false;
    this.turns++; this.modelActive = true; this.lastContent = this.clock(); this.activeMessage = undefined;
  }
  turnEnd(): void { this.modelActive = false; }
  content(): void { if (this.running && !this.compacting) this.lastContent = this.clock(); }
  stream(event: AssistantMessageEvent): void {
    if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta.length > 0) this.content();
    // A tool name/ID in the initial block is content even before JSON deltas arrive.
    if (event.type === "toolcall_start") {
      const block = event.partial.content[event.contentIndex];
      if (block?.type === "toolCall" && (block.name || block.id)) this.content();
    }
  }
  private alias(message: AssistantMessage): string { return `${message.provider}/${message.model}/${message.timestamp}`; }
  messageStart(message: AssistantMessage): void {
    if (!this.running || this.compacting) return;
    this.activeMessage = String(++this.sequence);
    this.messageAliases.set(this.alias(message), this.activeMessage);
  }
  message(message: AssistantMessage, final = false): void {
    if (!this.running || this.compacting) return;
    const alias = this.alias(message);
    const responseAlias = message.responseId ? `${message.provider}/${message.model}/response:${message.responseId}` : undefined;
    const key = (responseAlias ? this.messageAliases.get(responseAlias) : undefined) ?? this.messageAliases.get(alias) ?? this.activeMessage ?? String(++this.sequence);
    this.messageAliases.set(alias, key);
    if (responseAlias) this.messageAliases.set(responseAlias, key);
    // Missing usage stays unavailable. Zeroes explicitly supplied by Pi are valid.
    if (message.usage && [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite].every((n) => Number.isFinite(n) && n >= 0)) {
      this.messages.set(key, readUsage(message.usage));
    }
    if (final) {
      this.modelActive = false;
      if (!this.aborted) this.outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
    }
  }
  toolStart(id: string, name: string): void {
    if (!this.running || this.seenTools.has(id)) return;
    this.seenTools.add(id); this.tools.set(id, { name: cleanText(name).slice(0, 40) || "unknown", start: this.clock() });
  }
  toolEnd(id: string): void { this.tools.delete(id); }
  uiStart(): void { this.prompts++; }
  uiEnd(): void { this.prompts = Math.max(0, this.prompts - 1); this.lastContent = this.clock(); }
  compaction(active: boolean): void { this.compacting = active; this.lastContent = this.clock(); }
  snapshot(retainSummary = true): RuntimeSnapshot {
    const now = this.clock();
    const hidden = !retainSummary && !this.running;
    const elapsedMs = hidden || !this.runId ? 0 : Math.max(0, (this.running ? now : this.endMs) - this.startMs);
    const usage = !hidden && this.messages.size ? emptyUsage() : null;
    if (usage) for (const contribution of this.messages.values()) for (const key of Object.keys(usage) as (keyof UsageTotals)[]) usage[key] += contribution[key];
    const denominator = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
    return {
      runId: hidden ? null : this.runId, status: hidden ? "Idle" : this.state, elapsedMs,
      turns: hidden ? 0 : this.turns, toolCalls: hidden ? 0 : this.seenTools.size,
      tools: [...this.tools.values()].map((tool) => ({ name: tool.name, elapsedMs: Math.max(0, now - tool.start) })),
      awaitingInput: this.prompts > 0,
      noContentMs: this.running && this.modelActive && !this.tools.size && !this.prompts && !this.compacting ? Math.max(0, now - this.lastContent) : null,
      usage, avg: usage && elapsedMs > 0 ? usage.output / (elapsedMs / 1000) : null,
      cache: usage && denominator > 0 ? usage.cacheRead / denominator : null,
    };
  }
}
