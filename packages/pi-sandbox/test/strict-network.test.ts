import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { approveDomainEndpoint, type TrapApprovalContext } from "../src/approval.ts";
import { parsePiSandboxConfig } from "../src/config.ts";
import { runCommandWithHostIPC } from "../src/host-ipc.ts";
import { createDefaultPolicy } from "../src/policy.ts";
import { runSandboxedCommand } from "../src/runner.ts";
import { ProcessBackedSubagentManager, runProcessBackedSubagent } from "../src/subagent.ts";
import { sandboxRuntimeNetworkCapable } from "./srt-capable.ts";

const capable = sandboxRuntimeNetworkCapable();
const realSandbox = {
  skip: capable ? false : "requires Linux bubblewrap network namespaces, socat and rg",
  timeout: 30_000,
};
const brokerPath = fileURLToPath(new URL("../src/srt-broker.mjs", import.meta.url));
const probeBroker = {
  modulePath: brokerPath,
  execArgv: ["--import", fileURLToPath(new URL("./fixtures/srt-network-probe.mjs", import.meta.url))],
};
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-strict-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const worker = join(cwd, "worker.mjs");
  copyFileSync(new URL("./fixtures/network-worker.mjs", import.meta.url), worker);
  const hits: [number, number] = [0, 0];
  const urls: string[] = [];
  for (const index of [0, 1] as const) {
    const server = createServer((_request, response) => {
      hits[index]++;
      response.end(`endpoint-${index}`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    urls.push(`http://127.0.0.1:${address.port}/`);
  }
  urls.push("http://unmatched.invalid:443/");
  const network = parsePiSandboxConfig({ network: {
    strictAllowlist: true,
    allowedDomains: [new URL(urls[0]!).host],
  } }).network;
  const policy = createDefaultPolicy(cwd, { network });
  // Do not inherit a developer's upstream proxy for these loopback-only tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !/^(?:http|https|all|no)_proxy$/i.test(key),
  ));
  return { cwd, worker, urls, hits, policy, env };
}

function assertResponses(text: string, statuses: number[]) {
  const result = JSON.parse(text) as {
    instanceId: string;
    results: { status: number; body: string }[];
  };
  assert.deepEqual(result.results?.map((entry) => entry.status), statuses, text);
  for (const [index, status] of statuses.entries()) {
    if (status === 200) assert.match(result.results[index]!.body, /^endpoint-/);
  }
  return result;
}

test("real Runtime strict allowlist denies unmatched targets before any approval callback", realSandbox, async (t) => {
  const f = await fixture(t);
  let networkCalls = 0;
  let reviewerCalls = 0;
  let humanCalls = 0;
  for (const approvalMode of ["human", "throwing-reviewer", "absent"] as const) {
    const context: TrapApprovalContext = {
      cwd: f.cwd, command: "synthetic network probe", sessionId: "strict", scopeKey: "strict",
      humanApproval: async () => { humanCalls++; return "allow-once"; },
      ...(approvalMode === "throwing-reviewer" ? { broker: {
        async review() { reviewerCalls++; throw new Error("review service unavailable"); },
        consumeGrant() { return false; },
      } as TrapApprovalContext["broker"] } : {}),
    };
    let stdout = "";
    let stderr = "";
    const result = await runSandboxedCommand({
      cwd: f.cwd, env: f.env, policy: f.policy, broker: probeBroker, timeout: 10,
      command: [process.execPath, f.worker, JSON.stringify(f.urls)].map(shellQuote).join(" "),
      onData() {},
      review: async () => { networkCalls++; return "allow"; },
      onStdout(data) { stdout += data; },
      onStderr(data) { stderr += data; },
      ...(approvalMode === "absent" ? {} : { reviewDomain: async (endpoint: Parameters<typeof approveDomainEndpoint>[0]) => {
        networkCalls++;
        return (await approveDomainEndpoint(endpoint, context)).action;
      } }),
    });
    assert.equal(result.exitCode, 0, stderr);
    assertResponses(stdout, [200, 403, 403]);
    assert.doesNotMatch(stderr, /TEST_RUNTIME_ASK_CALLED/);
  }
  assert.deepEqual(f.hits, [3, 0]);
  assert.equal(networkCalls, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(humanCalls, 0);
});

test("non-strict Runtime still invokes the ask callback for unmatched destinations", realSandbox, async (t) => {
  const f = await fixture(t);
  // IP literals avoid DNS or external traffic. pi-sandbox rejects their dynamic
  // approval, but the probe must observe Runtime consulting the ask callback.
  for (const strictAllowlist of [false, undefined]) {
    if (strictAllowlist === undefined) delete f.policy.network.strictAllowlist;
    else f.policy.network.strictAllowlist = strictAllowlist;
    let stdout = "";
    let stderr = "";
    const result = await runSandboxedCommand({
      cwd: f.cwd, env: f.env, policy: f.policy, broker: probeBroker, timeout: 10,
      command: "non-strict control",
      directInvocation: { command: process.execPath, args: [f.worker, JSON.stringify(f.urls.slice(0, 2))] },
      review: async () => "deny",
      onData() {}, onStdout(data) { stdout += data; }, onStderr(data) { stderr += data; },
    });
    assert.equal(result.exitCode, 0, stderr);
    assert.equal(stderr.match(/TEST_RUNTIME_ASK_CALLED/g)?.length, 1);
    assertResponses(stdout.trim().split("\n").at(-1)!, [200, 403]);
  }
  assert.deepEqual(f.hits, [2, 0]);
});

test("real strict Runtime preserves explicit deny precedence and empty allowlists", realSandbox, async (t) => {
  const f = await fixture(t);
  for (const deny of ["exact", "all", "empty"] as const) {
    const policy = createDefaultPolicy(f.cwd, { network: {
      strictAllowlist: true,
      allowedDomains: deny === "empty" ? [] : [...f.policy.network.allowedDomains],
      deniedDomains: deny === "all" ? ["*"] : deny === "exact" ? [...f.policy.network.allowedDomains] : [],
    } });
    let stdout = "";
    let stderr = "";
    const result = await runSandboxedCommand({
      cwd: f.cwd, env: f.env, policy, broker: probeBroker, timeout: 10,
      command: "strict deny probe",
      directInvocation: { command: process.execPath, args: [f.worker, JSON.stringify(f.urls)] },
      onData() {}, onStdout(data) { stdout += data; }, onStderr(data) { stderr += data; },
      review: async () => { throw new Error("unexpected approval"); },
      reviewDomain: async () => { throw new Error("unexpected approval"); },
    });
    assert.equal(result.exitCode, 0, stderr);
    assertResponses(stdout, [403, 403, 403]);
    assert.doesNotMatch(stderr, /TEST_RUNTIME_ASK_CALLED|unexpected approval/);
  }
  assert.deepEqual(f.hits, [0, 0]);
});

test("strict policy survives real one-shot and persistent worker lifecycle operations", realSandbox, async (t) => {
  const f = await fixture(t);
  let reviews = 0;
  const options = {
    cwd: f.cwd, env: f.env, policy: f.policy,
    invocation: { command: process.execPath, args: [f.worker] },
    sandbox: { broker: probeBroker },
    timeout: 15,
    review: async () => { reviews++; return "allow" as const; },
    reviewDomain: async () => { reviews++; return "allow" as const; },
  };
  const task = JSON.stringify(f.urls);
  const single = await runProcessBackedSubagent({ ...options, task });
  assertResponses(single.text, [200, 403, 403]);
  assert.doesNotMatch(single.rawOutput, /TEST_RUNTIME_ASK_CALLED/);

  const manager = new ProcessBackedSubagentManager();
  t.after(() => manager.shutdown());
  const parent = await manager.start({ ...options, task });
  const first = await parent.waitForSettled(await parent.prompt(task));
  const firstProbe = assertResponses(first.text, [200, 403, 403]);
  const next = await parent.waitForSettled(await parent.followUp(task));
  assert.equal(assertResponses(next.text, [200, 403, 403]).instanceId, firstProbe.instanceId);

  const child = await manager.start({ ...options, task, parentId: parent.id });
  const handedOff = await child.waitForSettled(await child.prompt(task));
  assert.notEqual(assertResponses(handedOff.text, [200, 403, 403]).instanceId, firstProbe.instanceId);
  assert.equal(child.info.depth, 2);

  // Concurrent brokers must not share a mutable Runtime configuration.
  const restricted = await manager.start({
    ...options, task,
    policy: createDefaultPolicy(f.cwd, { network: {
      allowedDomains: [], deniedDomains: [], strictAllowlist: true,
    } }),
  });
  const denied = await restricted.waitForSettled(await restricted.prompt(task));
  assertResponses(denied.text, [403, 403, 403]);
  const stillAllowed = await parent.waitForSettled(await parent.followUp(task));
  assertResponses(stillAllowed.text, [200, 403, 403]);
  await manager.remove(parent.id);
  await assert.rejects(parent.followUp(task), /stopped/);
  const restarted = await manager.start({ ...options, task });
  const afterRestart = await restarted.waitForSettled(await restarted.prompt(task));
  assert.notEqual(assertResponses(afterRestart.text, [200, 403, 403]).instanceId, firstProbe.instanceId);
  for (const result of [single, first, next, handedOff, denied, stillAllowed, afterRestart]) {
    assert.doesNotMatch(result.rawOutput, /TEST_RUNTIME_ASK_CALLED/);
  }
  assert.equal(reviews, 0);
  assert.deepEqual(f.hits, [6, 0]);
});

test("missing or failing Runtime broker never starts a strict worker", { timeout: 15_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-strict-failure-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const policy = createDefaultPolicy(cwd, { network: {
    strictAllowlist: true, allowedDomains: [], deniedDomains: [],
  } });
  for (const broker of [
    { modulePath: join(cwd, "missing-broker.mjs"), execArgv: [] },
    { modulePath: brokerPath, execArgv: ["--import", fileURLToPath(new URL("./fixtures/srt-initialize-failure.mjs", import.meta.url))] },
  ]) {
    let output = "";
    let hostRuns = 0;
    let approvals = 0;
    const invocation = { command: process.execPath, args: ["-e", "console.log('TEST_WORKER_STARTED')"] };
    const result = await runCommandWithHostIPC({
      cwd, command: "strict worker startup probe",
      config: { mode: "off", preflightCommandPrefixes: [], retryOnUnixSocketError: true },
      onData(data) { output += data; },
      approve: async () => { approvals++; return { action: "allow", source: "human" }; },
      runHost: async () => { hostRuns++; return { exitCode: 0 }; },
      runSandbox: (onStderr) => runSandboxedCommand({
        cwd, policy, broker, timeout: 5,
        command: "strict worker startup probe", directInvocation: invocation,
        onData(data) { output += data; }, onStderr,
        review: async () => { approvals++; return "allow"; },
      }),
    });
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(output, /TEST_WORKER_STARTED/);
    assert.match(output, /MODULE_NOT_FOUND|TEST_RUNTIME_INITIALIZATION_FAILED/);
    assert.equal(hostRuns, 0);
    assert.equal(approvals, 0);
    const manager = new ProcessBackedSubagentManager({ invocation });
    try {
      await assert.rejects(manager.start({
        cwd, policy, task: "startup probe", sandbox: { broker }, rpcTimeoutMs: 2_000,
        review: async () => "allow", reviewDomain: async () => "allow",
      }), /MODULE_NOT_FOUND|TEST_RUNTIME_INITIALIZATION_FAILED/);
    } finally {
      await manager.shutdown();
    }
  }
});
