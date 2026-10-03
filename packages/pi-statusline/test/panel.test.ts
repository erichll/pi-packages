import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { presetConfig } from "../src/config.ts";
import { StatuslinePanel } from "../src/panel.ts";
import { renderFooter, sampleSnapshot } from "../src/render.ts";
import type { StatuslineConfig } from "../src/types.ts";
import { testTheme } from "./helpers.ts";

const up = "\x1b[A", down = "\x1b[B", enter = "\r", escape = "\x1b";
function select(panel: StatuslinePanel, label: string): void {
  for (let i = 0; i < 35; i++) {
    if (panel.render(140).some((line) => stripTerminalSequences(line).startsWith(`→ ${label}`))) return;
    panel.handleInput(down);
  }
  throw new Error(`No panel item: ${label}`);
}

test("draft preview uses the footer renderer; cancellation never saves or mutates active configuration", () => {
  const config = presetConfig(); const original = structuredClone(config);
  let saves = 0, closed = 0;
  const theme = testTheme(), data = sampleSnapshot();
  const panel = new StatuslinePanel({ config, theme: () => theme, snapshot: () => ({ data, example: true }), requestRender() {}, height: () => 30, save: async () => { saves++; }, done: () => { closed++; } });
  const preview = renderFooter(100, data, config, theme);
  assert.deepEqual(panel.render(100).slice(2, 2 + preview.length), preview);
  assert.match(stripTerminalSequences(panel.render(100)[1]!), /example data/);
  assert.doesNotMatch(panel.render(100).map(stripTerminalSequences).join("\n"), /Preset:/);
  select(panel, "Icons:"); panel.handleInput(enter);
  assert.deepEqual(config, original);
  panel.handleInput(escape);
  assert.equal(saves, 0); assert.equal(closed, 1);
});

test("keyboard editing, validation, ordering and save produce a usable configuration", async () => {
  let saved: StatuslineConfig | undefined, closed = 0;
  const panel = new StatuslinePanel({ config: presetConfig(), theme: testTheme, snapshot: () => ({ data: sampleSnapshot(), example: false }), requestRender() {}, height: () => 30, save: async (config) => { saved = config; }, done: () => { closed++; } });
  select(panel, "Model display:"); panel.handleInput(enter);
  select(panel, "Context display:"); panel.handleInput(enter);

  assert.ok(panel.render(140).some((line) => stripTerminalSequences(line).includes("Model display: last")));
  assert.ok(panel.render(140).some((line) => stripTerminalSequences(line).includes("Context display: text")));
  assert.ok(!panel.render(140).some((line) => stripTerminalSequences(line).includes("[x] thinking")));
  select(panel, "[x] directory");
  panel.handleInput(" ");
  panel.handleInput("\x1b[1;3A"); // Alt+Up
  panel.handleInput("\x1b[1;3A"); // Move past context and the hidden thinking entry.
  select(panel, "[x] model"); panel.handleInput(enter);
  select(panel, "Thinking level:"); panel.handleInput(enter);
  select(panel, "color:"); panel.handleInput(enter);
  panel.focused = true;
  assert.ok(panel.render(100).some((line) => line.includes(CURSOR_MARKER)));
  panel.handleInput("invalid-color"); panel.handleInput(enter);
  assert.ok(panel.render(100).some((line) => stripTerminalSequences(line).includes("Invalid model.color")));
  panel.handleInput("\x01"); panel.handleInput("\x0b"); // Ctrl+A, Ctrl+K
  panel.handleInput("#123456"); panel.handleInput(enter);
  panel.handleInput(escape); // back to main list
  select(panel, "Save and apply"); panel.handleInput(enter);
  await delay(0);
  assert.equal(closed, 1);
  assert.equal(saved?.modelDisplay, "last");
  assert.equal(saved?.contextDisplay, "text");
  assert.equal(saved?.segments[0]?.id, "directory");
  assert.equal(saved?.segments[0]?.enabled, false);
  assert.equal(saved?.segments.find((segment) => segment.id === "thinking")?.enabled, false);
  assert.equal(saved?.segments.find((segment) => segment.id === "model")?.color, "#123456");
});

test("restore defaults previews the single Powerline layout and only saves on confirmation", async () => {
  const config = presetConfig(), saves: StatuslineConfig[] = [];
  config.icons = "ascii"; config.separator = "pipe"; config.modelDisplay = "last";
  config.runtime.tools = false; config.segments[0]!.color = "warning";
  const original = structuredClone(config);
  const panel = new StatuslinePanel({ config, theme: testTheme, snapshot: () => ({ data: sampleSnapshot(), example: false }), requestRender() {}, height: () => 50, save: async (next) => { saves.push(next); }, done() {} });
  select(panel, "Restore defaults in preview"); panel.handleInput(enter);
  assert.equal(saves.length, 0); assert.deepEqual(config, original);
  assert.doesNotMatch(panel.render(140).map(stripTerminalSequences).join("\n"), /Preset:/);
  select(panel, "Save and apply"); panel.handleInput(enter); await delay(0);
  assert.deepEqual(saves, [presetConfig()]); assert.deepEqual(config, original);
});

test("save failures remain visible, and the panel fits narrow and short terminals", async () => {
  let closed = false, height = 15;
  const panel = new StatuslinePanel({ config: presetConfig(), theme: testTheme, snapshot: () => ({ data: sampleSnapshot(), example: false }), requestRender() {}, height: () => height, save: async () => { throw new Error("read-only destination"); }, done: () => { closed = true; } });
  for (const width of [1, 20, 40, 80, 120]) for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
  select(panel, "Save and apply"); panel.handleInput(enter); await delay(0);
  assert.equal(closed, false);
  assert.ok(panel.render(120).some((line) => stripTerminalSequences(line).includes("read-only destination")));
  height = 25;
  panel.handleInput(up); panel.dispose();
});

test("runtime drafts support numeric validation and save without mutating active configuration", async () => {
  const config = presetConfig(), original = structuredClone(config); const saves: StatuslineConfig[] = [];
  const panel = new StatuslinePanel({ config, theme: testTheme, snapshot: () => ({ data: sampleSnapshot(), example: false }), requestRender() {}, height: () => 30, save: async (next) => { saves.push(next); }, done() {} });
  select(panel, "Runtime options"); panel.handleInput(enter);
  select(panel, "Tool activity:"); panel.handleInput(" ");
  select(panel, "No content threshold"); panel.handleInput(enter);
  panel.handleInput("\x01"); panel.handleInput("\x0b"); panel.handleInput("0"); panel.handleInput(enter);
  assert.match(panel.render(140).map(stripTerminalSequences).join("\n"), /Invalid runtime.noContentSeconds/);
  panel.handleInput("\x01"); panel.handleInput("\x0b"); panel.handleInput("20"); panel.handleInput(enter); panel.handleInput(escape);
  assert.doesNotMatch(panel.render(140).map(stripTerminalSequences).join("\n"), /Current \/ last run details/);
  assert.equal(saves.length, 0);
  select(panel, "Save and apply"); panel.handleInput(enter); await delay(0);
  assert.deepEqual(config, original); assert.equal(saves[0]?.runtime.tools, false);
  assert.equal(saves[0]?.runtime.noContentSeconds, 20);
  assert.ok(saves[0] && !("providerMetrics" in saves[0]) && !("integrations" in saves[0]));
});
