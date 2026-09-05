import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runSandboxedCommand } from "../src/runner.ts";
import type { SandboxPolicy } from "../src/policy.ts";
import { sandboxRuntimeNetworkCapable } from "./srt-capable.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fakeBroker = {
  modulePath: join(fixtures, "srt-broker.mjs"),
  execArgv: [],
};
const probeBroker = {
  modulePath: join(fixtures, "srt-broker-probe.mjs"),
  execArgv: [],
};
const hasSrtDependencies =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--version"]).status === 0 &&
  spawnSync("socat", ["-V"]).status === 0 &&
  spawnSync("rg", ["--version"]).status === 0;
const srtTest = hasSrtDependencies ? test : test.skip;
const macosSrtTest = process.platform === "darwin" ? test : test.skip;
const rpcTest = sandboxRuntimeNetworkCapable() ? test : test.skip;

function policy(root: string, workspace: string): SandboxPolicy {
  return {
    filesystem: {
      denyRead: [root],
      allowRead: [workspace],
      allowWrite: [workspace],
      denyWrite: [],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
    },
  };
}

test("executes a command through the isolated broker", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-broker-test-"));
  let output = "";
  let reviews = 0;
  try {
    const result = await runSandboxedCommand({
      command: "printf broker-ok",
      cwd: workspace,
      broker: fakeBroker,
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        reviews++;
        return "allow";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(output, "broker-ok");
    assert.equal(reviews, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("routes network requests to the command-specific reviewer", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-network-test-"));
  let endpoint = "";
  try {
    const result = await runSandboxedCommand({
      command: "printf network-ok",
      cwd: workspace,
      broker: fakeBroker,
      env: {
        ...process.env,
        FAKE_SRT_NETWORK_HOST: "api.example.com",
        FAKE_SRT_NETWORK_PORT: "8443",
      },
      onData() {},
      async review() {
        return "deny";
      },
      async reviewDomain(value) {
        endpoint = `${value.hostname}:${value.port}`;
        return "allow";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(endpoint, "api.example.com:8443");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("static allow bypasses review and uses canonical host matching", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-network-allow-"));
  let reviews = 0;
  let output = "";
  try {
    const configured = policy(workspace, workspace);
    configured.network.allowedDomains = ["api.example.com:8443"];
    const result = await runSandboxedCommand({
      command: "printf statically-allowed",
      cwd: workspace,
      broker: fakeBroker,
      policy: configured,
      env: {
        ...process.env,
        FAKE_SRT_NETWORK_HOST: "API.Example.COM.",
        FAKE_SRT_NETWORK_PORT: "8443",
      },
      onData(data) { output += data.toString("utf8"); },
      async review() { return "deny"; },
      async reviewDomain() { reviews++; return "deny"; },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(output, "statically-allowed");
    assert.equal(reviews, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("static deny takes precedence over allow and bypasses review", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-network-priority-"));
  let reviews = 0;
  try {
    const configured = policy(workspace, workspace);
    configured.network.allowedDomains = ["*.example.com"];
    configured.network.deniedDomains = ["api.example.com:443"];
    const result = await runSandboxedCommand({
      command: "printf should-not-run",
      cwd: workspace,
      broker: fakeBroker,
      policy: configured,
      env: {
        ...process.env,
        FAKE_SRT_NETWORK_HOST: "api.example.com",
        FAKE_SRT_NETWORK_PORT: "443",
      },
      onData() {},
      async review() { return "deny"; },
      async reviewDomain() { reviews++; return "allow"; },
    });
    assert.notEqual(result.exitCode, 0);
    assert.equal(reviews, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("network reviewer failures remain fail closed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-network-error-"));
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: "printf should-not-run",
      cwd: workspace,
      broker: fakeBroker,
      env: { ...process.env, FAKE_SRT_NETWORK_HOST: "api.example.com" },
      onData(data) { output += data.toString("utf8"); },
      async review() { return "deny"; },
      async reviewDomain() { throw new Error("review unavailable"); },
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(output, /network approval failed.*review unavailable/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("fails closed when a network request is denied", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-network-deny-"));
  try {
    const result = await runSandboxedCommand({
      command: "printf should-not-run",
      cwd: workspace,
      broker: fakeBroker,
      env: {
        ...process.env,
        FAKE_SRT_NETWORK_HOST: "api.example.com",
      },
      onData() {},
      async review() {
        return "deny";
      },
      async reviewDomain() {
        return "deny";
      },
    });
    assert.notEqual(result.exitCode, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

srtTest("Sandbox Runtime blocks filesystem access outside policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-srt-test-"));
  const workspace = join(root, "workspace");
  const secret = join(root, "secret.txt");
  mkdirSync(workspace);
  writeFileSync(secret, "blocked-content", "utf8");
  let output = "";
  let reviews = 0;
  try {
    const result = await runSandboxedCommand({
      command: `cat '${secret}'`,
      cwd: workspace,
      policy: policy(root, workspace),
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        reviews++;
        return "allow";
      },
    });
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(output, /blocked-content/);
    assert.equal(reviews, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

macosSrtTest("Sandbox Runtime keeps all child temp env vars on the private directory", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-srt-tmpenv-"));
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: `printf '%s\\n' "$TMPDIR" "$TMP" "$TEMP"; test "$TMPDIR" = "$TMP"; test "$TMP" = "$TEMP"; touch "$TMPDIR/probe"`,
      cwd: workspace,
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        return "deny";
      },
    });
    assert.equal(result.exitCode, 0);
    const [commandTmpdir, commandTmp, commandTemp] = output.trim().split("\n");
    assert.ok(commandTmpdir && commandTmp && commandTemp, "expected three tmp-path lines");
    assert.equal(commandTmpdir, commandTmp);
    assert.equal(commandTmp, commandTemp);
    assert.match(commandTmpdir, /(?:^|[/\\])pi-sandbox-tmp-[^/\\]+$/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

rpcTest("Sandbox Runtime supports a persistent direct invocation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-srt-stdin-"));
  const worker = join(workspace, "worker.mjs");
  writeFileSync(
    worker,
    "process.stdin.once('data', data => process.stdout.write(data));",
    "utf8",
  );
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: "direct invocation fixture",
      cwd: workspace,
      directInvocation: { command: process.execPath, args: [worker] },
      onData(data) {
        output += data.toString("utf8");
      },
      onStart(stdin) {
        stdin.end("rpc-ok");
      },
      async review() {
        return "deny";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(output, "rpc-ok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("kills the sandboxed process tree on timeout", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-timeout-test-"));
  const started = Date.now();
  try {
    await assert.rejects(
      runSandboxedCommand({
        command: "sleep 5",
        cwd: workspace,
        broker: fakeBroker,
        timeout: 0.05,
        onData() {},
        async review() {
          return "deny";
        },
      }),
      /timeout:0.05/,
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("injects a private writable temp dir into policy and broker env, then cleans up", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-tmpenv-"));
  const tempDir = join(workspace, "command-tmp");
  mkdirSync(tempDir, { recursive: true });
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: "probe",
      cwd: workspace,
      broker: probeBroker,
      createTempDir() {
        return tempDir;
      },
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        return "deny";
      },
    });
    assert.equal(result.exitCode, 0);
    const probe = JSON.parse(output);
    assert.ok(probe.allowWrite.includes(tempDir), "allowWrite should include temp dir");
    assert.ok(probe.allowRead.includes(tempDir), "allowRead should include temp dir");
    assert.equal(probe.tmpdirEnv, tempDir, "broker env should carry PI_SANDBOX_TMPDIR");
    assert.equal(
      probe.sandboxRuntimeTmpdirEnv,
      tempDir,
      "broker env should point Sandbox Runtime at the private temp dir",
    );
    // The runner must remove the per-command temp dir on completion.
    assert.equal(existsSync(tempDir), false, "temp dir should be cleaned up");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("degrades (no writable temp) when a temp dir cannot be created", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-tmpdegrade-"));
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: "probe",
      cwd: workspace,
      broker: probeBroker,
      policy: policy(workspace, workspace),
      createTempDir() {
        return undefined;
      },
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        return "deny";
      },
    });
    assert.equal(result.exitCode, 0);
    const probe = JSON.parse(output);
    assert.equal(
      probe.tmpdirEnv,
      "",
      "no PI_SANDBOX_TMPDIR should be set when temp is unavailable",
    );
    assert.deepEqual(
      probe.allowWrite,
      [workspace],
      "allowWrite should stay unchanged when temp is unavailable",
    );
    assert.deepEqual(probe.allowRead, [workspace]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
