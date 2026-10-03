import assert from "node:assert/strict";
import test from "node:test";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { presetConfig } from "../src/config.ts";
import { cleanText, renderFooter, sampleSnapshot } from "../src/render.ts";
import { testTheme } from "./helpers.ts";

test("all themes and icon modes fit every width including wide Unicode and escape sequences", () => {
  const data = sampleSnapshot();
  data.model = "中文模型 👩‍💻 with a very long name";
  data.cwd = "/project/非常长的中文目录😀";
  data.statuses = new Map([["one", "\x1b[31m中文状态 😀\x1b[0m\nnext\x1b]0;unsafe title\x07"], ["two", "another status"]]);
  for (const preset of ["cometix", "minimal", "powerline"] as const) {
    for (const appearance of ["dark", "light"] as const) {
      for (const icons of ["unicode", "nerd", "ascii"] as const) {
        for (const contextDisplay of ["text", "bar"] as const) {
          const config = { ...presetConfig(preset), icons, contextDisplay };
          for (const width of [0, 1, 2, 5, 20, 40, 80, 120]) {
            for (const line of renderFooter(width, data, config, testTheme(appearance))) {
              assert.ok(visibleWidth(line) <= width, `${preset}/${icons}/${contextDisplay}/${width}: ${visibleWidth(line)}`);
              assert.ok(!line.includes("\n") && !line.includes("\x1b]"));
            }
          }
        }
      }
    }
  }
});

test("narrow layouts keep model and context ahead of cost and directory", () => {
  const config = presetConfig();
  config.segments.find((segment) => segment.id === "cost")!.enabled = true;
  const line = stripTerminalSequences(renderFooter(40, sampleSnapshot(), config, testTheme())[0]!);
  assert.match(line, /Example/);
  assert.match(line, /11\.9%/);
  assert.ok(!line.includes("0.120") && !line.includes("pi-packages"));
});

test("preset layout puts context immediately after the model", () => {
  const config = presetConfig();
  const line = stripTerminalSequences(renderFooter(200, sampleSnapshot(), config, testTheme())[0]!);
  assert.match(line, /^ Example model\(high\) \| ◉ \[█░░░░░░░░░\]11\.9% \| ▸ pi-packages/);
});

test("whole-cell context bars distinguish unknown, zero, low, full and overflow usage", () => {
  const data = sampleSnapshot();
  const config = presetConfig();
  config.contextDisplay = "bar";
  config.segments = [{ id: "context", enabled: true, icon: "" }];
  const rendered = (percent: number | null) => {
    data.context = { tokens: percent === null ? null : percent * 2000, contextWindow: 200000, percent };
    return stripTerminalSequences(renderFooter(100, data, config, testTheme())[0]!);
  };
  assert.equal(rendered(0), "[░░░░░░░░░░]0%");
  assert.equal(rendered(20), "[██░░░░░░░░]20%");
  assert.equal(rendered(25), "[███░░░░░░░]25%");
  assert.equal(rendered(4.7), "[█░░░░░░░░░]4.7%");
  assert.equal(rendered(0.1), "[█░░░░░░░░░]0.1%");
  assert.equal(rendered(100), "[██████████]100%");
  assert.equal(rendered(110), "[██████████]110%");
  assert.equal(rendered(null), "[??????????]?%");
  assert.equal(rendered(NaN), "[??????????]?%");
  config.icons = "ascii";
  assert.equal(rendered(4.7), "[#---------]4.7%");
  assert.equal(rendered(20), "[##--------]20%");
  assert.equal(rendered(100), "[##########]100%");
  assert.equal(rendered(null), "[??????????]?%");
});

test("unknown context, non-repositories and hidden extension statuses are unambiguous", () => {
  const data = sampleSnapshot();
  data.context = { tokens: null, contextWindow: 200000, percent: null };
  data.git.kind = "none";
  data.statuses = new Map();
  const config = presetConfig();
  config.contextDisplay = "text";
  const output = renderFooter(150, data, config, testTheme());
  assert.equal(output.length, 1);
  assert.match(stripTerminalSequences(output[0]!), /\?\/200k\(\?%\)/);
  assert.ok(!stripTerminalSequences(output[0]!).includes("main"));
  data.git.kind = "unknown";
  const text = stripTerminalSequences(renderFooter(150, data, config, testTheme())[0]!);
  assert.match(text, /main \?/);
  assert.ok(!text.includes("✓"));
});

test("threshold colors change only above 70 and 90 percent; explicit colors override presets", () => {
  const data = sampleSnapshot();
  const config = presetConfig();
  config.contextDisplay = "text";
  config.segments = [{ id: "context", enabled: true }];
  const theme = testTheme();
  const output = (percent: number) => { data.context.percent = percent; return renderFooter(100, data, config, theme)[0]!; };
  assert.ok(!output(70).includes(theme.style("", { fg: theme.colors.warning })));
  assert.ok(output(70.1).includes(theme.style("◉ ", { fg: theme.colors.warning })));
  assert.ok(output(90).includes(theme.style("◉ ", { fg: theme.colors.warning })));
  assert.ok(output(90.1).includes(theme.style("◉ ", { fg: theme.colors.error })));
  config.segments[0]!.color = "accent";
  assert.ok(output(95).includes(theme.style("◉ ", { fg: theme.colors.accent })));
  delete config.segments[0]!.color;
  config.contextDisplay = "bar";
  assert.ok(output(71).includes(theme.style("◉ ", { fg: theme.colors.warning })));
  assert.ok(output(91).includes(theme.style("◉ ", { fg: theme.colors.error })));
});

test("icons can be hidden and control characters never reach a terminal", () => {
  const config = presetConfig();
  config.icons = "ascii";
  config.segments = [{ id: "model", enabled: true, icon: "" }];
  assert.equal(stripTerminalSequences(renderFooter(100, sampleSnapshot(), config, testTheme())[0]!), "Example model");
  assert.equal(cleanText("a\r\nb\x1b[2J\x07"), "a  b");
});

test("last-component mode uses the raw model ID, while default mode preserves the friendly name", () => {
  const data = sampleSnapshot();
  data.model = "Friendly model name";
  data.modelId = "provider/a/b/c/d";
  const config = presetConfig();
  config.segments = [{ id: "model", enabled: true, icon: "" }];
  const rendered = () => stripTerminalSequences(renderFooter(100, data, config, testTheme())[0]!);
  assert.equal(rendered(), "Friendly model name");
  config.modelDisplay = "last";
  assert.equal(rendered(), "d");
  data.modelId = "standalone-model";
  assert.equal(rendered(), "standalone-model");
  data.modelId = "provider/a/d/";
  assert.equal(rendered(), "d");
  data.modelId = "";
  data.model = "No model";
  assert.equal(rendered(), "No model");
});

test("thinking is a colored model suffix, with no legacy icon or separator", () => {
  const data = sampleSnapshot();
  data.model = "demo";
  const config = presetConfig();
  config.segments = [
    { id: "thinking", enabled: true, icon: "OLD", background: "#ffffff" },
    { id: "model", enabled: true },
    { id: "directory", enabled: true },
  ];
  const theme = testTheme();
  const render = () => renderFooter(150, data, config, theme)[0]!;
  for (const [level, color] of [["off", "thinkingOff"], ["minimal", "thinkingMinimal"], ["low", "thinkingLow"], ["medium", "thinkingMedium"]] as const) {
    data.thinking = level;
    const line = render();
    assert.equal(stripTerminalSequences(line), ` demo(${level}) | ▸ pi-packages`);
    assert.ok(line.includes(theme.style(`(${level})`, { fg: theme.colors[color] })));
  }
  for (const level of ["high", "xhigh", "max"]) {
    data.thinking = level;
    const line = render();
    assert.equal(stripTerminalSequences(line), ` demo(${level}) | ▸ pi-packages`);
    assert.ok(line.includes(theme.style("(", { fg: parseColor("#c084fc") })));
    assert.ok(line.includes(theme.style(")", { fg: parseColor("#60a5fa") })));
  }
  data.thinking = "high";
  config.segments[0]!.color = "warning";
  assert.ok(render().includes(theme.style("(high)", { fg: theme.colors.warning })));
  config.segments[0]!.enabled = false;
  assert.equal(stripTerminalSequences(render()), " demo | ▸ pi-packages");
  config.segments[0]!.enabled = true;
  data.reasoning = false;
  assert.equal(stripTerminalSequences(render()), " demo | ▸ pi-packages");
  data.reasoning = true;
  config.segments[1]!.enabled = false;
  assert.equal(stripTerminalSequences(render()), "▸ pi-packages");
});

test("inline thinking preserves model backgrounds, short IDs, ASCII fallback and width limits", () => {
  const data = sampleSnapshot();
  data.modelId = "provider/a/b/c/d";
  const config = presetConfig("powerline");
  config.modelDisplay = "last";
  config.segments = [{ id: "model", enabled: true, background: "#112233" }, { id: "thinking", enabled: true }];
  const theme = testTheme();
  const line = renderFooter(100, data, config, theme)[0]!;
  assert.equal(stripTerminalSequences(line), "  d(high) ");
  assert.ok(line.includes(theme.style("(", { fg: parseColor("#c084fc"), bg: parseColor("#112233") })));
  assert.ok(line.includes(theme.style(")", { fg: parseColor("#60a5fa"), bg: parseColor("#112233") })));
  config.icons = "ascii";
  assert.equal(stripTerminalSequences(renderFooter(100, data, config, theme)[0]!), " d(high) ");
  for (const width of [1, 5, 10, 20, 40]) {
    for (const rendered of renderFooter(width, data, config, theme)) {
      assert.ok(visibleWidth(rendered) <= width);
      const text = stripTerminalSequences(rendered);
      assert.equal(text.includes("(high"), text.includes("(high)"));
    }
  }
});

test("rainbow thinking keeps distinct hues even when a theme uses one semantic color", () => {
  const data = sampleSnapshot();
  const config = presetConfig();
  config.segments = [{ id: "model", enabled: true }, { id: "thinking", enabled: true }];
  const theme = testTheme();
  const yellow = parseColor("#facc15");
  const flatTheme = {
    ...theme,
    colors: { ...theme.colors, thinkingHigh: yellow, accent: yellow, warning: yellow, success: yellow, thinkingMedium: yellow, thinkingLow: yellow },
  };
  for (const level of ["high", "xhigh", "max"]) {
    data.thinking = level;
    const suffixColors: unknown[] = [];
    const recordedTheme = {
      ...flatTheme,
      style: (text: string, options: Parameters<typeof theme.style>[1]) => {
        if (text.length === 1 && `(${level})`.includes(text)) suffixColors.push(options.fg);
        return theme.style(text, options);
      },
    };
    renderFooter(120, data, config, recordedTheme);
    assert.equal(suffixColors.length, level.length + 2);
    assert.equal(new Set(suffixColors.map((value) => JSON.stringify(value))).size, level.length + 2);
  }
});
