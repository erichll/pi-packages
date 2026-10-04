import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RenderTheme } from "./render.ts";
import { cleanText } from "./text.ts";
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
interface Part { id: string; text: string; color?: "text" | "muted" | "warning" | "error" | "success"; styled?: string }

/** Layout consumes snapshots only; width decisions use terminal cells, including ANSI. */
export function renderRuntime(width: number, data: StatuslineSnapshot, config: StatuslineConfig, theme: RenderTheme, extensionStatus?: string, elapsedStatus?: string): string | undefined {
  const parts: Part[] = [];
  const runtime = data.runtime, compact = data.compaction;
  const enabled = config.runtime.enabled;
  const add = (id: string, text: string, color?: Part["color"]) => parts.push({ id, text, color });
  if (elapsedStatus) add("elapsed", elapsedStatus);
  else if (enabled && config.runtime.status && runtime?.runId) add("elapsed", `Elapsed ${elapsed(runtime.elapsedMs)}`);
  if (enabled && compact?.active) {
    add("status", `${config.icons === "ascii" ? "Compacting..." : "Compacting…"} ${seconds(compact.elapsedMs)}`, "warning");
    if (config.runtime.counts && compact.count > 0) add("compactions", `Compactions ${compact.count}`);
  } else {
    if (enabled && runtime) {
      if (config.runtime.status) {
        const failure = compact?.showFailure && runtime.status !== "Running" ? `Compaction ${compact.last?.status}` : undefined;
        if (failure) add("status", failure, "error");
      }
      let busy = false;
      if (runtime.awaitingInput) { add("activity", "Awaiting input", "warning"); busy = true; }
      else if (config.runtime.tools && runtime.tools.length) {
        add("activity", runtime.tools.length > 1 ? `Tools ${runtime.tools.length} active` : `Tool ${cleanText(runtime.tools[0]!.name).slice(0, 40)} ${seconds(runtime.tools[0]!.elapsedMs)}`);
        busy = true;
      } else if (config.runtime.noContent && runtime.noContentMs !== null && runtime.noContentMs >= config.runtime.noContentSeconds * 1000) {
        add("activity", `No content ${seconds(runtime.noContentMs)}`); busy = true;
      }
      if (!busy) {
        if (config.runtime.avg && runtime.avg !== null) add("avg", `Avg ${Math.round(runtime.avg)} tok/s`);
        if (config.runtime.cache && runtime.cache !== null) add("cache", `Cache ${Math.round(runtime.cache * 100)}%`);
      }
      if (config.runtime.counts && runtime.runId) add("turns", `Turns ${runtime.turns}`);
    }
    if (enabled && config.runtime.counts && compact && compact.count > 0) add("compactions", `Compactions ${compact.count}`);
    if (extensionStatus) parts.push({ id: "statuses", text: extensionStatus, styled: extensionStatus });
  }
  const separator = config.icons === "ascii" ? " | " : " · ";
  const draw = () => parts.map((part) => part.styled ?? theme.style(part.text, { fg: theme.colors[part.color ?? "muted"] })).join(theme.style(separator, { fg: theme.colors.dim }));
  let line = draw();
  for (const id of ["statuses", "cache", "avg", "compactions", "turns", "activity"]) {
    if (visibleWidth(line) <= width) break;
    const index = parts.findIndex((part) => part.id === id);
    if (index !== -1) parts.splice(index, 1);
    line = draw();
  }
  return parts.length ? truncateToWidth(line, width, config.icons === "ascii" ? "..." : "…") : undefined;
}
