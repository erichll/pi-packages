import { Input, matchesKey, SelectList, truncateToWidth, type Component, type Focusable, type SelectItem } from "@earendil-works/pi-tui";
import { COLORS, parseConfig, presetConfig } from "./config.ts";
import { cleanText, renderFooter, type RenderTheme } from "./render.ts";
import type { SegmentConfig, StatuslineConfig, StatuslineSnapshot } from "./types.ts";

interface PanelOptions {
  config: StatuslineConfig;
  theme: () => RenderTheme;
  snapshot: () => { data: StatuslineSnapshot; example: boolean };
  requestRender: () => void;
  height: () => number;
  save: (config: StatuslineConfig) => Promise<void>;
  done: () => void;
}

/** All edits belong to a draft. Only a successful explicit Save changes the running footer. */
export class StatuslinePanel implements Component, Focusable {
  private options: PanelOptions;
  private draft: StatuslineConfig;
  private list!: SelectList;
  private editing: SegmentConfig | undefined;
  private input: Input | undefined;
  private inputLabel = "";
  private error = "";
  private saving = false;
  private disposed = false;
  private hasFocus = false;
  private listHeight = 0;

  constructor(options: PanelOptions) { this.options = options; this.draft = structuredClone(options.config); this.rebuild(); }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (this.input) this.input.focused = value; }
  private paint(text: string, color: "text" | "accent" | "muted" | "error" = "text"): string {
    const theme = this.options.theme(); return theme.style(text, { fg: theme.colors[color] });
  }
  private thinkingConfig(): SegmentConfig {
    let thinking = this.draft.segments.find((segment) => segment.id === "thinking");
    if (!thinking) { thinking = { id: "thinking", enabled: false }; this.draft.segments.push(thinking); }
    return thinking;
  }
  private items(): SelectItem[] {
    if (this.editing) {
      const segment = this.editing;
      return [
        { value: "enabled", label: `Enabled: ${segment.enabled ? "yes" : "no"}` },
        ...(["icon", "color", "iconColor", "background"] as const).map((key) => ({ value: key, label: `${key}: ${segment[key] ?? "(default)"}`, description: key === "icon" ? "Empty text hides the icon; :default restores it" : "Semantic color or #RRGGBB; empty restores default" })),
        ...(segment.id === "model" ? [
          { value: "thinking", label: `Thinking level: ${this.thinkingConfig().enabled ? "yes" : "no"}`, description: "Colored level in parentheses after the model name" },
          { value: "thinkingColor", label: `Thinking color: ${this.thinkingConfig().color ?? "automatic"}`, description: "Automatic uses level colors; high/xhigh/max use rainbow" },
        ] : []),
        { value: "back", label: "Back to segments" },
      ];
    }
    return [
      { value: "preset", label: `Preset: ${this.draft.preset}`, description: "Cycles presets and resets segment styles/order" },
      { value: "defaultEnabled", label: `Enable on startup: ${this.draft.enabled ? "yes" : "no"}` },
      { value: "icons", label: `Icons: ${this.draft.icons}` },
      { value: "separator", label: `Separator: ${this.draft.separator}` },
      { value: "pathMode", label: `Path: ${this.draft.pathMode}` },
      { value: "modelDisplay", label: `Model display: ${this.draft.modelDisplay}`, description: "name: display name · last: final model ID component" },
      { value: "contextDisplay", label: `Context display: ${this.draft.contextDisplay}`, description: "text: tokens/capacity(percent) · bar: progress and percent" },
      ...this.draft.segments.filter((segment) => segment.id !== "thinking").map((segment) => ({ value: `segment:${segment.id}`, label: `[${segment.enabled ? "x" : " "}] ${segment.id}`, description: segment.id === "statuses" ? "Secondary row · Space toggles, Enter edits" : "Space toggles · Alt+Up/Down reorders · Enter edits" })),
      { value: "save", label: "Save and apply globally" },
      { value: "reset", label: "Restore defaults in preview" },
      { value: "cancel", label: "Cancel" },
    ];
  }
  private rebuild(selected?: string): void {
    const items = this.items();
    this.listHeight = Math.max(1, this.options.height() - 12);
    this.list = new SelectList(items, this.listHeight, {
      selectedPrefix: (text) => this.paint(text, "accent"), selectedText: (text) => this.paint(text, "accent"),
      description: (text) => this.paint(text, "muted"), scrollInfo: (text) => this.paint(text, "muted"), noMatch: (text) => this.paint(text, "muted"),
    });
    this.list.onSelect = (item) => this.activate(item.value);
    this.list.onCancel = () => this.cancel();
    if (selected) this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
  }
  private cancel(): void {
    if (this.input) { this.input = undefined; this.error = ""; }
    else if (this.editing) { const id = this.editing.id; this.editing = undefined; this.rebuild(`segment:${id}`); }
    else this.options.done();
  }
  private activate(value: string): void {
    this.error = "";
    if (this.editing) {
      if (value === "back") this.cancel();
      else if (value === "enabled") { this.editing.enabled = !this.editing.enabled; this.rebuild(value); }
      else if (value === "thinking") { const thinking = this.thinkingConfig(); thinking.enabled = !thinking.enabled; this.rebuild(value); }
      else this.editProperty(value as "icon" | "color" | "iconColor" | "background" | "thinkingColor");
      return;
    }
    const cycle = <T,>(current: T, options: readonly T[]): T => options[(options.indexOf(current) + 1) % options.length]!;
    switch (value) {
      case "preset": {
        const enabled = this.draft.enabled;
        const modelDisplay = this.draft.modelDisplay;
        const contextDisplay = this.draft.contextDisplay;
        this.draft = presetConfig(cycle(this.draft.preset, ["cometix", "minimal", "powerline"]));
        this.draft.enabled = enabled;
        this.draft.modelDisplay = modelDisplay;
        this.draft.contextDisplay = contextDisplay;
        break;
      }
      case "defaultEnabled": this.draft.enabled = !this.draft.enabled; break;
      case "icons": this.draft.icons = cycle(this.draft.icons, ["unicode", "nerd", "ascii"]); break;
      case "separator": this.draft.separator = cycle(this.draft.separator, ["pipe", "dot", "space", "powerline"]); break;
      case "pathMode": this.draft.pathMode = cycle(this.draft.pathMode, ["basename", "abbreviated", "full"]); break;
      case "modelDisplay": this.draft.modelDisplay = cycle(this.draft.modelDisplay, ["name", "last"]); break;
      case "contextDisplay": this.draft.contextDisplay = cycle(this.draft.contextDisplay, ["text", "bar"]); break;
      case "reset": this.draft = presetConfig(); break;
      case "cancel": this.options.done(); return;
      case "save": void this.save(); return;
      default: this.editing = this.draft.segments.find((segment) => `segment:${segment.id}` === value); break;
    }
    this.rebuild(this.editing ? undefined : value);
  }
  private editProperty(property: "icon" | "color" | "iconColor" | "background" | "thinkingColor"): void {
    const editingId = this.editing!.id;
    const segment = property === "thinkingColor" ? this.thinkingConfig() : this.editing!;
    const key = property === "thinkingColor" ? "color" : property;
    const input = new Input();
    input.setValue(segment[key] ?? (key === "icon" ? ":default" : ""));
    input.focused = this.hasFocus;
    this.input = input;
    this.inputLabel = key === "icon" ? "Icon (empty hides; :default restores)" : `${key} (#RRGGBB or ${COLORS.slice(0, 7).join(", ")}; empty restores)`;
    input.onEscape = () => this.cancel();
    input.onSubmit = (text) => {
      const candidate = structuredClone(this.draft);
      const target = candidate.segments.find((item) => item.id === segment.id)!;
      if ((key === "icon" && text === ":default") || (key !== "icon" && !text.trim())) delete target[key];
      else (target as unknown as Record<string, unknown>)[key] = key === "icon" ? text : text.trim();
      try {
        this.draft = parseConfig(candidate);
        this.editing = this.draft.segments.find((item) => item.id === editingId);
        this.input = undefined; this.error = ""; this.rebuild(property);
      } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    };
  }
  private async save(): Promise<void> {
    this.saving = true;
    this.options.requestRender();
    try { await this.options.save(structuredClone(this.draft)); if (!this.disposed) this.options.done(); }
    catch (error) { if (!this.disposed) this.error = `Save failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { this.saving = false; if (!this.disposed) this.options.requestRender(); }
  }
  handleInput(data: string): void {
    if (this.saving || this.disposed) return;
    if (this.input) this.input.handleInput(data);
    else {
      const selected = this.list.getSelectedItem()?.value;
      const segmentIndex = this.draft.segments.findIndex((segment) => `segment:${segment.id}` === selected);
      if (!this.editing && segmentIndex >= 0 && matchesKey(data, "space")) {
        const segment = this.draft.segments[segmentIndex]!; segment.enabled = !segment.enabled; this.rebuild(selected);
      } else if (!this.editing && segmentIndex >= 0 && (matchesKey(data, "alt+up") || matchesKey(data, "alt+down"))) {
        const direction = matchesKey(data, "alt+up") ? -1 : 1;
        let next = segmentIndex + direction;
        while (this.draft.segments[next]?.id === "thinking") next += direction;
        if (next >= 0 && next < this.draft.segments.length) {
          [this.draft.segments[segmentIndex], this.draft.segments[next]] = [this.draft.segments[next]!, this.draft.segments[segmentIndex]!];
          this.rebuild(selected);
        }
      } else this.list.handleInput(data);
    }
    if (!this.disposed) this.options.requestRender();
  }
  invalidate(): void { this.list.invalidate(); this.input?.invalidate(); }
  dispose(): void { this.disposed = true; }
  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.listHeight !== Math.max(1, this.options.height() - 12)) this.rebuild(this.list.getSelectedItem()?.value);
    const { data, example } = this.options.snapshot();
    const preview = renderFooter(width, data, this.draft, this.options.theme());
    const lines = [
      this.paint(`Statusline settings${this.editing ? ` / ${this.editing.id}` : ""}`, "accent"),
      this.paint(example ? "Preview · example data" : "Preview · current session", "muted"),
      ...(preview.length ? preview : [this.paint("(all segments hidden)", "muted")]),
      this.paint("Changes are a draft until Save. Fees are Pi-reported USD.", "muted"),
      "",
      ...(this.input ? [this.paint(this.inputLabel, "accent"), ...this.input.render(width)] : this.list.render(width)),
      "",
      this.paint(this.saving ? "Saving…" : "↑↓ select · Space toggle · Alt+↑↓ reorder · Enter edit · Esc back/cancel", "muted"),
      ...(this.error ? [this.paint(cleanText(this.error), "error")] : []),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }
}
