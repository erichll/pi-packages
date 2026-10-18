import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { presetConfig } from "../src/config.ts";
import { renderFooter, sampleSnapshot } from "../src/render.ts";
import { elapsed } from "../src/runtime-render.ts";
import { testTheme } from "./helpers.ts";

const rows = (data = sampleSnapshot(), width = 240, config = presetConfig()) => renderFooter(width, data, config, testTheme()).map(stripTerminalSequences);
const runtimeRow = (data = sampleSnapshot(), width = 240, config = presetConfig()) => rows(data, width, config).at(-1)!;
const toolsRow = (data = sampleSnapshot(), width = 240, config = presetConfig()) => rows(data, width, config)[1]!;
const fg = (name: "accent" | "success" | "error" | "muted" | "warning" | "text" | "dim") => testTheme().style("x", { fg: testTheme().colors[name] }).split("x")[0]!;
/** The foreground in effect where `text` starts. */
const colorOf = (line: string, text: string) => line.slice(0, line.indexOf(text)).match(/\x1b\[38;[\d;]+m/g)!.at(-1);

test("runtime row leads with run status and duration, then metrics, tokens and statuses", () => {
  const data = sampleSnapshot(); const statuses = new Map<string, string>(); data.statuses = statuses; data.runtime!.elapsedMs = 342000;
  assert.equal(runtimeRow(data), " 󰐰  ● 5m 42s · avg 45 tok/s · cache 86% · turns 3 · compactions 1 · 󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k");
  statuses.set("tps", "\x1b[2mElapsed 5m 41s\x1b[0m"); statuses.set("review", "review ready");
  assert.match(runtimeRow(data), /^ 󰐰  ● 5m 41s ·/, "an upstream Elapsed status supplies the duration");
  assert.doesNotMatch(runtimeRow(data), /Elapsed/);
  assert.match(runtimeRow(data), /󰥔 2h 6m · 󱁤 128 · 󰊄 49\.4k · .*review ready/);
  for (const [status, symbol] of [["Done", "✓"], ["Failed", "✗"], ["Cancelled", "⊘"]] as const) {
    data.runtime!.status = status; assert.match(runtimeRow(data), new RegExp(`^ 󰐰  ${symbol} 5m 41s ·`));
  }
  assert.equal(elapsed(90061000), "1d 1h 1m 1s");
  assert.equal(elapsed(3600000), "1h 0m 0s");
  assert.equal(elapsed(0), "0s");
});

test("the runtime row stays muted and colors only problems", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  const line = () => renderFooter(240, data, presetConfig(), testTheme()).at(-1)!;
  for (const text of ["●", "28s", "45 tok/s", "86%", "2h 6m", "49.4k"]) assert.equal(colorOf(line(), text), fg("muted"), text);
  for (const text of ["avg", "cache", "turns", "compactions", "󰥔", "󰊄"]) assert.equal(colorOf(line(), text), fg("dim"), text);
  assert.equal(colorOf(line(), "3 · compactions"), fg("muted"), "count values are muted");
  data.runtime!.cache = 0.6; assert.equal(colorOf(line(), "60%"), fg("muted"));
  data.runtime!.cache = 0.3; assert.equal(colorOf(line(), "30%"), fg("warning"));
  data.runtime!.status = "Done"; assert.equal(colorOf(line(), "✓"), fg("muted"));
  data.runtime!.status = "Failed"; assert.equal(colorOf(line(), "✗"), fg("error"));
  const config = presetConfig(); config.segments.find((s) => s.id === "tokens")!.color = "accent";
  assert.equal(colorOf(renderFooter(240, data, config, testTheme()).at(-1)!, "49.4k"), fg("accent"), "an explicit segment color still applies");
});

test("idle footer keeps the row icon, shows no status symbol and no leading separator", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  Object.assign(data.runtime!, { runId: null, status: "Idle", elapsedMs: 0, avg: null, cache: null, noContentMs: null, tools: [], completed: [] });
  const config = presetConfig();
  assert.equal(runtimeRow(data, 240, config), " 󰐰  compactions 1 · 󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k");
  assert.equal(colorOf(renderFooter(240, data, config, testTheme()).at(-1)!, "󰐰"), fg("dim"));
  const ascii = presetConfig(); ascii.icons = "ascii";
  assert.equal(runtimeRow(data, 240, ascii), " run compactions 1 | ses: 2h 6m | tool: 128 | tok: 49.4k");
  const unicode = presetConfig(); unicode.icons = "unicode";
  assert.match(runtimeRow(data, 240, unicode), /^ ∿  compactions 1 · /);
  config.runtime.counts = false;
  assert.equal(runtimeRow(data, 240, config), " 󰐰  󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k");
  config.segments.find((s) => s.id === "session")!.enabled = false;
  config.segments.find((s) => s.id === "toolTotal")!.enabled = false;
  config.segments.find((s) => s.id === "tokens")!.enabled = false;
  assert.deepEqual(rows(data, 240, config).slice(1), [" 󰗚  pdf-tools · docx"], "no lone row icon; session skills outlive the run");
});

test("opaque statuses stay display-only, and runtime-off preserves the elapsed extension", () => {
  const data = sampleSnapshot(); data.statuses = new Map([["other", "Elapsed counterfeit"], ["tps", "Elapsed 5m 42s"]]);
  const config = presetConfig(); config.runtime.enabled = false;
  assert.equal(rows(data, 240, config).length, 2, "runtime-off hides the tool row");
  assert.match(runtimeRow(data, 240, config), /^ 󰐰  elapsed 5m 42s · 󰥔 2h 6m · 󱁤 128 · 󰊄 49\.4k ·/);
  assert.match(runtimeRow(data, 240, config), /Elapsed counterfeit/);
  for (const id of ["statuses", "session", "toolTotal", "tokens"]) config.segments.find((s) => s.id === id)!.enabled = false;
  assert.equal(renderFooter(240, data, config, testTheme()).length, 1);
});

test("input, no-content and compaction activity sit after the duration; metrics stay visible", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  data.runtime!.awaitingInput = true; data.runtime!.noContentMs = 10000;
  assert.match(runtimeRow(data), /^ 󰐰  ● 28s · awaiting input · avg 45 tok\/s · cache 86% · turns 3/);
  assert.doesNotMatch(runtimeRow(data), /no content/);
  data.runtime!.awaitingInput = false;
  assert.match(runtimeRow(data), /^ 󰐰  ● 28s · no content 10s · avg/);
  const theme = testTheme(); const line = renderFooter(240, data, presetConfig(), theme).at(-1)!;
  assert.equal(colorOf(line, "no content"), fg("warning"));
  data.runtime!.noContentMs = 9000; assert.doesNotMatch(runtimeRow(data), /no content/);
  data.compaction!.active = true; data.compaction!.elapsedMs = 4000;
  assert.equal(runtimeRow(data), " 󰐰  ● 28s · compacting… 4s · compactions 1 · 󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k");
  data.compaction!.active = false; data.compaction!.showFailure = true;
  data.compaction!.last = { status: "failed" } as never; data.runtime!.status = "Done";
  assert.match(runtimeRow(data), /^ 󰐰  ✓ 28s · compaction failed ·/);
});

test("zero compactions are omitted and counts read label first", () => {
  const data = sampleSnapshot(); data.statuses = new Map(); data.compaction!.count = 0;
  assert.doesNotMatch(runtimeRow(data), /compaction/);
  data.compaction!.active = true; data.compaction!.elapsedMs = 4000;
  assert.match(runtimeRow(data), /compacting… 4s/); assert.doesNotMatch(runtimeRow(data), /compactions \d/);
  data.compaction!.active = false; data.compaction!.count = 2; data.runtime!.turns = 1;
  assert.match(runtimeRow(data), /turns 1 · compactions 2/);
});

test("tool row shows running tools with targets, then completed and failed counts", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  assert.deepEqual(rows(data).slice(1), [" 󱁤  ◐ bash npm test 12s · ✓ read ×5 · ✓ edit ×2", " 󰗚  pdf-tools · docx", " 󰐰  ● 28s · avg 45 tok/s · cache 86% · turns 3 · compactions 1 · 󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k"]);
  data.runtime!.tools = [{ name: "bash", target: "npm test", elapsedMs: 12000 }, { name: "bash", target: "ls", elapsedMs: 18000 }, { name: "read", target: "a.ts", elapsedMs: 0 }];
  data.runtime!.completed = [{ name: "read", ok: 3, failed: 0 }, { name: "bash", ok: 6, failed: 1 }, { name: "edit", ok: 3, failed: 0 }];
  assert.equal(toolsRow(data), " 󱁤  ◐ bash ×2 18s · ◐ read a.ts · ✓ bash ×6 · ✓ read ×3 · ✓ edit ×3 · ✗ bash ×1");
  data.runtime!.tools.push({ name: "grep", elapsedMs: 1000 }, { name: "find", elapsedMs: 1000 });
  assert.match(toolsRow(data), /^ 󱁤  ◐ bash ×2 18s · ◐ read a\.ts · ◐ \+2 · ✓ bash/);
  const line = renderFooter(240, data, presetConfig(), testTheme())[1]!;
  // Quiet like the runtime row: running tools are the brightest text, completed ones recede, problems stand out.
  assert.equal(colorOf(line, "◐"), fg("text")); assert.equal(colorOf(line, "bash"), fg("text"));
  assert.equal(colorOf(line, "a.ts"), fg("muted")); assert.equal(colorOf(line, "18s"), fg("muted"));
  assert.equal(colorOf(line, "✓"), fg("dim")); assert.equal(colorOf(line, " edit"), fg("muted")); assert.equal(colorOf(line, "×6"), fg("dim"));
  assert.equal(colorOf(line, "✗"), fg("error")); assert.equal(colorOf(line, "×1"), fg("error")); assert.equal(colorOf(line, "󱁤"), fg("dim"));
  const unicode = presetConfig(); unicode.icons = "unicode";
  assert.match(toolsRow(data, 240, unicode), /^ ⚒  ◐ bash/);
  assert.equal(line.slice(0, line.lastIndexOf("◐")).match(/\x1b\[38;[\d;]+m/g)!.at(-1), fg("text"), "the ◐ +2 overflow symbol");
  data.runtime!.tools = [{ name: "bash", elapsedMs: 29000 }];
  assert.equal(colorOf(renderFooter(240, data, presetConfig(), testTheme())[1]!, "◐"), fg("text"));
  data.runtime!.tools = [{ name: "bash", elapsedMs: 31000 }];
  const slow = renderFooter(240, data, presetConfig(), testTheme())[1]!;
  assert.equal(colorOf(slow, "◐"), fg("warning")); assert.equal(colorOf(slow, "31s"), fg("warning"));
  data.runtime!.tools = [{ name: "bash", elapsedMs: 61000 }];
  assert.match(toolsRow(data), /^ 󱁤  ◐ bash 1m1s ·/);
});

test("completed kinds fold into +N beyond toolsMaxVisible; the row hides without tools or when disabled", () => {
  const data = sampleSnapshot(); data.statuses = new Map(); data.runtime!.tools = [];
  data.runtime!.completed = ["a", "b", "c", "d", "e", "f"].map((name, i) => ({ name, ok: 10 - i, failed: 0 }));
  assert.equal(toolsRow(data), " 󱁤  ✓ a ×10 · ✓ b ×9 · ✓ c ×8 · ✓ d ×7 · +2");
  const config = presetConfig(); config.runtime.toolsMaxVisible = 2;
  assert.equal(toolsRow(data, 240, config), " 󱁤  ✓ a ×10 · ✓ b ×9 · +4");
  config.runtime.tools = false;
  assert.equal(rows(data, 240, config).length, 3);
  data.runtime!.completed = [];
  assert.equal(rows(data).length, 3);
});

test("ascii tool and runtime rows avoid Unicode symbols", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  data.runtime!.completed.push({ name: "bash", ok: 0, failed: 1 });
  const config = presetConfig(); config.icons = "ascii";
  const [, tools, skills, runtime] = rows(data, 240, config);
  assert.equal(tools, " tools > bash npm test 12s | ok read x5 | ok edit x2 | x bash x1");
  assert.equal(skills, " skills pdf-tools | docx");
  assert.equal(runtime, " run * 28s | avg 45 tok/s | cache 86% | turns 3 | compactions 1 | ses: 2h 6m | tool: 128 | tok: 49.4k");
});

test("narrow tool rows fold, then drop targets and timers before truncating", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  data.runtime!.tools = [{ name: "bash", target: "npm test", elapsedMs: 12000 }, { name: "read", target: "render.ts", elapsedMs: 0 }];
  data.runtime!.completed = [{ name: "read", ok: 5, failed: 0 }, { name: "edit", ok: 2, failed: 0 }, { name: "grep", ok: 1, failed: 0 }];
  assert.equal(toolsRow(data, 74), " 󱁤  ◐ bash npm test 12s · ◐ read render.ts · ✓ read ×5 · ✓ edit ×2 · +1");
  assert.equal(toolsRow(data, 54), " 󱁤  ◐ bash 12s · ◐ read · ✓ read ×5 · +2");
  assert.equal(toolsRow(data, 34), " 󱁤  ◐ bash 12s · ◐ read · +3");
  assert.equal(toolsRow(data, 24), " 󱁤  ◐ bash · ◐ read · +3");
});

test("narrow widths keep the leading status and every line fits terminal cells", () => {
  const data = sampleSnapshot(); data.runtime!.tools = [{ name: "中文😀工具", target: "目标😀", elapsedMs: 12000 }];
  data.statuses = new Map([["tps", "Elapsed 5m 42s"]]);
  for (const width of [0, 1, 6, 12, 24, 40, 60, 80, 120, 200]) {
    for (const icons of ["nerd", "unicode", "ascii"] as const) {
      const config = presetConfig(); config.icons = icons;
      for (const line of renderFooter(width, data, config, testTheme())) assert.ok(visibleWidth(line) <= width);
    }
  }
  assert.equal(runtimeRow(data, 25), " 󰐰  ● 5m 42s · turns 3");
});

test("skills row lists session skills quietly and folds names before the count", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  data.skills = ["pdf-tools", "docx", "xlsx", "pptx", "slides", "a-very-long-skill-name-that-goes-on"];
  const skillsRow = (width = 240, config = presetConfig()) => rows(data, width, config).find((row) => row.startsWith(" 󰗚"));
  assert.equal(skillsRow(), " 󰗚  pdf-tools · docx · xlsx · pptx +2");
  const config = presetConfig(); config.runtime.skillsMaxVisible = 8;
  assert.equal(skillsRow(240, config), " 󰗚  pdf-tools · docx · xlsx · pptx · slides · a-very-long-skill-name-…");
  assert.equal(skillsRow(28), " 󰗚  pdf-tools · docx +4");
  assert.equal(skillsRow(18), " 󰗚  pdf-tools +5");
  assert.equal(skillsRow(10), " 󰗚  6");
  const unicode = presetConfig(); unicode.icons = "unicode";
  assert.equal(rows(data, 240, unicode)[2], " ❖  pdf-tools · docx · xlsx · pptx +2");
  assert.equal(rows(data, 5)[2], " 󰗚  6"); assert.ok(visibleWidth(rows(data, 4)[2]!) <= 4);
  const line = renderFooter(240, data, presetConfig(), testTheme())[2]!;
  assert.equal(colorOf(line, "󰗚"), fg("dim")); assert.equal(colorOf(line, "pdf-tools"), fg("muted"));
  assert.equal(colorOf(line, " · docx"), fg("dim")); assert.equal(colorOf(line, "+2"), fg("dim"));
});

test("skills row hides without skills, when disabled, or with runtime metrics off", () => {
  const data = sampleSnapshot(); data.statuses = new Map();
  const hasSkills = (config = presetConfig()) => rows(data, 240, config).some((row) => /^ (󰗚|❖|skills) /.test(row));
  assert.ok(hasSkills());
  const off = presetConfig(); off.runtime.skills = false; assert.ok(!hasSkills(off));
  const runtimeOff = presetConfig(); runtimeOff.runtime.enabled = false; assert.ok(!hasSkills(runtimeOff));
  data.skills = []; assert.ok(!hasSkills());
});

test("lower row labels sit under the main row's model icon, with contents set off by two spaces", () => {
  for (const icons of ["nerd", "unicode"] as const) {
    const config = presetConfig(); config.icons = icons;
    const [main, ...lower] = rows(sampleSnapshot(), 240, config).map((row) => [...row]);
    assert.equal(lower.length, 3);
    assert.deepEqual([main![0], main![2]], [" ", " "]); assert.notEqual(main![1], " "); assert.notEqual(main![3], " ");
    for (const row of lower) {
      assert.equal(row[0], " ", `${icons}: ${row.join("")}`); assert.notEqual(row[1], " ");
      assert.deepEqual([row[2], row[3]], [" ", " "]); assert.notEqual(row[4], " ");
    }
  }
});
