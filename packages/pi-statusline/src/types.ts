import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const SEGMENT_IDS = ["model", "thinking", "context", "directory", "git", "cost", "input", "output", "tokens", "cacheRead", "cacheWrite", "statuses"] as const;
export type SegmentId = typeof SEGMENT_IDS[number];
export type ColorValue = ThemeColor | `#${string}`;
export type Preset = "powerline";
export type IconMode = "unicode" | "nerd" | "ascii";
export interface RuntimeConfig {
  enabled: boolean;
  status: boolean;
  tools: boolean;
  noContent: boolean;
  noContentSeconds: number;
  avg: boolean;
  cache: boolean;
  counts: boolean;
  retainSummary: boolean;
}
export interface SegmentConfig {
  id: SegmentId;
  enabled: boolean;
  icon?: string;
  color?: ColorValue;
  iconColor?: ColorValue;
  background?: ColorValue;
}
export interface StatuslineConfig {
  version: 1;
  enabled: boolean;
  preset: Preset;
  icons: IconMode;
  separator: "pipe" | "dot" | "space" | "powerline";
  pathMode: "basename" | "abbreviated" | "full";
  modelDisplay: "name" | "last";
  contextDisplay: "text" | "bar";
  /** Blank lines rendered above the statusline, between the editor and the footer (0–3). */
  spacing: number;
  segments: SegmentConfig[];
  runtime: RuntimeConfig;
}
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
export interface GitState {
  kind: "repository" | "none" | "unknown";
  branch: string | null;
  detached: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
}
export interface StatuslineSnapshot {
  model: string;
  modelId: string;
  reasoning: boolean;
  thinking: string;
  cwd: string;
  home: string;
  context: { tokens: number | null; contextWindow: number; percent: number | null };
  usage: UsageTotals;
  git: GitState;
  statuses: ReadonlyMap<string, string>;
  runtime?: import("./runtime.ts").RuntimeSnapshot;
  compaction?: import("./compaction.ts").CompactionSnapshot;
}
