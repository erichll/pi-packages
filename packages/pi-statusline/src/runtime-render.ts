import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RenderTheme } from "./render.ts";
import type { RuntimeSnapshot } from "./runtime.ts";
import type { StatuslineConfig, StatuslineSnapshot } from "./types.ts";

export function seconds(ms: number): string { return `${Math.floor(ms / 1000)}s`; }
export function elapsed(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const value = Math.floor(remaining / size); remaining %= size;
    if (value || parts.length || unit === "s") parts.push(`${value}${unit}`);
  }
  return parts.join(" ");
}
/** Tool timers stay narrow: `12s`, `1m5s`. */
function short(ms: number): string {
  const total = Math.floor(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${total % 60}s`;
}

type Color = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";
type Span = [text: string, color: Color];
interface Part { id: string; spans: Span[]; styled?: string }

function draw(parts: Part[], separator: string, theme: RenderTheme): string {
  return parts.map((part) => part.styled ?? part.spans.map(([text, color]) => theme.style(text, { fg: theme.colors[color] })).join(""))
    .join(theme.style(separator, { fg: theme.colors.dim }));
}
function fit(parts: Part[], dropOrder: string[], width: number, separator: string, theme: RenderTheme, ellipsis: string): string | undefined {
  let line = draw(parts, separator, theme);
  for (const id of dropOrder) {
    if (visibleWidth(line) <= width) break;
    const index = parts.findIndex((part) => part.id === id);
    if (index !== -1) { parts.splice(index, 1); line = draw(parts, separator, theme); }
  }
  return parts.length ? truncateToWidth(line, width, ellipsis) : undefined;
}

const STATUS: Partial<Record<RuntimeSnapshot["status"], { icon: string; ascii: string; color: Color }>> = {
  Running: { icon: "●", ascii: "*", color: "muted" },
  Done: { icon: "✓", ascii: "ok", color: "muted" },
  Failed: { icon: "✗", ascii: "x", color: "error" },
  Cancelled: { icon: "⊘", ascii: "-", color: "muted" },
};

export interface RuntimeExtras {
  /** Other extensions' statuses, already styled. */
  statuses?: string;
  /** Session age, already styled. */
  session?: string;
  /** Completed tool calls in the session, already styled. */
  toolTotal?: string;
  /** Session token total, already styled. */
  tokens?: string;
  /** A `tps` extension status of the form `Elapsed 5m 42s`. */
  elapsedStatus?: string;
}

/**
 * The bottom row: run status and duration, run metrics, then session age, tool calls, tokens and extension statuses.
 * It stays muted so it does not compete with the editor; only problems (failure, waits, low cache) are colored.
 */
export function renderRuntime(width: number, data: StatuslineSnapshot, config: StatuslineConfig, theme: RenderTheme, extras: RuntimeExtras = {}): string | undefined {
  const parts: Part[] = [];
  const runtime = data.runtime, compact = data.compaction;
  const enabled = config.runtime.enabled, ascii = config.icons === "ascii";
  const add = (id: string, ...spans: Span[]) => parts.push({ id, spans });
  // Label first, like `avg` and `cache`: `turns 4`, `compactions 1`.
  const count = (id: "turns" | "compactions", value: number) => add(id, [`${id} `, "dim"], [String(value), "muted"]);
  const duration = extras.elapsedStatus?.replace(/^Elapsed /, "") ?? (runtime?.runId ? elapsed(runtime.elapsedMs) : undefined);
  const state = enabled && config.runtime.status && runtime?.runId ? STATUS[runtime.status] : undefined;
  if (state && duration) add("elapsed", [ascii ? state.ascii : state.icon, state.color], [` ${duration}`, "muted"]);
  else if (extras.elapsedStatus) add("elapsed", ["elapsed ", "dim"], [duration!, "muted"]);
  const compacting = enabled && !!compact?.active;
  if (compacting) {
    add("activity", [`${ascii ? "compacting..." : "compacting…"} ${seconds(compact!.elapsedMs)}`, "warning"]);
  } else if (enabled && runtime) {
    if (config.runtime.status && compact?.showFailure && runtime.status !== "Running") add("failure", [`compaction ${compact.last?.status}`, "error"]);
    if (runtime.awaitingInput) add("activity", ["awaiting input", "warning"]);
    else if (config.runtime.noContent && runtime.noContentMs !== null && runtime.noContentMs >= config.runtime.noContentSeconds * 1000) {
      add("activity", [`no content ${seconds(runtime.noContentMs)}`, "warning"]);
    }
    if (config.runtime.avg && runtime.avg !== null) add("avg", ["avg ", "dim"], [`${Math.round(runtime.avg)} tok/s`, "muted"]);
    if (config.runtime.cache && runtime.cache !== null) {
      const percent = Math.round(runtime.cache * 100);
      add("cache", ["cache ", "dim"], [`${percent}%`, percent < 50 ? "warning" : "muted"]);
    }
    if (config.runtime.counts && runtime.runId) count("turns", runtime.turns);
  }
  if (enabled && config.runtime.counts && compact && compact.count > 0) count("compactions", compact.count);
  if (extras.session) parts.push({ id: "session", spans: [], styled: extras.session });
  if (extras.toolTotal) parts.push({ id: "toolTotal", spans: [], styled: extras.toolTotal });
  if (extras.tokens) parts.push({ id: "tokens", spans: [], styled: extras.tokens });
  if (extras.statuses && !compacting) parts.push({ id: "statuses", spans: [], styled: extras.statuses });
  return fit(parts, ["statuses", "cache", "avg", "compactions", "toolTotal", "session", "tokens", "turns", "activity", "failure"], width, ascii ? " | " : " · ", theme, ascii ? "..." : "…");
}

/** `◐ bash npm test 12s · ✓ read ×5 · ✗ bash ×1 · +2`: present while the run has used tools. */
export function renderTools(width: number, data: StatuslineSnapshot, config: StatuslineConfig, theme: RenderTheme): string | undefined {
  const runtime = data.runtime;
  if (!config.runtime.enabled || !config.runtime.tools || !runtime || (!runtime.tools.length && !runtime.completed.length)) return undefined;
  const ascii = config.icons === "ascii";
  const sym = ascii ? { run: ">", ok: "ok", fail: "x", times: "x" } : { run: "◐", ok: "✓", fail: "✗", times: "×" };
  const running: { name: string; count: number; target?: string; elapsedMs: number }[] = [];
  for (const tool of runtime.tools) {
    const group = running.find((item) => item.name === tool.name);
    if (!group) running.push({ name: tool.name, count: 1, target: tool.target, elapsedMs: tool.elapsedMs });
    else { group.count++; group.target = undefined; group.elapsedMs = Math.max(group.elapsedMs, tool.elapsedMs); }
  }
  const ok = runtime.completed.filter((tool) => tool.ok).sort((a, b) => b.ok - a.ok);
  const failed = runtime.completed.filter((tool) => tool.failed).sort((a, b) => b.failed - a.failed);
  const build = (visible: number, targets: boolean, timers: boolean): Part[] => {
    const parts: Part[] = running.slice(0, 2).map((group) => {
      const spans: Span[] = [[sym.run, "warning"], [` ${group.name}`, "accent"]];
      if (group.count > 1) spans.push([` ${sym.times}${group.count}`, "dim"]);
      else if (targets && group.target) spans.push([` ${group.target}`, "muted"]);
      if (timers && group.elapsedMs >= 1000) spans.push([` ${short(group.elapsedMs)}`, group.elapsedMs >= 30000 ? "warning" : "muted"]);
      return { id: "running", spans };
    });
    const moreRunning = running.slice(2).reduce((total, group) => total + group.count, 0);
    if (moreRunning) parts.push({ id: "running", spans: [[sym.run, "warning"], [` +${moreRunning}`, "dim"]] });
    for (const tool of ok.slice(0, visible)) parts.push({ id: "ok", spans: [[sym.ok, "success"], [` ${tool.name}`, "muted"], [` ${sym.times}${tool.ok}`, "dim"]] });
    for (const tool of failed) parts.push({ id: "failed", spans: [[sym.fail, "error"], [` ${tool.name}`, "muted"], [` ${sym.times}${tool.failed}`, "error"]] });
    const hidden = ok.length - Math.min(visible, ok.length);
    if (hidden) parts.push({ id: "more", spans: [[`+${hidden}`, "dim"]] });
    return parts;
  };
  // Narrowing order: fold completed kinds, then drop targets, then timers; running names go last.
  const max = config.runtime.toolsMaxVisible;
  const attempts: [number, boolean, boolean][] = [];
  for (let visible = max; visible >= 1; visible--) attempts.push([visible, true, true]);
  attempts.push([1, false, true], [0, false, true], [0, false, false]);
  const separator = ascii ? " | " : " · ";
  let parts: Part[] = [];
  for (const [visible, targets, timers] of attempts) {
    parts = build(visible, targets, timers);
    if (visibleWidth(draw(parts, separator, theme)) <= width) break;
  }
  return fit(parts, [], width, separator, theme, ascii ? "..." : "…");
}
