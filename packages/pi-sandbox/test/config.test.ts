import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getPiSandboxConfigPath,
  getProjectPiSandboxConfigPath,
  loadPiSandboxConfig,
  mergePiSandboxConfigs,
  parsePiSandboxConfig,
  parsePiSandboxConfigRaw,
  PROJECT_PI_SANDBOX_CONFIG_PATH,
} from "../src/config.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultHostIPC = {
  mode: "off" as const,
  preflightCommandPrefixes: [] as string[],
  retryOnUnixSocketError: false,
};
const defaultNetwork = {
  allowedDomains: [] as string[],
  deniedDomains: [] as string[],
  strictAllowlist: false,
};

function makeTempRoot(prefix: string): string {
  const parent = join(packageRoot, ".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

test("uses the trusted extension-local configuration path and project path", () => {
  assert.equal(
    getPiSandboxConfigPath("/trusted-home"),
    "/trusted-home/.pi/agent/extensions/pi-sandbox/config.json",
  );
  assert.equal(
    PROJECT_PI_SANDBOX_CONFIG_PATH,
    join(".pi", "extensions", "pi-sandbox", "config.json"),
  );
  assert.equal(
    getProjectPiSandboxConfigPath("/workspace"),
    join("/workspace", ".pi", "extensions", "pi-sandbox", "config.json"),
  );
});

test("defaults to the builtin provider when configuration is absent", () => {
  const root = makeTempRoot("pi-sandbox-config-");
  try {
    assert.deepEqual(loadPiSandboxConfig({ path: join(root, "missing.json") }), {
      subagents: { provider: "builtin" },
      filesystem: { additionalAllowRead: [] },
      network: defaultNetwork,
      hostIPC: defaultHostIPC,
    });
    assert.deepEqual(loadPiSandboxConfig({ home: root, cwd: root }), {
      subagents: { provider: "builtin" },
      filesystem: { additionalAllowRead: [] },
      network: defaultNetwork,
      hostIPC: defaultHostIPC,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads the extension-local config and supports project-level config merge", () => {
  const root = makeTempRoot("pi-sandbox-config-load-");
  const workspace = makeTempRoot("pi-sandbox-project-");
  try {
    const modernPath = getPiSandboxConfigPath(root);
    mkdirSync(dirname(modernPath), { recursive: true });
    writeFileSync(
      modernPath,
      JSON.stringify({
        subagents: { provider: "off" },
        filesystem: {
          additionalAllowRead: ["/opt/global-bin"],
        },
        network: {
          allowedDomains: ["github.com"],
          deniedDomains: ["uploads.github.com"],
        },
      }),
      "utf8",
    );
    assert.deepEqual(loadPiSandboxConfig({ home: root, cwd: workspace }), {
      subagents: { provider: "off" },
      filesystem: { additionalAllowRead: ["/opt/global-bin"] },
      network: {
        allowedDomains: ["github.com"],
        deniedDomains: ["uploads.github.com"],
        strictAllowlist: false,
      },
      hostIPC: defaultHostIPC,
    });

    const projectPath = getProjectPiSandboxConfigPath(workspace);
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(
      projectPath,
      JSON.stringify({
        filesystem: {
          additionalAllowRead: ["/home/erich/.pi", "/opt/global-bin"],
        },
        network: {
          allowedDomains: ["api.example.com", "github.com"],
        },
        hostIPC: {
          mode: "ask",
          preflightCommandPrefixes: ["tmux"],
          retryOnUnixSocketError: true,
        },
      }),
      "utf8",
    );

    const merged = loadPiSandboxConfig({ home: root, cwd: workspace });
    assert.deepEqual(merged, {
      subagents: { provider: "off" },
      filesystem: {
        additionalAllowRead: ["/opt/global-bin", "/home/erich/.pi"],
      },
      network: {
        allowedDomains: ["github.com", "api.example.com"],
        deniedDomains: ["uploads.github.com"],
        strictAllowlist: false,
      },
      hostIPC: {
        mode: "ask",
        preflightCommandPrefixes: ["tmux"],
        retryOnUnixSocketError: true,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("accepts builtin and off without external protection settings", () => {
  for (const provider of ["builtin", "off"] as const) {
    assert.deepEqual(
      parsePiSandboxConfig({ subagents: { provider } }),
      {
        subagents: { provider },
        filesystem: { additionalAllowRead: [] },
        network: defaultNetwork,
        hostIPC: defaultHostIPC,
      },
    );
  }
});

test("pi-subagents requires native background protection and a canonical whitelist", () => {
  assert.deepEqual(parsePiSandboxConfig({
    subagents: {
      provider: "pi-subagents",
      protection: "native-background-tools",
      allowedNativeAgents: ["worker", "reviewer", "scout"],
    },
  }).subagents, {
    provider: "pi-subagents",
    protection: "native-background-tools",
    allowedNativeAgents: ["worker", "reviewer", "scout"],
  });
  assert.throws(
    () => parsePiSandboxConfig({ subagents: { provider: "pi-subagents" } }),
    /requires subagents\.protection/,
  );
  for (const allowedNativeAgents of [[], ["worker", "worker"], [" worker"], ["bad/name"]]) {
    assert.throws(() => parsePiSandboxConfig({ subagents: {
      provider: "pi-subagents",
      protection: "native-background-tools",
      allowedNativeAgents,
    } }), /allowedNativeAgents/);
  }
  assert.throws(
    () => parsePiSandboxConfig({ subagents: { provider: "builtin", protection: "native-background-tools", allowedNativeAgents: ["worker"] } }),
    /only valid with provider 'pi-subagents'/,
  );
});

test("defaults omitted sections to their secure defaults", () => {
  assert.deepEqual(parsePiSandboxConfig({}), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    network: defaultNetwork,
    hostIPC: defaultHostIPC,
  });
  assert.deepEqual(parsePiSandboxConfig({ subagents: {} }), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    network: defaultNetwork,
    hostIPC: defaultHostIPC,
  });
  assert.deepEqual(parsePiSandboxConfig({ filesystem: {} }), {
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: [] },
    network: defaultNetwork,
    hostIPC: defaultHostIPC,
  });
  const first = parsePiSandboxConfig({});
  const second = parsePiSandboxConfig({});
  assert.notStrictEqual(first.network.allowedDomains, second.network.allowedDomains);
  assert.notStrictEqual(first.network.deniedDomains, second.network.deniedDomains);
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
      network: defaultNetwork,
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
      network: defaultNetwork,
      hostIPC: {
        mode: "ask",
        preflightCommandPrefixes: ["tmux", "/usr/bin/tmux"],
        retryOnUnixSocketError: true,
      },
    },
  );
});

test("accepts, trims, and deduplicates network domain policies", () => {
  assert.deepEqual(
    parsePiSandboxConfig({
      network: {
        allowedDomains: [" github.com ", "github.com", "*.github.com:443"],
        deniedDomains: ["uploads.github.com", " *:22 ", "uploads.github.com"],
      },
    }).network,
    {
      allowedDomains: ["github.com", "*.github.com:443"],
      deniedDomains: ["uploads.github.com", "*:22"],
      strictAllowlist: false,
    },
  );
});

test("strict allowlist is an opt-in boolean and raw parsing preserves omission", () => {
  assert.deepEqual(parsePiSandboxConfigRaw({ network: {} }), { network: {} });
  assert.equal(parsePiSandboxConfig({}).network.strictAllowlist, false);
  for (const strictAllowlist of [false, true]) {
    assert.equal(
      parsePiSandboxConfig({ network: { strictAllowlist } }).network.strictAllowlist,
      strictAllowlist,
    );
  }
  for (const strictAllowlist of [null, 0, 1, "true", "false", [], {}]) {
    assert.throws(
      () => parsePiSandboxConfig({ network: { strictAllowlist } }),
      /network\.strictAllowlist must be a boolean/,
    );
  }
});

test("strict allowlist merges with OR while trusted domain lists remain unions", () => {
  for (const globalStrict of [undefined, false, true]) {
    for (const projectStrict of [undefined, false, true]) {
      const merged = mergePiSandboxConfigs(
        parsePiSandboxConfig({ network: {
          allowedDomains: ["global.example.com"], deniedDomains: ["*:22"],
          strictAllowlist: globalStrict,
        } }),
        parsePiSandboxConfigRaw({ network: {
          allowedDomains: ["project.example.com", "global.example.com"],
          deniedDomains: ["blocked.example.com"], strictAllowlist: projectStrict,
        } }),
      );
      assert.equal(merged.network.strictAllowlist, !!(globalStrict || projectStrict));
      assert.deepEqual(merged.network.allowedDomains, ["global.example.com", "project.example.com"]);
      assert.deepEqual(merged.network.deniedDomains, ["*:22", "blocked.example.com"]);
    }
  }
});

test("strict allowlist rejects host IPC only after all file layers are merged", () => {
  const root = makeTempRoot("pi-sandbox-strict-merge-");
  const workspace = join(root, "workspace");
  const globalPath = getPiSandboxConfigPath(root);
  const projectPath = getProjectPiSandboxConfigPath(workspace);
  mkdirSync(dirname(globalPath), { recursive: true });
  mkdirSync(dirname(projectPath), { recursive: true });
  const conflict = /strictAllowlist=true.*hostIPC\.mode="ask"/;
  try {
    const global = { network: { strictAllowlist: true }, hostIPC: { mode: "ask" } };
    writeFileSync(globalPath, JSON.stringify(global));
    assert.throws(() => parsePiSandboxConfig(global), conflict);
    assert.throws(() => loadPiSandboxConfig({ path: globalPath }), conflict);
    assert.throws(() => loadPiSandboxConfig({ home: root, cwd: workspace }), conflict);

    // A project may turn off host execution to satisfy the global strict policy.
    writeFileSync(projectPath, JSON.stringify({ hostIPC: { mode: "off" } }));
    const resolved = loadPiSandboxConfig({ home: root, cwd: workspace });
    assert.equal(resolved.network.strictAllowlist, true);
    assert.equal(resolved.hostIPC.mode, "off");

    writeFileSync(globalPath, JSON.stringify({ network: { strictAllowlist: true } }));
    writeFileSync(projectPath, JSON.stringify({
      network: { strictAllowlist: false }, hostIPC: { mode: "ask" },
    }));
    assert.throws(() => loadPiSandboxConfig({ home: root, cwd: workspace }), conflict);

    writeFileSync(globalPath, JSON.stringify({ hostIPC: { mode: "ask" } }));
    writeFileSync(projectPath, JSON.stringify({ network: { strictAllowlist: true } }));
    assert.throws(() => loadPiSandboxConfig({ home: root, cwd: workspace }), conflict);
    writeFileSync(projectPath, JSON.stringify({ network: { strictAllowlist: false } }));
    assert.equal(loadPiSandboxConfig({ home: root, cwd: workspace }).hostIPC.mode, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed or invalid network policies with a precise path", () => {
  for (const network of [
    [],
    { allowedDomains: "github.com" },
    { allowedDomains: [""] },
    { allowedDomains: [42] },
    { deniedDomains: ["https://example.com"] },
    { deniedDomains: ["*.com"] },
    { deniedDomains: ["bad host.example"] },
    { allowedDomains: ["bad..example.com"] },
    { allowedDomains: ["-bad.example.com"] },
    { allowedDomains: ["example_com.test"] },
    { allowedDomains: ["*"] },
    { allowedDomains: [], unexpected: [] },
  ]) {
    assert.throws(() => parsePiSandboxConfig({ network }), /network/);
  }
  assert.throws(
    () => parsePiSandboxConfig({ network: { allowedDomains: ["example.com:0"] } }),
    /network\.allowedDomains\[0\]/,
  );
  assert.throws(
    () => parsePiSandboxConfig({ network: { deniedDomains: ["example.com:65536"] } }),
    /network\.deniedDomains\[0\]/,
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
  const root = makeTempRoot("pi-sandbox-config-");
  const path = join(root, "config.json");
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

test("mergePiSandboxConfigs correctly merges array unions and scalar overrides", () => {
  const base = parsePiSandboxConfig({
    subagents: { provider: "builtin" },
    filesystem: { additionalAllowRead: ["/base/read"] },
    network: { allowedDomains: ["base.com"], deniedDomains: ["bad.base.com"] },
    hostIPC: { mode: "off", preflightCommandPrefixes: ["ls"], retryOnUnixSocketError: false },
  });
  const project = parsePiSandboxConfig({
    subagents: {
      provider: "pi-subagents",
      protection: "native-background-tools",
      allowedNativeAgents: ["worker"],
    },
    filesystem: { additionalAllowRead: ["/project/read", "/base/read"] },
    network: { allowedDomains: ["project.com"], deniedDomains: [] },
    hostIPC: { mode: "ask", preflightCommandPrefixes: ["tmux"], retryOnUnixSocketError: true },
  });

  const merged = mergePiSandboxConfigs(base, project);
  assert.equal(merged.subagents.provider, "pi-subagents");
  assert.equal(merged.subagents.protection, "native-background-tools");
  assert.deepEqual(merged.subagents.allowedNativeAgents, ["worker"]);
  assert.deepEqual(merged.filesystem.additionalAllowRead, ["/base/read", "/project/read"]);
  assert.deepEqual(merged.network.allowedDomains, ["base.com", "project.com"]);
  assert.deepEqual(merged.network.deniedDomains, ["bad.base.com"]);
  assert.equal(merged.hostIPC.mode, "ask");
  assert.deepEqual(merged.hostIPC.preflightCommandPrefixes, ["ls", "tmux"]);
  assert.equal(merged.hostIPC.retryOnUnixSocketError, true);
});
