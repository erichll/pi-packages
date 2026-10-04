import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { emptyGit, GitPoller, type GitReader } from "./git.ts";
import { renderFooter, withSpacing } from "./render.ts";
import type { StatuslineConfig, StatuslineSnapshot } from "./types.ts";
import { UsageCache } from "./usage.ts";
import { RuntimeState } from "./runtime.ts";
import { CompactionState } from "./compaction.ts";

export class FooterSession {
  readonly runtime = new RuntimeState();
  readonly compaction = new CompactionState();
  private ctx: ExtensionContext;
  private config: StatuslineConfig;
  private usage = new UsageCache();
  private git = emptyGit();
  private provider: ReadonlyFooterDataProvider | undefined;
  private tui: Pick<TUI, "requestRender"> | undefined;
  private poller: GitPoller | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private ownsFooter = false;
  private statsKey = "";
  private displayKey = "";
  private context: StatuslineSnapshot["context"] = { tokens: null, contextWindow: 0, percent: null };
  private readonly gitReader: GitReader | undefined;
  private signal: AbortSignal | undefined;
  private readonly onAbort = () => { this.runtime.observeAbort(); this.schedule(true); };

  constructor(ctx: ExtensionContext, config: StatuslineConfig, gitReader?: GitReader) {
    this.ctx = ctx; this.config = config; this.gitReader = gitReader;
  }
  get active(): boolean { return this.ownsFooter && !this.closed; }
  setContext(ctx: ExtensionContext): void { this.ctx = ctx; this.watchSignal(); }
  private watchSignal(): void {
    if (this.closed || !this.ownsFooter || !this.runtime.running) return;
    const signal = this.ctx.signal;
    if (!signal || signal === this.signal) return;
    this.clearSignal(); this.signal = signal;
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }
  private clearSignal(): void { this.signal?.removeEventListener("abort", this.onAbort); this.signal = undefined; }
  startRun(): void {
    this.compaction.activity();
    this.runtime.start();
    this.watchSignal();
  }
  startTurn(): void {
    this.compaction.activity(); this.runtime.turnStart(); this.watchSignal();
  }
  settle(): void { this.runtime.settle(); this.clearSignal(); }
  install(): void {
    if (this.closed || this.ctx.mode !== "tui" || !this.config.enabled) return;
    this.ctx.ui.setFooter((tui, _theme, provider) => {
      this.ownsFooter = true; this.tui = tui; this.provider = provider;
      this.watchSignal();
      this.poller = new GitPoller(this.ctx.cwd, (git) => { this.git = git; this.repaint(); }, this.gitReader);
      this.unsubscribe = provider.onBranchChange(() => this.requestGit());
      if (this.config.segments.some((segment) => segment.id === "git" && segment.enabled)) this.poller.start();
      this.refresh(true);
      // Covers usage entries appended outside normal message events (e.g. cache warming).
      this.timer = setInterval(() => this.refresh(), 1000);
      this.timer.unref();
      return {
        render: (width: number) => withSpacing(renderFooter(width, this.snapshot(), this.config, this.ctx.ui.theme), this.config.spacing),
        invalidate: () => {}, // Theme and extension statuses are read fresh on every render.
        dispose: () => this.stopResources(),
      };
    });
  }
  private stopResources(): void {
    this.clearSignal();
    clearInterval(this.timer); clearTimeout(this.scheduled);
    this.timer = undefined; this.scheduled = undefined;
    this.poller?.dispose(); this.poller = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.ownsFooter = false; this.tui = undefined; this.provider = undefined;
  }
  disable(): void {
    const restore = this.ownsFooter;
    this.stopResources();
    if (restore && !this.closed) this.ctx.ui.setFooter(undefined);
  }
  dispose(): void { this.stopResources(); this.clearSignal(); this.closed = true; }
  apply(config: StatuslineConfig): void {
    if (this.closed) return;
    this.disable(); this.config = config;
    if (config.enabled) this.install();
  }
  setLive(message: AssistantMessage | undefined): void { this.usage.setLive(message); }
  schedule(immediate = false): void {
    if (!this.active) return;
    if (immediate) { clearTimeout(this.scheduled); this.scheduled = undefined; }
    if (this.scheduled) return;
    // Defer final events too: Pi emits message_end before appending the message.
    this.scheduled = setTimeout(() => { this.scheduled = undefined; this.refresh(); }, immediate ? 0 : 100);
    this.scheduled.unref();
  }
  requestGit(): void {
    if (this.active && this.config.segments.some((segment) => segment.id === "git" && segment.enabled)) void this.poller?.refresh();
  }
  refresh(force = false): void {
    if (this.closed) return;
    const manager = this.ctx.sessionManager;
    const key = `${manager.getSessionId()}:${manager.getLeafId()}:${this.ctx.model?.provider}/${this.ctx.model?.id}/${this.ctx.model?.contextWindow}`;
    if (force || key !== this.statsKey) {
      const entries = manager.getEntries();
      this.usage.update(entries);
      this.compaction.update(entries);
      const context = this.ctx.getContextUsage();
      this.context = context ?? { tokens: null, contextWindow: this.ctx.model?.contextWindow ?? 0, percent: null };
    }
    this.statsKey = key;
    this.repaint();
  }
  private repaint(): void {
    if (!this.active) return;
    const snapshot = this.snapshot();
    const key = JSON.stringify({ ...snapshot, statuses: undefined });
    if (key === this.displayKey) return;
    this.displayKey = key; this.tui?.requestRender();
  }
  snapshot(): StatuslineSnapshot {
    return {
      model: this.ctx.model?.name || this.ctx.model?.id || "No model", modelId: this.ctx.model?.id ?? "", reasoning: this.ctx.model?.reasoning ?? false,
      thinking: this.ctx.thinkingLevel ?? "off", cwd: this.ctx.cwd, home: homedir(),
      context: this.context, usage: this.usage.snapshot(), git: this.git,
      statuses: this.provider?.getExtensionStatuses() ?? new Map(),
      runtime: this.runtime.snapshot(this.config.runtime.retainSummary), compaction: this.compaction.snapshot(),
    };
  }
}
