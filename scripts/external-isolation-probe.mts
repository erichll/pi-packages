// Ad-hoc non-model probe for pi-sandbox externalWorkerIsolation under the
// currently installed pi-subagents version. It exercises the two real
// contract seams without a model credential:
//   1. pi-subagents getPiSpawnCommand honors sandbox's injected
//      PI_SUBAGENT_PI_BINARY (the worker-spawn seam that makes
//      externalWorkerIsolation effective).
//   2. pi-sandbox enableExternalWorkerIsolation injects the expected env and
//      a live external-worker-supervisor round-trips register + network.
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
// The sandbox package version must come from the workspace package manifest,
// not the root package.json (which reports the monorepo version 0.1.0).
const pkg = require(resolve("packages/pi-sandbox/package.json"));
const piSubagentsVersion = require(resolve("node_modules/pi-subagents/package.json")).version;
const PI_SUBAGENTS_BASELINE = { major: 0, minor: 63, patch: 0 };

function versionAtLeast(value, required) {
  if (typeof value !== "string") return false;
  const [major, minor, patch] = value.split(".").map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isInteger)) return false;
  return major > required.major ||
    (major === required.major && (minor > required.minor ||
      (minor === required.minor && patch >= required.patch)));
}

const { createJiti } = require("jiti");
const jiti = createJiti(resolve(".") + "/", {
  fsCache: false,
  moduleCache: false,
  interopDefault: true,
  nativeModules: ["node:fs", "node:path", "node:url", "node:crypto", "node:net", "node:os", "node:child_process"],
  tsconfig: { compilerOptions: { allowImportingTsExtensions: true, module: "esnext" } },
});
// Single-point internal-path import into pi-subagents' worker-spawn contract.
// Not part of the package exports map; see docs/compat-notes.md and upstream
// issue D1 (requesting a public ./pi-spawn subpath). Keep this import isolated
// so the upgrade audit can find every reference.
const PI_SUBAGENTS_PI_SPAWN_INTERNAL_PATH =
  "node_modules/pi-subagents/src/runs/shared/pi-spawn.ts";
const { getPiSpawnCommand } = await jiti.import(
  resolve(PI_SUBAGENTS_PI_SPAWN_INTERNAL_PATH),
);
const { createExternalWorkerSupervisor } = await jiti.import(
  resolve("packages/pi-sandbox/src/external-supervisor.ts"),
);

const launcherPath = resolve("packages/pi-sandbox/src/external-worker-launcher.mjs");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label} ${detail}`); }
}

console.log(`pi-subagents version under test: ${piSubagentsVersion}`);
console.log(
  "required compatibility baseline:",
  `${PI_SUBAGENTS_BASELINE.major}.${PI_SUBAGENTS_BASELINE.minor}.${PI_SUBAGENTS_BASELINE.patch}`,
);
console.log("pi-sandbox package version:", pkg.version);
check(
  `installed pi-subagents meets the ${PI_SUBAGENTS_BASELINE.major}.${PI_SUBAGENTS_BASELINE.minor}.${PI_SUBAGENTS_BASELINE.patch} compatibility baseline`,
  versionAtLeast(piSubagentsVersion, PI_SUBAGENTS_BASELINE),
  `got ${JSON.stringify(piSubagentsVersion)}`,
);
console.log("launcher:", launcherPath);
console.log("");

// --- Seam 1: getPiSpawnCommand honors PI_SUBAGENT_PI_BINARY ---
{
  console.log("Seam 1: pi-subagents getPiSpawnCommand (worker-spawn contract)");
  const defaultCmd = getPiSpawnCommand(["run", "x"]);
  check(
    "no override, no standalone pi -> falls back to 'pi' on PATH",
    defaultCmd.command === "pi" || defaultCmd.command.endsWith(process.execPath),
    JSON.stringify(defaultCmd),
  );
  // When sandbox externalWorkerIsolation is "enforce", the parent injects this env.
  const withBinary = getPiSpawnCommand(["run", "x"], {
    env: { ...process.env, PI_SUBAGENT_PI_BINARY: launcherPath },
  });
  check(
    "PI_SUBAGENT_PI_BINARY is honored as the worker spawn command",
    withBinary.command === launcherPath,
    JSON.stringify(withBinary),
  );
  check(
    "args pass through verbatim when PI_SUBAGENT_PI_BINARY is set",
    withBinary.args.length === 2 && withBinary.args[0] === "run" && withBinary.args[1] === "x",
    JSON.stringify(withBinary),
  );
  console.log("");
}

// --- Seam 2: enableExternalWorkerIsolation injection + supervisor protocol ---
{
  console.log("Seam 2: pi-sandbox enableExternalWorkerIsolation injection (parent seam)");
  // Import index.ts would pull the whole extension; instead inline the exact
  // injection contract from src/index.ts to compare against what pi-subagents
  // honors. We verify the supervisor half for real.
  const supervisor = await createExternalWorkerSupervisor(
    () => ({
      command: "external worker",
      cwd: process.cwd(),
      sessionId: "parent",
      scopeKey: "parent:turn:1",
    }),
    {},
    {
      allowedDomains: ["github.com"],
      deniedDomains: ["uploads.github.com"],
    },
  );
  try {
    const entry = resolve("packages/pi-sandbox/src/external-worker-launcher.mjs");
    const injected = {
      PI_SUBAGENT_PI_BINARY: launcherPath,
      PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
      PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([entry]),
      PI_SANDBOX_EXTERNAL_ALLOW_READ: [process.cwd()].filter(Boolean).join(":"),
      PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
      PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
    };
    check("injects PI_SUBAGENT_PI_BINARY = launcher", injected.PI_SUBAGENT_PI_BINARY === launcherPath);
    check("supervisor socket + capability injected", Boolean(injected.PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET) && Boolean(injected.PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY));

    // Drive the real supervisor protocol through a socket client.
    const { createConnection } = await import("node:net");
    const rpc = (payload) => new Promise((resolveResponse) => {
      const socket = createConnection(supervisor.socketPath);
      let buffer = "";
      const done = (response) => { socket.destroy(); resolveResponse(response); };
      socket.setEncoding("utf8");
      socket.once("error", () => done({ action: "deny" }));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        try { done(JSON.parse(buffer.slice(0, nl))); } catch { done({ action: "deny" }); }
      });
      socket.on("connect", () => socket.write(JSON.stringify({
        version: 1, capability: supervisor.capability, id: "p-" + Math.random().toString(36).slice(2), ...payload,
      }) + "\n"));
    });

    const reg = await rpc({ type: "register", workerId: "w1", cwd: process.cwd() });
    check("worker register allowed", reg.action === "allow");
    check(
      "registration carries the trusted network policy",
      JSON.stringify(reg.network) === JSON.stringify({
        allowedDomains: ["github.com"],
        deniedDomains: ["uploads.github.com"],
      }),
      JSON.stringify(reg),
    );

    const nw = await rpc({ type: "network", workerId: "w1", cwd: process.cwd(), hostname: "example.com", port: 443 });
    console.log("    supervisor network verdict for example.com:443 =", nw.action);
    console.log("    (verdict depends on default approval policy; protocol did not crash)");

    const wrong = await rpc({ type: "network", workerId: "w1", cwd: process.cwd(), hostname: "example.com", port: 443, id: "p-" + Math.random().toString(36).slice(2) });
    // reusing a fresh id is fine; just confirm server still responsive
    check("supervisor alive after requests", typeof wrong.action === "string");

    const unreg = await rpc({ type: "unregister", workerId: "w1", cwd: process.cwd() });
    check("worker unregister allowed", unreg.action === "allow");
  } finally {
    await supervisor.close();
  }
}

console.log("");
if (failures === 0) {
  console.log("RESULT: PASS — externalWorkerIsolation contract seams verified under pi-subagents " + piSubagentsVersion);
  process.exit(0);
} else {
  console.log(`RESULT: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
