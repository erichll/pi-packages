import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { validatePublicHostname } from "./network-policy.mjs";

const pendingNetwork = new Map();
let target;

process.on("message", (message) => {
  if (!isNetworkResponse(message)) return;
  const resolve = pendingNetwork.get(message.id);
  if (!resolve) return;
  pendingNetwork.delete(message.id);
  resolve(message.action === "allow");
});

process.once("disconnect", () => {
  if (target?.pid !== undefined) {
    try {
      process.kill(target.pid, "SIGKILL");
    } catch {
      // The target already exited.
    }
  }
});

function isInitMessage(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.type === "init" &&
    Array.isArray(value.invocation) &&
    value.invocation.length > 0 &&
    value.invocation.every((item) => typeof item === "string") &&
    typeof value.runtimeConfig === "object" &&
    value.runtimeConfig !== null
  );
}

function isNetworkResponse(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.type === "network-response" &&
    typeof value.id === "string" &&
    (value.action === "allow" || value.action === "deny")
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function askNetwork(hostname, port) {
  if (!process.send || !process.connected) return false;
  const normalized = await validatePublicHostname(hostname);
  if (!normalized) return false;
  const id = randomUUID();
  return new Promise((resolve) => {
    pendingNetwork.set(id, resolve);
    process.send({
      type: "network-request",
      id,
      hostname: normalized,
      port,
    });
  });
}

async function main() {
  const [message] = await once(process, "message");
  if (!isInitMessage(message)) {
    throw new Error("received an invalid broker initialization message");
  }

  await SandboxManager.initialize(
    message.runtimeConfig,
    ({ host, port }) => askNetwork(host, port ?? 443),
    false,
  );

  const command = message.invocation.map(shellQuote).join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/bash",
    undefined,
    undefined,
    process.cwd(),
  );
  const workerTempDir = process.env.PI_SANDBOX_EXTERNAL_WORKER_TMPDIR;
  target = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: process.cwd(),
    env: workerTempDir
      ? { ...wrapped.env, TMPDIR: workerTempDir, TMP: workerTempDir, TEMP: workerTempDir }
      : wrapped.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(target.stdin);
  target.stdout.pipe(process.stdout);
  target.stderr.pipe(process.stderr);

  const exitCode = await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.once("exit", resolve);
  });
  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();
  process.exitCode = exitCode ?? 1;
  process.stdin.unpipe();
  process.stdin.pause();
  process.disconnect();
}

main().catch(async (error) => {
  process.stderr.write(
    `pi-sandbox: Sandbox Runtime broker failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  try {
    await SandboxManager.reset();
  } catch {
    // Best-effort cleanup after initialization failures.
  }
  process.exitCode = 1;
  process.stdin.unpipe();
  process.stdin.pause();
  if (process.connected) process.disconnect();
});
