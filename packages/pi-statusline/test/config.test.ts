import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore, parseConfig, presetConfig } from "../src/config.ts";

test("partial configuration inherits a preset, while explicit segment lists preserve order and omissions", () => {
  const config = parseConfig({ preset: "minimal", segments: [{ id: "context", color: "warning" }, { id: "directory", icon: "" }] });
  assert.equal(config.preset, "minimal");
  assert.equal(config.modelDisplay, "name");
  assert.equal(config.contextDisplay, "bar");
  assert.equal(parseConfig({ contextDisplay: "text" }).contextDisplay, "text");
  assert.throws(() => parseConfig({ contextDisplay: "invalid" }));
  assert.equal(parseConfig({ modelDisplay: "last" }).modelDisplay, "last");
  assert.throws(() => parseConfig({ modelDisplay: "invalid" }));
  assert.deepEqual(config.segments.slice(0, 2).map((segment) => segment.id), ["context", "directory"]);
  assert.equal(config.segments[1]?.icon, "");
  assert.equal(config.segments.find((segment) => segment.id === "model")?.enabled, false);
  for (const preset of ["cometix", "minimal", "powerline"] as const) {
    assert.equal(presetConfig(preset).segments.find((segment) => segment.id === "cost")?.enabled, false);
    assert.equal(presetConfig(preset).contextDisplay, "bar");
  }
  assert.equal(parseConfig({ segments: [{ id: "cost", enabled: true }] }).segments.find((segment) => segment.id === "cost")?.enabled, true);
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
    const config = presetConfig("powerline");
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
