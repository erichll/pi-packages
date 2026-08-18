import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createExternalWorkerSupervisor } from "../src/external-supervisor.ts";
import { sandboxRuntimeNetworkCapable } from "./srt-capable.ts";

const launcher = fileURLToPath(
  new URL("../src/external-worker-launcher.mjs", import.meta.url),
);
const sandboxTest = sandboxRuntimeNetworkCapable() ? test : test.skip;

function request(socketPath: string, value: Record<string, unknown>): Promise<{ action: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as { action: string });
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
  });
}

test("external supervisor supplies trusted policy and accepts only one capability-bound network request", async () => {
  let approvals = 0;
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: process.cwd(),
    sessionId: "parent",
    scopeKey: "parent:turn:1",
    broker: {
      async review() {
        approvals++;
        return {
          kind: "allow" as const,
          review: {
            outcome: "allow" as const,
            riskLevel: "low" as const,
            userAuthorization: "high" as const,
            rationale: "test",
          },
          grant: { token: "grant", requestHash: "hash", sessionId: "parent", expiresAt: Date.now(), usesRemaining: 1 },
        };
      },
      consumeGrant() { return true; },
    },
  }), {}, {
    allowedDomains: ["github.com"],
    deniedDomains: ["uploads.github.com"],
  });
  try {
    const registration = {
      version: 1,
      capability: supervisor.capability,
      id: "register-1",
      type: "register",
      workerId: "worker-1",
      cwd: process.cwd(),
    };
    const registered = await request(supervisor.socketPath, registration) as {
      action: string;
      network: { allowedDomains: string[]; deniedDomains: string[] };
    };
    assert.equal(registered.action, "allow");
    assert.deepEqual(registered.network, {
      allowedDomains: ["github.com"],
      deniedDomains: ["uploads.github.com"],
    });
    const valid = {
      ...registration,
      id: "request-1",
      type: "network",
      hostname: "example.com",
      port: 443,
    };
    assert.equal((await request(supervisor.socketPath, valid)).action, "allow");
    assert.equal(
      (await request(supervisor.socketPath, { ...valid, id: "wrong-cwd", cwd: "/unregistered" })).action,
      "deny",
    );
    assert.equal((await request(supervisor.socketPath, valid)).action, "deny");
    assert.equal(
      (await request(supervisor.socketPath, { ...valid, id: "request-2", capability: "wrong" })).action,
      "deny",
    );
    assert.equal(approvals, 1);
    assert.deepEqual(supervisor.workers(), [
      {
        id: "worker-1",
        cwd: process.cwd(),
        state: "active",
        startedAt: supervisor.workers()[0]!.startedAt,
        requests: 1,
      },
    ]);
    assert.equal(
      (await request(supervisor.socketPath, {
        ...registration,
        id: "unregister-1",
        type: "unregister",
      })).action,
      "allow",
    );
    assert.equal(supervisor.workers()[0]!.state, "exited");
  } finally {
    await supervisor.close();
  }
});

sandboxTest("external launcher wraps the complete worker process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-external-launcher-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const secret = join(root, "secret.txt");
  const worker = join(workspace, "worker.mjs");
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: workspace,
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  try {
    await mkdir(workspace);
    await mkdir(agentDir);
    await writeFile(secret, "not-readable", "utf8");
    await writeFile(worker, [
      'import { readFileSync } from "node:fs";',
      'process.stdout.write(readFileSync(process.env.TEST_SECRET, "utf8"));',
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [launcher], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        TEST_SECRET: secret,
        PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
        PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([worker]),
        PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
        PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.notEqual(code, 0);
    assert.doesNotMatch(stdout, /not-readable/);
    assert.match(stderr, /denied|sandbox|permission|EACCES/i);
  } finally {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  }
});

sandboxTest("external launcher permits Pi project-state creation in a new workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sandbox-external-project-state-"));
  const agentDir = join(workspace, ".agent");
  const worker = join(workspace, "worker.mjs");
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: workspace,
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  try {
    await mkdir(agentDir);
    await writeFile(worker, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync(".pi", { recursive: true });',
      'writeFileSync(".pi/runtime-state.json", "ok");',
      'process.stdout.write("state-created");',
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [launcher], {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
        PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([worker]),
        PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
        PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "state-created");
    assert.equal(existsSync(join(workspace, ".gitconfig")), false);
    assert.equal(existsSync(join(workspace, ".vscode")), false);
    assert.equal(existsSync(join(workspace, ".idea")), false);
    assert.equal(existsSync(join(workspace, ".claude")), false);
  } finally {
    await supervisor.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

sandboxTest("external launcher blocks first-time security configuration creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-external-security-create-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const worker = join(workspace, "worker.mjs");
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: workspace,
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  try {
    await mkdir(workspace);
    await mkdir(agentDir);
    await writeFile(worker, [
      'import { writeFileSync } from "node:fs";',
      'let writes = 0;',
      'for (const path of [".pi/settings.json", process.env.PI_CODING_AGENT_DIR + "/settings.json"]) {',
      '  try { writeFileSync(path, "{}"); writes++; } catch {}',
      '}',
      'process.stdout.write(String(writes));',
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [launcher], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
        PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([worker]),
        PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
        PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "0");
    assert.equal(existsSync(join(workspace, ".pi")), false);
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  } finally {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  }
});

sandboxTest("external launcher permits read-only Git worktree metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-external-worktree-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  const agentDir = join(root, "agent");
  const worker = join(worktree, "worker.mjs");
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: worktree,
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  try {
    await mkdir(repository);
    await mkdir(agentDir);
    execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "tracked\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "sandbox-test", worktree], { cwd: repository, stdio: "ignore" });
    await writeFile(worker, [
      'import { spawnSync } from "node:child_process";',
      'const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });',
      'process.stdout.write(result.stdout); process.exitCode = result.status ?? 1;',
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [launcher], {
      cwd: worktree,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
        PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([worker]),
        PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
        PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, stderr);
  } finally {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  }
});

sandboxTest("external launcher preserves the wrapper for nested child launches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sandbox-external-nested-"));
  const agentDir = join(workspace, ".agent");
  const worker = join(workspace, "worker.mjs");
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: workspace,
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  try {
    await mkdir(agentDir);
    await writeFile(
      worker,
      'process.stdout.write(process.env.PI_SUBAGENT_PI_BINARY || "missing");',
      "utf8",
    );
    const child = spawn(process.execPath, [launcher], {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SANDBOX_EXTERNAL_REAL_PI_BINARY: process.execPath,
        PI_SANDBOX_EXTERNAL_REAL_PI_PREFIX: JSON.stringify([worker]),
        PI_SANDBOX_EXTERNAL_SUPERVISOR_SOCKET: supervisor.socketPath,
        PI_SANDBOX_EXTERNAL_SUPERVISOR_CAPABILITY: supervisor.capability,
        PI_SUBAGENT_PI_BINARY: launcher,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0);
    assert.equal(stdout, launcher);
  } finally {
    await supervisor.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("closed external supervisor rejects new worker registration", async () => {
  const supervisor = await createExternalWorkerSupervisor(() => ({
    command: "external worker",
    cwd: process.cwd(),
    sessionId: "parent",
    scopeKey: "parent:turn:1",
  }));
  const path = supervisor.socketPath;
  await supervisor.close();
  await assert.rejects(
    request(path, {
      version: 1,
      capability: supervisor.capability,
      id: "after-close",
      type: "register",
      workerId: "worker",
      cwd: process.cwd(),
    }),
  );
});
