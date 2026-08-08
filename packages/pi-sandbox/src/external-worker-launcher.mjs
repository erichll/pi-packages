#!/usr/bin/env node
// Public PI_SUBAGENT_PI_BINARY wrapper. It deliberately has no host fallback:
// failure to initialize the broker prevents the worker from starting.
import { fork } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const realPi = process.env.PI_SANDBOX_EXTERNAL_REAL_PI_BINARY;
const workerId = randomUUID();

function worktreeGitReadPaths(cwd) {
  const dotGit = join(cwd, ".git");
  try {
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!pointer) return [];
    const gitDir = resolve(cwd, pointer);
    const paths = [gitDir];
    try {
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (common) paths.push(resolve(gitDir, common));
    } catch { /* a direct worktree gitdir has no commondir */ }
    return paths;
  } catch {
    return [];
  }
}

function supervisorRequest(payload) {
  const socketPath = process.env.PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET;
  const capability = process.env.PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY;
  if (!socketPath || !capability) return Promise.resolve("deny");
  return new Promise((resolveAction) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (action) => { socket.destroy(); resolveAction(action === "allow" ? "allow" : "deny"); };
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => finish("deny"));
    socket.once("error", () => finish("deny"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || Buffer.byteLength(buffer, "utf8") > 16 * 1024) return;
      try { finish(JSON.parse(buffer.slice(0, newline)).action); } catch { finish("deny"); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      version: 1, capability, id: randomUUID(), ...payload,
    })}\n`));
  });
}
function registerWorker() {
  return supervisorRequest({ type: "register", workerId, cwd: process.cwd() });
}
function unregisterWorker() {
  return supervisorRequest({ type: "unregister", workerId, cwd: process.cwd() });
}
function askSupervisor(hostname, port) {
  return supervisorRequest({ type: "network", workerId, cwd: process.cwd(), hostname, port });
}

function createMandatoryDenyPlaceholders(cwd, agentDir) {
  // Sandbox Runtime protects these names unconditionally. Under an outer
  // bubblewrap it cannot create a missing bind target after the root becomes
  // read-only, so create only absent regular-file placeholders before broker
  // bootstrap and remove exactly those placeholders at wrapper exit.
  const created = [];
  const remember = (path, kind, content) => {
    const stat = lstatSync(path);
    created.push({ path, kind, content, dev: stat.dev, ino: stat.ino });
  };
  for (const name of [
    ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc",
    ".zprofile", ".profile", ".ripgreprc", ".mcp.json",
  ]) {
    const path = join(cwd, name);
    if (existsSync(path)) continue;
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      remember(path, "file", "");
    } catch {
      // Sandbox bootstrap will fail closed if a mandatory target is unusable.
    }
  }
  for (const directory of [".vscode", ".idea", ".claude/commands", ".claude/agents"]) {
    let path = cwd;
    for (const part of directory.split("/")) {
      path = join(path, part);
      if (existsSync(path)) continue;
      try {
        mkdirSync(path, { mode: 0o700 });
        remember(path, "directory");
      } catch {
        // Sandbox bootstrap will fail closed if a mandatory target is unusable.
        break;
      }
    }
  }
  // Keep the project-state directory available so denyWrite can bind missing
  // security files at their exact paths instead of masking the first missing
  // `.pi` component and preventing ordinary project-state creation.
  const projectState = join(cwd, ".pi");
  if (!existsSync(projectState)) {
    try {
      mkdirSync(projectState, { mode: 0o700 });
      remember(projectState, "directory");
    } catch {
      // Sandbox bootstrap will fail closed if the directory remains unusable.
    }
  }
  // The agent directory sits below denyRead(home). Bubblewrap cannot create a
  // missing nested bind target there after the home mask becomes read-only, so
  // seed valid empty JSON files and remove only unchanged placeholders later.
  for (const name of ["settings.json", "permissions.json", "sandbox.json"]) {
    const path = join(agentDir, name);
    if (existsSync(path)) continue;
    try {
      writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 });
      remember(path, "file", "{}\n");
    } catch {
      // Sandbox bootstrap will fail closed if a protected target is unusable.
    }
  }
  return () => {
    for (const item of created.reverse()) {
      try {
        const current = lstatSync(item.path);
        if (current.dev !== item.dev || current.ino !== item.ino) continue;
        if (item.kind === "directory") rmdirSync(item.path);
        else if (readFileSync(item.path, "utf8") === item.content) unlinkSync(item.path);
      } catch { /* remove only unchanged empty placeholders */ }
    }
  };
}
if (!realPi) {
  process.stderr.write("pi-sandbox: external worker wrapper has no verified Pi binary\n");
  process.exitCode = 1;
} else {
  const cwd = process.cwd();
  const workerTempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-external-worker-"));
  process.once("exit", () => {
    try { rmSync(workerTempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });
  const home = resolve(homedir());
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"));
  const removeMandatoryDenyPlaceholders = createMandatoryDenyPlaceholders(cwd, agentDir);
  process.once("exit", removeMandatoryDenyPlaceholders);
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const nodeRoot = dirname(dirname(process.execPath));
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))));
  const extraRead = (process.env.PI_SANDBOX_EXTERNAL_ALLOW_READ || "")
    .split(":")
    .filter(Boolean);
  const existingGitConfig = [
    join(home, ".gitconfig"),
    join(home, ".config", "git", "config"),
  ].filter(existsSync);
  // On Linux Sandbox Runtime masks the first missing component of a deny path.
  // Denying a not-yet-created `.pi/settings.json` would therefore mask `.pi`
  // itself and prevent Pi from creating its ordinary project state directory.
  // Existing security files remain outer-sandbox protected; creation attempts
  // are still gated by permission-system and pi-auto-review.
  const workspaceSecurityFiles = [
    join(cwd, ".pi", "settings.json"),
    join(cwd, ".pi", "sandbox.json"),
    join(cwd, ".pi", "pi-auto-review.json"),
  ];
  const agentSecurityPaths = [
    join(agentDir, "settings.json"),
    join(agentDir, "permissions.json"),
    join(agentDir, "sandbox.json"),
    join(agentDir, "extensions"),
  ];
  const runtimeConfig = {
    filesystem: {
      denyRead: home === parse(home).root ? [] : [home],
      allowRead: [cwd, nodeRoot, runtimeRoot, ...existingGitConfig, "/dev/null", ...worktreeGitReadPaths(cwd), ...extraRead],
      // Child sessions and permission-forwarding request/response files live
      // here. Keep this narrower than the agent directory, whose security
      // settings and extensions remain read-only.
      allowWrite: [
        cwd,
        "/dev/null",
        workerTempDir,
        ...(sessionDir?.startsWith("/") ? [sessionDir] : []),
        // Pi creates directory-style settings locks and provider model caches
        // beside its global settings. Security-sensitive files and extensions
        // below remain explicit denyWrite entries.
        agentDir,
      ],
      denyWrite: [
        ...workspaceSecurityFiles,
        ...agentSecurityPaths,
        packageRoot,
        dirname(process.execPath),
      ],
      allowGitConfig: true,
    },
    network: {
      allowedDomains: [], deniedDomains: [], allowLocalBinding: false,
      allowAllUnixSockets: false, allowUnixSockets: [],
    },
  };
  const registration = await registerWorker();
  if (registration !== "allow") {
    process.stderr.write("pi-sandbox: external worker registration was denied\n");
    process.exitCode = 1;
    process.exit();
  }
  const broker = fork(new URL("./srt-broker.mjs", import.meta.url), [], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      PI_SANDBOX_EXTERNAL_WORKER_TMPDIR: workerTempDir,
      CLAUDE_CODE_TMPDIR: workerTempDir,
      TMPDIR: workerTempDir,
      TMP: workerTempDir,
      TEMP: workerTempDir,
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  broker.stdout.pipe(process.stdout);
  broker.stderr.pipe(process.stderr);
  process.stdin.pipe(broker.stdin);
  broker.on("message", (message) => {
    if (!message || typeof message !== "object" || message.type !== "network-request") return;
    void askSupervisor(message.hostname, message.port).then((action) => {
      if (broker.connected) broker.send({ type: "network-response", id: message.id, action });
    });
  });
  let prefix = [];
  try { prefix = JSON.parse(process.env.PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX || "[]"); } catch { prefix = []; }
  if (!Array.isArray(prefix) || prefix.some((item) => typeof item !== "string")) {
    process.stderr.write("pi-sandbox: external worker wrapper received invalid Pi prefix\n");
    broker.kill("SIGKILL");
    process.exitCode = 1;
  } else {
    broker.send({ type: "init", invocation: [realPi, ...prefix, ...process.argv.slice(2)], runtimeConfig });
  }
  const stop = (signal) => {
    if (broker.pid) {
      try { process.kill(-broker.pid, signal); } catch { broker.kill(signal); }
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  broker.once("exit", async (code, signal) => {
    await unregisterWorker();
    process.exitCode = code ?? (signal ? 1 : 1);
  });
  broker.once("error", (error) => {
    process.stderr.write(`pi-sandbox: external worker broker failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
