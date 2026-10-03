import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionContext, ReadonlyFooterDataProvider, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { presetConfig } from "../src/config.ts";
import { emptyGit } from "../src/git.ts";
import { FooterSession } from "../src/session.ts";
import { assistant, messageEntry, testTheme, usage } from "./helpers.ts";

function fixture() {
  let entries: SessionEntry[] = [messageEntry("1")];
  let leaf = "1", reads = 0, contextReads = 0, renders = 0, subscriptions = 0;
  let footer: (Component & { dispose?(): void }) | undefined;
  let context: ReturnType<ExtensionContext["getContextUsage"]> = { tokens: 1000, contextWindow: 10000, percent: 10 };
  let theme = testTheme() as Theme;
  const statuses = new Map<string, string>();
  let branchCallback: (() => void) | undefined;
  const provider = {
    getGitBranch: () => "main", getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 1,
    onBranchChange(callback: () => void) { branchCallback = callback; subscriptions++; return () => { subscriptions--; branchCallback = undefined; }; },
  } satisfies ReadonlyFooterDataProvider;
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/example", model: { id: "test", name: "Test model", provider: "example", reasoning: true, contextWindow: 10000 }, thinkingLevel: "high",
    sessionManager: { getSessionId: () => "test-session", getLeafId: () => leaf, getEntries: () => { reads++; return [...entries]; } },
    getContextUsage: () => { contextReads++; return context; },
    ui: {
      get theme() { return theme; },
      setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
        footer?.dispose?.();
        footer = factory?.({ requestRender() { renders++; } } as TUI, theme, provider);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx, statuses,
    get footer() { return footer; }, get reads() { return reads; }, get contextReads() { return contextReads; }, get renders() { return renders; }, get subscriptions() { return subscriptions; },
    append(entry: SessionEntry) { entries.push(entry); leaf = entry.id; },
    navigate(id: string) { leaf = id; },
    context(value: typeof context) { context = value; },
    theme(value: Theme) { theme = value; },
    branchChanged() { branchCallback?.(); },
  };
}

test("rendering and streaming reuse persisted statistics; final events reconcile after Pi persistence", async () => {
  const f = fixture(); let queries = 0;
  const session = new FooterSession(f.ctx, presetConfig(), async () => { queries++; return { ...emptyGit("repository"), branch: "main" }; });
  try {
    session.install(); await delay(0);
    const reads = f.reads, contextReads = f.contextReads, initialQueries = queries;
    for (let i = 0; i < 200; i++) f.footer!.render(80);
    assert.equal(f.reads, reads); assert.equal(f.contextReads, contextReads); assert.equal(queries, initialQueries);
    const live = assistant(2, usage(250, 50, 0.2));
    for (let i = 0; i < 10; i++) { session.setLive(live); session.schedule(); }
    await delay(120);
    assert.equal(session.snapshot().usage.input, 350);
    assert.equal(f.reads, reads);
    session.schedule(true); // Emitted before Pi appends final message.
    f.append(messageEntry("2", live));
    await delay(10);
    assert.equal(session.snapshot().usage.input, 350);
    assert.equal(f.reads, reads + 1);
  } finally { session.dispose(); }
});

test("compaction, tree navigation, model/thinking changes and live extension statuses stay fresh", async () => {
  const f = fixture();
  const session = new FooterSession(f.ctx, presetConfig(), async () => emptyGit("none"));
  try {
    session.install();
    f.context({ tokens: null, contextWindow: 10000, percent: null });
    f.append({ type: "compaction", id: "compact", parentId: "1", timestamp: new Date().toISOString(), summary: "summary", firstKeptEntryId: "1", tokensBefore: 1000, usage: usage(50, 5, 0.05) });
    session.schedule(true); await delay(10);
    assert.equal(session.snapshot().context.tokens, null);
    assert.equal(session.snapshot().usage.input, 150);
    f.context({ tokens: 1000, contextWindow: 10000, percent: 10 }); f.navigate("1");
    session.schedule(true); await delay(10);
    assert.equal(session.snapshot().usage.input, 150); // Other branches still incurred spend.
    assert.equal(session.snapshot().context.tokens, 1000);
    f.ctx.model = { ...f.ctx.model!, name: "New model", id: "provider/a/b/c/new", contextWindow: 20000 };
    f.ctx.thinkingLevel = "low";
    f.context({ tokens: 1000, contextWindow: 20000, percent: 5 });
    session.schedule(true); await delay(10);
    assert.equal(session.snapshot().model, "New model"); assert.equal(session.snapshot().thinking, "low"); assert.equal(session.snapshot().context.percent, 5);
    assert.equal(session.snapshot().modelId, "provider/a/b/c/new");
    session.apply({ ...presetConfig(), modelDisplay: "last" });
    const shortened = f.footer!.render(120).map(stripTerminalSequences).join("\n");
    assert.match(shortened, / new\(low\)/);
    assert.ok(!shortened.includes("New model") && !shortened.includes("provider/a/b/c"));
    f.statuses.set("review", "review ready");
    assert.match(f.footer!.render(120).map(stripTerminalSequences).join("\n"), /review ready/);
    f.statuses.clear();
    assert.equal(f.footer!.render(120).length, 2);
    assert.equal(stripTerminalSequences(f.footer!.render(120)[1]!), "Compactions 1");
    assert.doesNotMatch(stripTerminalSequences(f.footer!.render(120)[1]!), /Idle|^ ·/);
    const before = f.footer!.render(120)[0];
    const altered = testTheme("light") as Theme;
    f.theme(altered);
    session.apply(presetConfig());
    assert.notEqual(f.footer!.render(120)[0], before);
  } finally { session.dispose(); }
});

test("disable and external replacement release watchers, timers, queries and restore only owned footer", async () => {
  const f = fixture(); let queries = 0;
  const session = new FooterSession(f.ctx, presetConfig(), async () => { queries++; return emptyGit("none"); });
  session.install(); await delay(0);
  assert.equal(f.subscriptions, 1);
  session.disable(); assert.equal(f.subscriptions, 0); assert.equal(f.footer, undefined);
  const count = queries;
  session.requestGit(); session.schedule(); await delay(20);
  assert.equal(queries, count);
  session.apply(presetConfig()); await delay(0);
  assert.equal(f.subscriptions, 1);
  const replacement = { render: () => ["another footer"], invalidate() {} };
  f.ctx.ui.setFooter(() => replacement);
  assert.equal(f.subscriptions, 0); assert.equal(session.active, false);
  session.disable(); assert.equal(f.footer, replacement);
  session.dispose(); session.install(); assert.equal(f.footer, replacement);
});

test("disabled Git never starts a process even when the host branch watcher fires", async () => {
  const f = fixture(); let queries = 0;
  const config = presetConfig(); config.segments.find((segment) => segment.id === "git")!.enabled = false;
  const session = new FooterSession(f.ctx, config, async () => { queries++; return emptyGit("none"); });
  try {
    session.install(); f.branchChanged(); session.requestGit(); await delay(10);
    assert.equal(queries, 0);
  } finally { session.dispose(); }
});

test("new session instances cannot inherit old usage or late Git responses", async () => {
  const f = fixture(); let finish: ((value: ReturnType<typeof emptyGit>) => void) | undefined;
  const old = new FooterSession(f.ctx, presetConfig(), async () => new Promise((resolve) => { finish = resolve; }));
  old.install(); old.dispose();
  const fresh = fixture(); fresh.ctx.sessionManager.getEntries = () => [];
  const next = new FooterSession(fresh.ctx, presetConfig(), async () => emptyGit("none"));
  try {
    next.install(); finish?.({ ...emptyGit("repository"), branch: "old-branch" }); await delay(0);
    assert.equal(next.snapshot().usage.cost, 0);
    assert.equal(next.snapshot().git.kind, "none");
  } finally { next.dispose(); }
});

test("run signal cancellation is observed without before-settle and listeners leave on disposal", () => {
  const f = fixture(), controller = new AbortController();
  Object.defineProperty(f.ctx, "signal", { value: controller.signal });
  const session = new FooterSession(f.ctx, presetConfig(), async () => emptyGit("none"));
  session.install(); session.startRun(); session.startTurn(); controller.abort(); session.settle();
  assert.equal(session.runtime.snapshot().status, "Cancelled"); session.dispose();
  const fresh = fixture(), late = new AbortController(); Object.defineProperty(fresh.ctx, "signal", { value: late.signal });
  const next = new FooterSession(fresh.ctx, presetConfig(), async () => emptyGit("none")); next.install(); next.startRun(); next.dispose(); late.abort();
  assert.equal(next.runtime.snapshot().status, "Running"); // disposed signal callback was detached
});

test("unchanged refresh does not retraverse compaction history", () => {
  const f = fixture();
  const session = new FooterSession(f.ctx, presetConfig(), async () => emptyGit("none"));
  try {
    session.install(); const reads = f.reads;
    assert.equal(session.snapshot().compaction?.count, 0);
    session.refresh(); assert.equal(f.reads, reads);
    f.append({ type: "compaction", id: "compact", parentId: "1", timestamp: "", summary: "summary", firstKeptEntryId: "1", tokensBefore: 1000 });
    session.refresh(); assert.equal(f.reads, reads + 1);
    assert.equal(session.snapshot().compaction?.count, 1);
    session.refresh(); assert.equal(f.reads, reads + 1);
  } finally { session.dispose(); }
});
