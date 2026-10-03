import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ColorValue, StatuslineConfig } from "./types.ts";
import { SEGMENT_IDS } from "./types.ts";

// A deliberately small, documented set of Pi semantic foreground colors.
export const COLORS = ["text", "accent", "muted", "dim", "success", "warning", "error", "border", "borderAccent", "borderMuted", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"] as const;
export function validColor(value: unknown): value is ColorValue {
  return typeof value === "string" && (/^#[\da-f]{6}$/i.test(value) || (COLORS as readonly string[]).includes(value));
}
export function presetConfig(): StatuslineConfig {
  const enabled = new Set<string>(["model", "thinking", "directory", "git", "context", "tokens", "statuses"]);
  return {
    version: 1, enabled: true, preset: "powerline", icons: "nerd",
    separator: "powerline", pathMode: "basename", modelDisplay: "name", contextDisplay: "bar",
    segments: SEGMENT_IDS.map((id) => ({ id, enabled: enabled.has(id) })),
    runtime: { enabled: true, status: true, tools: true, noContent: true, noContentSeconds: 10, avg: true, cache: true, counts: true, retainSummary: true },
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${name}`);
  return value;
}
export function parseConfig(raw: unknown): StatuslineConfig {
  if (!record(raw)) throw new Error("Configuration must be an object");
  if (raw.version !== undefined && raw.version !== 1) throw new Error("Unsupported configuration version");
  if (raw.preset !== undefined) choice(raw.preset, ["powerline"] as const, "preset");
  const config = presetConfig();
  if (raw.enabled !== undefined) config.enabled = boolean(raw.enabled, "enabled");
  if (raw.icons !== undefined) config.icons = choice(raw.icons, ["unicode", "nerd", "ascii"], "icons");
  if (raw.separator !== undefined) config.separator = choice(raw.separator, ["pipe", "dot", "space", "powerline"], "separator");
  if (raw.pathMode !== undefined) config.pathMode = choice(raw.pathMode, ["basename", "abbreviated", "full"], "pathMode");
  if (raw.modelDisplay !== undefined) config.modelDisplay = choice(raw.modelDisplay, ["name", "last"], "modelDisplay");
  if (raw.contextDisplay !== undefined) config.contextDisplay = choice(raw.contextDisplay, ["text", "bar"], "contextDisplay");
  for (const group of ["runtime"] as const) {
    if (raw[group] === undefined) continue;
    if (!record(raw[group])) throw new Error(`Invalid ${group}`);
    for (const key of Object.keys(config[group])) {
      const value = raw[group][key];
      if (value === undefined) continue;
      if (key === "noContentSeconds") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3600) throw new Error("Invalid runtime.noContentSeconds (1–3600)");
        config.runtime.noContentSeconds = value;
      } else (config[group] as unknown as Record<string, unknown>)[key] = boolean(value, `${group}.${key}`);
    }
  }
  if (raw.segments !== undefined) {
    if (!Array.isArray(raw.segments)) throw new Error("segments must be an array");
    const seen = new Set<string>();
    config.segments = raw.segments.map((item: unknown) => {
      if (!record(item)) throw new Error("Invalid segment");
      const id = choice(item.id, SEGMENT_IDS, "segment id");
      if (seen.has(id)) throw new Error(`Duplicate segment: ${id}`);
      seen.add(id);
      const result = { id, enabled: item.enabled === undefined ? true : boolean(item.enabled, `${id}.enabled`) } as StatuslineConfig["segments"][number];
      if (item.icon !== undefined) {
        if (typeof item.icon !== "string" || item.icon.length > 32 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(item.icon)) throw new Error(`Invalid icon: ${id}`);
        result.icon = item.icon;
      }
      for (const key of ["color", "iconColor", "background"] as const) {
        if (item[key] !== undefined) {
          if (!validColor(item[key])) throw new Error(`Invalid ${id}.${key}`);
          result[key] = item[key];
        }
      }
      return result;
    });
    // An explicit list is authoritative. Omitted segments remain editable but disabled.
    for (const id of SEGMENT_IDS) if (!seen.has(id)) config.segments.push({ id, enabled: false });
  }
  return config;
}

export class ConfigStore {
  readonly file: string;
  private lastWarning = "";
  constructor(file: string) { this.file = file; }
  async load(previous = presetConfig()): Promise<{ config: StatuslineConfig; warning?: string }> {
    try {
      const config = parseConfig(JSON.parse(await readFile(this.file, "utf8")));
      this.lastWarning = "";
      return { config };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastWarning = "";
        return { config: presetConfig() };
      }
      const warning = `Could not load ${this.file}: ${error instanceof Error ? error.message : String(error)}`;
      const notify = warning !== this.lastWarning;
      this.lastWarning = warning;
      return { config: previous, ...(notify ? { warning } : {}) };
    }
  }
  async save(config: StatuslineConfig): Promise<void> {
    const validated = parseConfig(config);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      this.lastWarning = "";
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
