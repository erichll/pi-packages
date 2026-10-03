import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore, parseConfig, presetConfig } from "../src/config.ts";

test("partial configuration inherits a preset, while explicit segment lists preserve order and omissions", () => {
  const config = parseConfig({ preset: "powerline", segments: [{ id: "context", color: "warning" }, { id: "directory", icon: "" }] });
  assert.equal(config.preset, "powerline");
  assert.equal(config.modelDisplay, "name");
  assert.equal(config.contextDisplay, "bar");
  assert.equal(parseConfig({ contextDisplay: "text" }).contextDisplay, "text");
  assert.throws(() => parseConfig({ contextDisplay: "invalid" }));
  assert.equal(parseConfig({ modelDisplay: "last" }).modelDisplay, "last");
  assert.throws(() => parseConfig({ modelDisplay: "invalid" }));
  assert.deepEqual(config.segments.slice(0, 2).map((segment) => segment.id), ["context", "directory"]);
  assert.equal(config.segments[1]?.icon, "");
  assert.equal(config.segments.find((segment) => segment.id === "model")?.enabled, false);
  assert.equal(presetConfig().segments.find((segment) => segment.id === "cost")?.enabled, false);
  assert.equal(presetConfig().contextDisplay, "bar");
  assert.equal(parseConfig({ segments: [{ id: "cost", enabled: true }] }).segments.find((segment) => segment.id === "cost")?.enabled, true);
});

test("powerline defaults match the shipped example configuration", async () => {
  const example = parseConfig(JSON.parse(await readFile(new URL("../examples/statusline.json", import.meta.url), "utf8")));
  assert.deepEqual(parseConfig({ preset: "powerline" }), presetConfig());
  assert.deepEqual(presetConfig(), example);
  assert.deepEqual(parseConfig({}), example);
  assert.equal(example.preset, "powerline"); assert.equal(example.icons, "nerd");
  assert.equal(example.separator, "powerline"); assert.equal(example.modelDisplay, "name");
  assert.equal(example.pathMode, "basename"); assert.equal(example.contextDisplay, "bar");
  assert.deepEqual(example.segments.filter(s => s.enabled).map(s => s.id), ["model", "thinking", "context", "directory", "git", "tokens", "statuses"]);
});

test("removed presets are rejected without migration", () => {
  for (const preset of ["minimal", "unknown"]) {
    assert.throws(() => parseConfig({ preset }), /Invalid preset/);
    assert.throws(() => parseConfig({ preset, icons: "ascii", segments: [{ id: "model", enabled: true }] }), /Invalid preset/);
  }
});

test("invalid data cannot reach the renderer or introduce terminal control sequences", () => {
  for (const raw of [null, [], { version: 2 }, { enabled: "yes" }, { icons: "automatic" }, { segments: [{ id: "unknown" }] }, { segments: [{ id: "git" }, { id: "git" }] }, { segments: [{ id: "model", color: "blurple" }] }, { segments: [{ id: "model", background: "#fff" }] }, { segments: [{ id: "model", icon: "\x1b[2J" }] }]) {
    assert.throws(() => parseConfig(raw));
  }
  assert.equal(parseConfig({ segments: [{ id: "model", icon: "😀", background: "#334455" }] }).segments[0]?.icon, "😀");
  assert.equal(parseConfig({ segments: [{ id: "model", icon: "👩‍💻" }] }).segments[0]?.icon, "👩‍💻");
});

test("atomic saves round-trip; corrupt reloads retain the last configuration and warn once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-config-"));
  try {
    const configDir = join(dir, "extensions", "pi-statusline");
    const file = join(configDir, "config.json");
    const store = new ConfigStore(file);
    assert.deepEqual((await store.load()).config, presetConfig());
    const config = presetConfig();
    config.modelDisplay = "last";
    config.contextDisplay = "text";
    await store.save(config);
    assert.deepEqual((await store.load()).config, config);
    await writeFile(file, "{");
    const broken = await store.load(config);
    assert.ok(broken.warning);
    assert.strictEqual(broken.config, config);
    assert.equal((await store.load(config)).warning, undefined);
    assert.equal(await readFile(file, "utf8"), "{");
    await store.save(config);
    assert.equal((await store.load()).warning, undefined);
    assert.deepEqual(await readdir(configDir), ["config.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed writes keep the existing destination and clean temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-config-fail-"));
  try {
    const target = join(dir, "config.json");
    await mkdir(target);
    await writeFile(join(target, "keep"), "original");
    await assert.rejects(new ConfigStore(target).save(presetConfig()));
    assert.equal(await readFile(join(target, "keep"), "utf8"), "original");
    assert.deepEqual(await readdir(dir), ["config.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime partial configuration inherits defaults and rejects invalid known values", () => {
  const config = parseConfig({ version: 1, runtime: { tools: false, noContentSeconds: 20 } });
  assert.equal(config.runtime.tools, false); assert.equal(config.runtime.noContentSeconds, 20);
  assert.equal(config.runtime.avg, true);
  assert.deepEqual(parseConfig({ version: 1 }).runtime, presetConfig().runtime);
  for (const raw of [{ runtime: [] }, { runtime: { avg: "true" } }, ...[0, -1, 1.5, 3601, NaN, Infinity, "10"].map((n) => ({ runtime: { noContentSeconds: n } }))]) assert.throws(() => parseConfig(raw));
  assert.equal(parseConfig({ runtime: { noContentSeconds: 1 } }).runtime.noContentSeconds, 1);
  assert.equal(parseConfig({ runtime: { noContentSeconds: 3600 } }).runtime.noContentSeconds, 3600);
});

test("obsolete configuration keys are ignored and not saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "statusline-obsolete-"));
  try {
    const config = parseConfig({ version: 1, runtime: { tools: false, untilCompact: true }, providerMetrics: { duration: true }, integrations: { cliproxyapi: "on" } });
    assert.equal(config.runtime.tools, false);
    assert.ok(!("untilCompact" in config.runtime));
    assert.ok(!("providerMetrics" in config) && !("integrations" in config));
    const path = join(dir, "config.json"); await new ConfigStore(path).save(config);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.ok(!("providerMetrics" in saved) && !("integrations" in saved));
    assert.ok(!("untilCompact" in saved.runtime));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
