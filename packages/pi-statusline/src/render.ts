import { basename, isAbsolute, relative, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "./text.ts";
export { cleanText } from "./text.ts";
import type { ColorValue, SegmentConfig, SegmentId, StatuslineConfig, StatuslineSnapshot } from "./types.ts";
import { emptyGit } from "./git.ts";
import { emptyUsage } from "./usage.ts";
import { renderRuntime } from "./runtime-render.ts";

export type RenderTheme = Pick<Theme, "style" | "colors" | "appearance">;
// Keep rainbow hues independent of semantic theme colors, which can repeat.
const THINKING_RAINBOW = ["#c084fc", "#f472b6", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#60a5fa"].map((value) => parseColor(value));
const ICONS: Record<StatuslineConfig["icons"], Partial<Record<SegmentId, string>>> = {
  unicode: { model: "", directory: "▸", git: "⑂", context: "◉", cost: "$", input: "↑", output: "↓", tokens: "Σ", cacheRead: "R", cacheWrite: "W" },
  nerd: { model: "", directory: "󰉋", git: "", context: "󰆼", cost: "$", input: "↑", output: "↓", tokens: "󰊄", cacheRead: "R", cacheWrite: "W" },
  ascii: { model: "", directory: "", git: "git:", context: "ctx:", cost: "$", input: "in:", output: "out:", tokens: "tok:", cacheRead: "R:", cacheWrite: "W:" },
};
const DROP_ORDER: SegmentId[] = ["cost", "cacheWrite", "cacheRead", "tokens", "output", "input", "thinking", "git", "directory"];
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const divisor = value >= 1e6 ? 1e6 : 1000;
  return `${Number((value / divisor).toFixed(1))}${divisor === 1e6 ? "M" : "k"}`;
}
function contextBar(percent: number | null, ascii: boolean): string {
  const width = 10;
  if (percent === null || !Number.isFinite(percent)) return `[${"?".repeat(width)}]?%`;
  const fill = Math.max(0, Math.min(100, percent)) / 100 * width;
  // Whole cells avoid the blank right side of fractional glyphs such as ▌.
  // Keep small, non-zero usage visible; the percentage gives the precise value.
  const full = fill > 0 ? Math.max(1, Math.round(fill)) : 0;
  const bar = (ascii ? "#" : "█").repeat(full) + (ascii ? "-" : "░").repeat(width - full);
  return `[${bar}]${Number(percent.toFixed(1))}%`;
}
function displayPath(data: StatuslineSnapshot, mode: StatuslineConfig["pathMode"]): string {
  if (mode === "basename") return basename(data.cwd) || data.cwd;
  const rel = data.home ? relative(data.home, data.cwd) : "..";
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const full = inside ? (rel ? `~${sep}${rel}` : "~") : data.cwd;
  if (mode !== "abbreviated" || visibleWidth(full) <= 36) return full;
  const parts = full.split(sep);
  return `…${sep}${parts.slice(-2).join(sep)}`;
}
function gitText(data: StatuslineSnapshot, ascii: boolean): string | undefined {
  const git = data.git;
  if (git.kind === "none") return undefined;
  if (git.kind === "unknown") return `${git.branch ?? ""} ?`.trim();
  const bits = [git.branch ?? "HEAD"];
  if (git.detached) bits.push(ascii ? "(detached)" : "detached");
  if (git.conflicts) bits.push(`${ascii ? "!" : "⚠"}${git.conflicts}`);
  else bits.push(git.staged + git.unstaged + git.untracked ? (ascii ? "*" : "●") : (ascii ? "ok" : "✓"));
  if (git.staged) bits.push(`+${git.staged}`);
  if (git.unstaged) bits.push(`*${git.unstaged}`);
  if (git.untracked) bits.push(`?${git.untracked}`);
  if (git.ahead) bits.push(`${ascii ? "^" : "↑"}${git.ahead}`);
  if (git.behind) bits.push(`${ascii ? "v" : "↓"}${git.behind}`);
  return bits.join(" ");
}
function segmentText(id: SegmentId, data: StatuslineSnapshot, config: StatuslineConfig): string | undefined {
  const usage = data.usage;
  switch (id) {
    case "model": return (config.modelDisplay === "last" ? data.modelId.split("/").filter(Boolean).at(-1) : undefined) || data.model || "No model";
    case "thinking": return undefined; // Its settings now control the model's suffix.
    case "directory": return displayPath(data, config.pathMode);
    case "git": return gitText(data, config.icons === "ascii");
    case "context": {
      const { tokens, percent, contextWindow } = data.context;
      if (config.contextDisplay === "bar") return contextBar(percent, config.icons === "ascii");
      const capacity = contextWindow > 0 ? formatTokens(contextWindow) : "?";
      return `${tokens === null ? "?" : formatTokens(tokens)}/${capacity}(${percent === null ? "?" : Number(percent.toFixed(1))}%)`;
    }
    case "cost": return usage.cost.toFixed(3);
    case "input": return formatTokens(usage.input);
    case "output": return formatTokens(usage.output);
    case "tokens": return formatTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
    case "cacheRead": return formatTokens(usage.cacheRead);
    case "cacheWrite": return formatTokens(usage.cacheWrite);
    case "statuses": return [...data.statuses.values()].map(cleanText).filter(Boolean).join(" · ") || undefined;
  }
}
function defaultColor(id: SegmentId, data: StatuslineSnapshot): ColorValue {
  if (id === "context") {
    if ((data.context.percent ?? 0) > 90) return "error";
    if ((data.context.percent ?? 0) > 70) return "warning";
  }
  if (id === "git") {
    if (data.git.conflicts) return "error";
    if (data.git.kind === "unknown" || data.git.staged + data.git.unstaged + data.git.untracked) return "warning";
    return "success";
  }
  if (id === "thinking") {
    const colors: Record<string, ColorValue> = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" };
    return colors[data.thinking] ?? "muted";
  }
  if (id === "model") return "accent";
  if (id === "directory") return "success";
  if (id === "context") return "#c678dd";
  if (id === "cost") return "text";
  return "muted";
}
function color(value: ColorValue, theme: RenderTheme) {
  return value.startsWith("#") ? parseColor(value) : theme.colors[value as Exclude<ColorValue, `#${string}`>];
}
interface Part {
  config: SegmentConfig;
  text: string;
  icon: string;
  foreground: ColorValue;
  background?: ColorValue;
  thinking?: { text: string; foreground: ColorValue | "rainbow" };
}
function renderPart(part: Part, theme: RenderTheme): string {
  const bg = part.background ? color(part.background, theme) : undefined;
  const style = { fg: color(part.foreground, theme), ...(bg ? { bg } : {}) };
  const icon = part.icon ? theme.style(`${part.icon} `, { ...style, fg: color(part.config.iconColor ?? part.foreground, theme) }) : "";
  const text = theme.style(part.text, style);
  let suffix = "";
  if (part.thinking) {
    const { text: level, foreground } = part.thinking;
    const label = `(${level})`;
    const characters = Array.from(label);
    suffix = foreground === "rainbow"
      ? characters.map((character, i) => theme.style(character, {
          ...style,
          fg: THINKING_RAINBOW[Math.round(i * (THINKING_RAINBOW.length - 1) / Math.max(1, characters.length - 1))]!,
        })).join("")
      : theme.style(label, { ...style, fg: color(foreground, theme) });
  }
  const content = `${icon}${text}${suffix}`;
  return bg ? `${theme.style(" ", style)}${content}${theme.style(" ", style)}` : content;
}
function joinParts(parts: Part[], config: StatuslineConfig, theme: RenderTheme): string {
  return parts.map((part, i) => {
    let separator = "";
    const previous = parts[i - 1];
    if (previous) {
      if (config.separator === "powerline" && config.icons !== "ascii") {
        separator = theme.style("", {
          fg: color(previous.background ?? previous.foreground, theme),
          ...(part.background ? { bg: color(part.background, theme) } : {}),
        });
      } else {
        const sep = config.separator === "space" ? " " : config.separator === "dot" && config.icons !== "ascii" ? " · " : " | ";
        separator = theme.style(sep, { fg: theme.colors.dim });
      }
    }
    return separator + renderPart(part, theme);
  }).join("");
}

/** Pure terminal rendering: no disk reads, processes or session traversal. */
export function renderFooter(width: number, data: StatuslineSnapshot, config: StatuslineConfig, theme: RenderTheme): string[] {
  width = Math.max(0, Math.floor(width));
  if (width === 0) return [];
  const parts: Part[] = [];
  let secondary: Part | undefined;
  // CLIProxyAPI's published `tps` status is display text only.
  const tps = cleanText(data.statuses.get("tps") ?? "");
  const elapsedStatus = config.segments.some((s) => s.id === "statuses" && s.enabled) && /^Elapsed \d+[dhms](?: \d+[hms])*$/.test(tps) ? tps : undefined;
  const statuses = elapsedStatus ? new Map([...data.statuses].filter(([key]) => key !== "tps")) : data.statuses;
  const thinking = config.segments.find((segment) => segment.id === "thinking");
  for (const segment of config.segments) {
    if (!segment.enabled) continue;
    const raw = segmentText(segment.id, segment.id === "statuses" ? { ...data, statuses } : data, config);
    if (raw === undefined) continue;
    let text = cleanText(raw);
    if (config.icons === "ascii") text = text.replaceAll(" · ", " / ").replaceAll("…", "...");
    const background = segment.background ?? (config.preset === "powerline" ? (theme.appearance === "light" ? (parts.length % 2 ? "#e4e9f2" : "#d6dde9") : (parts.length % 2 ? "#283447" : "#202938")) : undefined);
    const part: Part = { config: segment, text, icon: cleanText(segment.icon ?? ICONS[config.icons][segment.id] ?? ""), foreground: segment.color ?? defaultColor(segment.id, data), background };
    if (segment.id === "model" && data.reasoning && thinking?.enabled) {
      part.thinking = {
        text: cleanText(data.thinking || "off"),
        foreground: thinking.color ?? (["high", "xhigh", "max"].includes(data.thinking) ? "rainbow" : defaultColor("thinking", data)),
      };
    }
    if (segment.id === "statuses") secondary = part;
    else parts.push(part);
  }
  let line = joinParts(parts, config, theme);
  const ellipsis = config.icons === "ascii" ? "..." : "…";
  if (visibleWidth(line) > width) {
    for (const id of ["directory", "model"] as const) {
      const part = parts.find((p) => p.config.id === id);
      if (part) part.text = truncateToWidth(part.text, Math.max(6, Math.min(24, Math.floor(width / 4))), ellipsis);
    }
    line = joinParts(parts, config, theme);
    for (const id of DROP_ORDER) {
      if (visibleWidth(line) <= width) break;
      if (id === "thinking") {
        const model = parts.find((p) => p.config.id === "model");
        if (model) model.thinking = undefined;
      } else {
        const index = parts.findIndex((p) => p.config.id === id);
        if (index !== -1) parts.splice(index, 1);
      }
      line = joinParts(parts, config, theme);
    }
  }
  const lines: string[] = [];
  if (parts.length) lines.push(truncateToWidth(line, width, ellipsis));
  const secondLine = renderRuntime(width, data, config, theme, secondary ? renderPart(secondary, theme) : undefined, elapsedStatus);
  if (secondLine) lines.push(secondLine);
  return lines;
}

export function sampleSnapshot(): StatuslineSnapshot {
  return {
    model: "Example model", modelId: "example/provider/model", reasoning: true, thinking: "high", cwd: "/projects/pi-packages", home: "/home/example",
    context: { tokens: 23800, contextWindow: 200000, percent: 11.9 },
    usage: { ...emptyUsage(), input: 32000, output: 5400, cacheRead: 12000, cost: 0.12 },
    git: { ...emptyGit("repository"), branch: "main", unstaged: 2, ahead: 2 },
    statuses: new Map([["example", "Example extension status"]]),
    runtime: { runId: "example", status: "Running", elapsedMs: 28000, turns: 3, toolCalls: 2, tools: [], awaitingInput: false, noContentMs: 0, usage: { ...emptyUsage(), output: 1260 }, avg: 45, cache: 0.86 },
    compaction: { active: false, elapsedMs: 0, count: 1, showFailure: false },
  };
}
