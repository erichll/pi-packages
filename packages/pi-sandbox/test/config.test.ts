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

const defaultHostIPC = {
  mode: "off" as const,
  preflightCommandPrefixes: [] as string[],
  retryOnUnixSocketError: false,
};

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
      filesystem: { additionalAllowRead: [] },
      hostIPC: defaultHostIPC,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts every supported subagent provider", () => {
  for (const provider of ["builtin", "pi-subagents", "off"] as const) {
    assert.deepEqual(
      parsePiSandboxConfig({ subagents: { provider } }),
      {
        subagents: { provider },
        filesystem: { additionalAllowRead: [] },
        hostIPC: defaultHostIPC,
      },
    );
  }
});

test("defaults omitted sections to their secure defaults", () => {
  assert.deepEqual(parsePiSandboxConfig({}), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    hostIPC: defaultHostIPC,
  });
  assert.deepEqual(parsePiSandboxConfig({ subagents: {} }), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    hostIPC: defaultHostIPC,
  });
  assert.deepEqual(parsePiSandboxConfig({ filesystem: {} }), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    hostIPC: defaultHostIPC,
  });
});

test("accepts unique absolute additional read paths", () => {
  assert.deepEqual(
    parsePiSandboxConfig({
      filesystem: {
        additionalAllowRead: [
          "/home/user/.local/bin/rtk",
          "/home/user/.local/bin/rtk",
          "/opt/tools/helper",
        ],
      },
    }),
    {
      subagents: { provider: "builtin" },
      filesystem: {
        additionalAllowRead: [
          "/home/user/.local/bin/rtk",
          "/opt/tools/helper",
        ],
      },
      hostIPC: defaultHostIPC,
    },
  );
});

test("accepts and normalizes the host-IPC configuration", () => {
  assert.deepEqual(
    parsePiSandboxConfig({
      hostIPC: {
        mode: "ask",
        preflightCommandPrefixes: [
          " tmux ",
          "tmux",
          "/usr/bin/tmux",
        ],
        retryOnUnixSocketError: true,
      },
    }),
    {
      subagents: { provider: "builtin" },
      filesystem: { additionalAllowRead: [] },
      hostIPC: {
        mode: "ask",
        preflightCommandPrefixes: ["tmux", "/usr/bin/tmux"],
        retryOnUnixSocketError: true,
      },
    },
  );
});

test("rejects malformed or expansive host-IPC configuration", () => {
  for (const hostIPC of [
    [],
    { mode: "always" },
    { mode: true },
    { preflightCommandPrefixes: "tmux" },
    { preflightCommandPrefixes: [""] },
    { preflightCommandPrefixes: [42] },
    { retryOnUnixSocketError: "yes" },
    { mode: "ask", unknown: true },
  ]) {
    assert.throws(
      () => parsePiSandboxConfig({ hostIPC }),
      /hostIPC/,
    );
  }
});

test("rejects unsafe additional read path shapes", () => {
  for (const additionalAllowRead of [
    "not-an-array",
    ["relative/path"],
    [""],
    [42],
  ]) {
    assert.throws(
      () =>
        parsePiSandboxConfig({
          filesystem: { additionalAllowRead },
        }),
      /filesystem\.additionalAllowRead must be an array of absolute paths/,
    );
  }
  assert.throws(
    () =>
      parsePiSandboxConfig({
        filesystem: { additionalAllowRead: [], allowWrite: ["/tmp"] },
      }),
    /unknown filesystem key: allowWrite/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ filesystem: [] }),
    /filesystem must be an object/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ subagents: [] }),
    /subagents must be an object/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ filesystem: null }),
    /filesystem must be an object/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ subagents: null }),
    /subagents must be an object/,
  );
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
