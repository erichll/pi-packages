import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getPiSandboxConfigPath,
  loadPiSandboxConfig,
  parsePiSandboxConfig,
} from "../src/config.ts";

test("uses the trusted global configuration path", () => {
  assert.equal(
    getPiSandboxConfigPath("/trusted-home"),
    "/trusted-home/.pi/agent/pi-sandbox.json",
  );
});

test("defaults to the builtin provider when configuration is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  try {
    assert.deepEqual(loadPiSandboxConfig({ path: join(root, "missing.json") }), {
      subagents: { provider: "builtin" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts every supported subagent provider", () => {
  for (const provider of ["builtin", "pi-subagents", "off"] as const) {
    assert.deepEqual(
      parsePiSandboxConfig({ subagents: { provider } }),
      { subagents: { provider } },
    );
  }
});

test("defaults an omitted provider to builtin", () => {
  assert.deepEqual(parsePiSandboxConfig({}), {
    subagents: { provider: "builtin" },
  });
  assert.deepEqual(parsePiSandboxConfig({ subagents: {} }), {
    subagents: { provider: "builtin" },
  });
});

test("rejects invalid providers and unknown keys", () => {
  assert.throws(
    () => parsePiSandboxConfig({ subagents: { provider: "automatic" } }),
    /subagents\.provider must be one of builtin, pi-subagents, off/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ provider: "off" }),
    /unknown root key: provider/,
  );
  assert.throws(
    () =>
      parsePiSandboxConfig({
        subagents: { provider: "off", enabled: false },
      }),
    /unknown subagents key: enabled/,
  );
});

test("rejects malformed configuration instead of using defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const path = join(root, "pi-sandbox.json");
  try {
    writeFileSync(path, '{"subagents":', "utf8");
    assert.throws(
      () => loadPiSandboxConfig({ path }),
      /invalid JSON in pi-sandbox configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
