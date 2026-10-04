import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { presetConfig } from "../src/config.ts";
import { renderFooter, sampleSnapshot } from "../src/render.ts";
import { elapsed } from "../src/runtime-render.ts";
import { testTheme } from "./helpers.ts";

const second = (data = sampleSnapshot(), width = 240, config = presetConfig()) => stripTerminalSequences(renderFooter(width, data, config, testTheme()).at(-1)!);

test("Elapsed leads the runtime row without a duplicate Running/Done duration", () => {
  const data = sampleSnapshot(); const statuses = new Map<string, string>(); data.statuses = statuses; data.runtime!.elapsedMs = 342000;
  assert.match(second(data), /^Elapsed 5m 42s · Avg/);
  assert.doesNotMatch(second(data), /Running|Done/);
  statuses.set("tps", "\x1b[2mElapsed 5m 42s\x1b[0m"); statuses.set("review", "review ready");
  assert.match(second(data), /^Elapsed 5m 42s ·/);
  assert.equal(second(data).match(/Elapsed/g)?.length, 1);
  assert.match(second(data), /review ready/);
  data.runtime!.status = "Done";
  assert.doesNotMatch(second(data), /Done 342s|Running/);
  assert.equal(elapsed(90061000), "1d 1h 1m 1s");
  assert.equal(elapsed(3600000), "1h 0m 0s");
  assert.equal(elapsed(0), "0s");
});

test("idle footer omits the status label and leading separator", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  Object.assign(data.runtime!, { runId: null, status: "Idle", elapsedMs: 0, avg: null, cache: null, noContentMs: null });
  const config = presetConfig();
  assert.equal(second(data, 240, config), "Compactions 1");
  assert.doesNotMatch(second(data, 240, config), /Idle|^ ·/);
  config.runtime.counts = false;
  assert.equal(renderFooter(240, data, config, testTheme()).length, 1);
});

test("opaque statuses stay display-only, and runtime-off preserves the elapsed extension", () => {
  const data = sampleSnapshot(); data.statuses = new Map([["other", "Elapsed counterfeit"], ["tps", "Elapsed 5m 42s"]]);
  const config = presetConfig(); config.runtime.enabled = false;
  assert.match(second(data, 240, config), /^Elapsed 5m 42s ·/);
  assert.match(second(data, 240, config), /Elapsed counterfeit/);
  config.segments.find((s) => s.id === "statuses")!.enabled = false;
  assert.equal(renderFooter(240, data, config, testTheme()).length, 1);
});

test("tool, input, no-content, compaction and truthful turn labels", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  data.runtime!.tools = [{ name: "ask_user", elapsedMs: 26000 }];
  assert.match(second(data), /^Elapsed 28s · Tool ask_user 26s/);
  assert.doesNotMatch(second(data), /Avg|Cache/);
  data.runtime!.tools.push({ name: "read", elapsedMs: 1000 }); assert.match(second(data), /Tools 2 active/);
  data.runtime!.awaitingInput = true;
  assert.match(second(data), /Awaiting input/); assert.doesNotMatch(second(data), /No content|Tools 2 active|Avg|Cache/);
  data.runtime!.tools = []; data.runtime!.awaitingInput = false; data.runtime!.noContentMs = 10000;
  assert.match(second(data), /No content 10s/); assert.doesNotMatch(second(data), /Avg|Cache/);
  data.runtime!.noContentMs = null;
  assert.match(second(data), /Turns 3/);
  assert.doesNotMatch(second(data), /Requests|First text|First reasoning|Request \d|Waiting|Receiving/);
  data.compaction!.active = true; data.compaction!.elapsedMs = 4000;
  assert.match(second(data), /^Elapsed 28s · Compacting… 4s/);
  assert.doesNotMatch(second(data), /Until compact|Avg|Cache/);
});

test("zero compactions are omitted until the first success", () => {
  const data = sampleSnapshot(); data.statuses = new Map(); data.compaction!.count = 0;
  assert.doesNotMatch(second(data), /Compactions/);
  data.compaction!.active = true; data.compaction!.elapsedMs = 4000;
  assert.match(second(data), /Compacting… 4s/); assert.doesNotMatch(second(data), /Compactions/);
  data.compaction!.active = false; data.compaction!.count = 2;
  assert.match(second(data), /Compactions 2/);
});

test("no-content activity uses the same color as Avg in dark and light themes", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  const config = presetConfig();
  for (const appearance of ["dark", "light"] as const) {
    const theme = testTheme(appearance);
    data.runtime!.noContentMs = null;
    const avg = `Avg ${Math.round(data.runtime!.avg!)} tok/s`;
    assert.ok(renderFooter(240, data, config, theme)[1]!.includes(theme.style(avg, { fg: theme.colors.muted })));
    data.runtime!.noContentMs = 10000;
    const line = renderFooter(240, data, config, theme)[1]!;
    assert.ok(line.includes(theme.style("No content 10s", { fg: theme.colors.muted })));
    assert.ok(!line.includes(theme.style("No content 10s", { fg: theme.colors.warning })));
  }
});

test("narrow widths retain leading elapsed and every line fits terminal cells", () => {
  const data = sampleSnapshot(); data.runtime!.tools = [{ name: "中文😀工具", elapsedMs: 12000 }];
  data.statuses = new Map([["tps", "Elapsed 5m 42s"]]);
  for (const width of [0, 1, 6, 12, 24, 40, 60, 80, 120, 200]) {
    for (const icons of ["nerd", "unicode", "ascii"] as const) {
      const config = presetConfig(); config.icons = icons;
      for (const line of renderFooter(width, data, config, testTheme())) assert.ok(visibleWidth(line) <= width);
    }
  }
  assert.match(second(data, 24), /^Elapsed 5m 42s/);
});
