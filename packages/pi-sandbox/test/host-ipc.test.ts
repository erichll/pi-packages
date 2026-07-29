import assert from "node:assert/strict";
import test from "node:test";
import type { HostIPCConfig } from "../src/config.ts";
import {
  isUnixSocketPermissionError,
  matchingPreflightPrefix,
  runCommandWithHostIPC,
  type HostIPCCommandOptions,
  type HostIPCTrigger,
} from "../src/host-ipc.ts";

const enabled: HostIPCConfig = {
  mode: "ask",
  preflightCommandPrefixes: ["tmux", "/usr/bin/tmux"],
  retryOnUnixSocketError: true,
};

type HarnessOptions = {
  command?: string;
  config?: HostIPCConfig;
  sandboxExit?: number | null;
  stderr?: string;
  stdout?: string;
  approval?: "allow" | "deny";
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  now?: () => number;
  sandboxError?: Error;
};

function harness(overrides: HarnessOptions = {}) {
  let sandboxRuns = 0;
  let hostRuns = 0;
  let approved: HostIPCTrigger | undefined;
  let hostTimeout: number | undefined;
  let output = "";
  const options: HostIPCCommandOptions = {
    command: overrides.command ?? "printf normal",
    cwd: "/workspace",
    config: overrides.config ?? enabled,
    env: overrides.env,
    signal: overrides.signal,
    timeout: overrides.timeout,
    now: overrides.now,
    onData(data) {
      output += data.toString("utf8");
    },
    async approve(trigger) {
      approved = trigger;
      return overrides.approval === "deny"
        ? { action: "deny", source: "reviewer", reason: "not authorized" }
        : { action: "allow", source: "reviewer" };
    },
    async runSandbox(onStderr) {
      sandboxRuns += 1;
      if (overrides.sandboxError) throw overrides.sandboxError;
      if (overrides.stdout) output += overrides.stdout;
      if (overrides.stderr) {
        const data = Buffer.from(overrides.stderr);
        output += data.toString("utf8");
        onStderr(data);
      }
      return {
        exitCode:
          overrides.sandboxExit === undefined ? 0 : overrides.sandboxExit,
      };
    },
    async runHost(timeout) {
      hostRuns += 1;
      hostTimeout = timeout;
      output += "host-output";
      return { exitCode: 23 };
    },
  };
  return {
    run: () => runCommandWithHostIPC(options),
    state: () => ({
      sandboxRuns,
      hostRuns,
      approved,
      hostTimeout,
      output,
    }),
  };
}

test("preflight prefix matching requires an exact token boundary", () => {
  assert.equal(matchingPreflightPrefix("  tmux list-sessions", ["tmux"]), "tmux");
  assert.equal(matchingPreflightPrefix("tmux", ["tmux"]), "tmux");
  assert.equal(matchingPreflightPrefix("tmuxinator", ["tmux"]), undefined);
  assert.equal(matchingPreflightPrefix("env tmux ls", ["tmux"]), undefined);
});

test("preflight approval runs only the host backend", async () => {
  const subject = harness({ command: " tmux list-sessions " });
  const result = await subject.run();
  assert.equal(result.exitCode, 23);
  assert.deepEqual(subject.state(), {
    sandboxRuns: 0,
    hostRuns: 1,
    approved: { reason: "preflight-prefix", rule: "tmux" },
    hostTimeout: undefined,
    output: "host-output",
  });
});

test("preflight denial fails without executing either backend", async () => {
  const subject = harness({
    command: "tmux list-sessions",
    approval: "deny",
  });
  const result = await subject.run();
  assert.equal(result.exitCode, 1);
  assert.equal(subject.state().sandboxRuns, 0);
  assert.equal(subject.state().hostRuns, 0);
  assert.match(subject.state().output, /host-IPC execution denied/);
});

test("matching Unix-socket EPERM retries once and returns the host status", async () => {
  const subject = harness({
    sandboxExit: 126,
    stderr: "connect unix socket: Operation not permitted\n",
  });
  const result = await subject.run();
  assert.equal(result.exitCode, 23);
  assert.equal(subject.state().sandboxRuns, 1);
  assert.equal(subject.state().hostRuns, 1);
  assert.deepEqual(subject.state().approved, {
    reason: "unix-socket-eperm",
    rule: "unix-socket-eperm",
  });
  assert.match(
    subject.state().output,
    /Operation not permitted[\s\S]+approved host-IPC retry[\s\S]+host-output/,
  );
});

test("fallback denial preserves the original sandbox failure", async () => {
  const subject = harness({
    sandboxExit: 126,
    stderr: "IPC socket connect: Operation not permitted",
    approval: "deny",
  });
  const result = await subject.run();
  assert.equal(result.exitCode, 126);
  assert.equal(subject.state().hostRuns, 0);
  assert.doesNotMatch(subject.state().output, /approved host-IPC retry/);
});

test("stdout lookalikes and non-socket failures do not trigger fallback", async () => {
  const stdoutOnly = harness({
    sandboxExit: 1,
    stdout: "connect socket: Operation not permitted",
  });
  assert.equal((await stdoutOnly.run()).exitCode, 1);
  assert.equal(stdoutOnly.state().hostRuns, 0);

  for (const sample of [
    { exit: 1, stderr: "open file: Operation not permitted" },
    { exit: 0, stderr: "connect socket: Operation not permitted" },
    { exit: null, stderr: "connect socket: Operation not permitted" },
  ] as const) {
    const subject = harness({
      sandboxExit: sample.exit,
      stderr: sample.stderr,
    });
    const result = await subject.run();
    assert.equal(result.exitCode, sample.exit);
    assert.equal(subject.state().hostRuns, 0);
    assert.equal(subject.state().approved, undefined);
  }
  assert.equal(
    isUnixSocketPermissionError("connect socket: Permission denied"),
    false,
  );
});

test("disabled mode always uses the sandbox", async () => {
  const subject = harness({
    command: "tmux list-sessions",
    sandboxExit: 7,
    stderr: "connect socket: Operation not permitted",
    config: {
      mode: "off",
      preflightCommandPrefixes: ["tmux"],
      retryOnUnixSocketError: true,
    },
  });
  const result = await subject.run();
  assert.equal(result.exitCode, 7);
  assert.equal(subject.state().sandboxRuns, 1);
  assert.equal(subject.state().hostRuns, 0);
});

test("timeout and abort failures are propagated without fallback", async () => {
  for (const error of [new Error("timeout:2"), new Error("aborted")]) {
    const subject = harness({ sandboxError: error });
    await assert.rejects(subject.run(), error);
    assert.equal(subject.state().hostRuns, 0);
    assert.equal(subject.state().approved, undefined);
  }
});

test("fallback receives only the original timeout remainder", async () => {
  const times = [10_000, 10_750];
  const subject = harness({
    timeout: 2,
    sandboxExit: 1,
    stderr: "connecting to IPC socket: Operation not permitted",
    now: () => times.shift() ?? 10_750,
  });
  await subject.run();
  assert.equal(subject.state().hostTimeout, 1.25);
});

test("builtin subagents cannot preflight or retry on the host", async () => {
  const env = { PI_SANDBOX_SUBAGENT_DEPTH: "1" };
  const preflight = harness({
    command: "tmux ls",
    env,
  });
  assert.equal((await preflight.run()).exitCode, 1);
  assert.equal(preflight.state().hostRuns, 0);
  assert.match(preflight.state().output, /builtin subagents/);

  const fallback = harness({
    env,
    sandboxExit: 9,
    stderr: "connect IPC socket: Operation not permitted",
  });
  assert.equal((await fallback.run()).exitCode, 9);
  assert.equal(fallback.state().hostRuns, 0);
  assert.equal(fallback.state().approved, undefined);
  assert.match(fallback.state().output, /retry refused/);
});
