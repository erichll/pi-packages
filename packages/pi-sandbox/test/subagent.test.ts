import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SandboxPolicy } from "../src/policy.ts";
import {
  finalAssistantText,
  ProcessBackedSubagentManager,
  ProcessBackedSubagentSession,
  runProcessBackedSubagent,
  splitModelThinking,
  validateSubagentModel,
} from "../src/subagent.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

const fakeBroker = {
  modulePath: join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "srt-broker.mjs",
  ),
  execArgv: [],
};

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

function writeRpcWorker(
  workspace: string,
  settlementFields: Record<string, unknown> = {},
): string {
  const worker = join(workspace, "rpc-worker.mjs");
  writeFileSync(
    worker,
    [
      'import { readFileSync } from "node:fs";',
      "let buffer = '';",
      "const history = [];",
      "let activeTimer;",
      `const settlementFields = ${JSON.stringify(settlementFields)};`,
      "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`);",
      "const respond = command => send({id: command.id, type:'response', command:command.type, success:true, data: command.type === 'get_state' ? {sessionId:'fixture',isStreaming:false} : undefined});",
      "const run = command => {",
      "  send({type:'agent_start'});",
      "  const finish = () => {",
      "    activeTimer = undefined;",
      "    let text = command.message;",
      "    if (text.startsWith('read:')) text = readFileSync(text.slice(5), 'utf8');",
      "    history.push(text);",
      "    send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:history.join(' -> ')}]}});",
      "    send({type:'agent_settled', ...(command.message.startsWith('fixture-settlement:') ? settlementFields : {})});",
      "  };",
      "  if (command.message.includes('before-response')) finish();",
      "  else activeTimer = setTimeout(finish, command.message.includes('slow') ? 40 : 5);",
      "};",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk.toString('utf8');",
      "  let newline = buffer.indexOf('\\n');",
      "  while (newline >= 0) {",
      "    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);",
      "    const command = JSON.parse(line);",
      "    if (command.type === 'abort' && activeTimer) {",
      "      clearTimeout(activeTimer); activeTimer = undefined;",
      "      send({type:'agent_settled',aborted:true});",
      "    }",
      "    const isPrompt = command.type === 'prompt' || command.type === 'follow_up';",
      "    if (isPrompt && command.message.includes('before-response')) run(command);",
      "    respond(command);",
      "    if (isPrompt && !command.message.includes('before-response')) run(command);",
      "    newline = buffer.indexOf('\\n');",
      "  }",
      "});",
    ].join("\n"),
    "utf8",
  );
  return worker;
}

test("extracts only the final assistant JSON event", () => {
  assert.equal(
    finalAssistantText(
      [
        "diagnostic",
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}',
      ].join("\n"),
    ),
    "final",
  );
});

const catalog = [
  { id: "claude-sonnet", provider: "anthropic" },
  { id: "claude-haiku", provider: "anthropic" },
  { id: "gpt-4o", provider: "openai" },
  { id: "shared-model", provider: "anthropic" },
  { id: "shared-model", provider: "openai" },
];

function assertOk(
  value: ReturnType<typeof validateSubagentModel>,
): asserts value is { ok: true; mode: "inherit" | "explicit" } {
  assert.equal(value.ok, true);
}

function assertFail(
  value: ReturnType<typeof validateSubagentModel>,
): asserts value is { ok: false; error: string } {
  assert.equal(value.ok, false);
}

test("model validation: absent model inherits host behavior", () => {
  const inherit = validateSubagentModel(undefined, catalog, "anthropic");
  assertOk(inherit);
  assert.equal(inherit.mode, "inherit");
  assertOk(validateSubagentModel("", catalog, "anthropic"));
  assertOk(validateSubagentModel("  ", catalog, "anthropic"));
});

test("model validation: exact provider/model id is accepted", () => {
  assertOk(validateSubagentModel("anthropic/claude-sonnet", catalog, "anthropic"));
  assertOk(validateSubagentModel("openai/gpt-4o", catalog, "anthropic"));
  // Non-preferred provider full id is still a valid full reference.
  assertOk(validateSubagentModel("openai/gpt-4o", catalog, "anthropic"));
});

test("model validation: bare id matches current provider first", () => {
  // 'shared-model' exists under anthropic + openai; preferred provider disambiguates.
  assertOk(validateSubagentModel("shared-model", catalog, "anthropic"));
  assertOk(validateSubagentModel("shared-model", catalog, "openai"));
});

test("model validation: unique bare id is accepted without a provider", () => {
  assertOk(validateSubagentModel("claude-sonnet", catalog, undefined));
  assertOk(validateSubagentModel("gpt-4o", catalog, undefined));
});

test("model validation: unknown provider/model is rejected before spawn", () => {
  const r = validateSubagentModel("example/missing", catalog, "anthropic");
  assertFail(r);
  assert.match(r.error, /unknown model 'example\/missing'/);
});

test("model validation: ambiguous bare id is rejected with full-id hint", () => {
  const r = validateSubagentModel("shared-model", catalog, undefined);
  assertFail(r);
  assert.match(r.error, /multiple providers \(anthropic, openai\)/);
  assert.match(r.error, /provider\/model/);
});

test("model validation: thinking suffix is stripped for base and preserved", () => {
  const split = splitModelThinking("anthropic/claude-sonnet:high");
  assert.equal(split.base, "anthropic/claude-sonnet");
  assert.equal(split.thinking, "high");
  // Validating the base model with the explicit high suffix passes.
  assertOk(validateSubagentModel("anthropic/claude-sonnet:high", catalog, "anthropic"));
  // A colon that is not a thinking level stays part of the model id.
  const exacto = splitModelThinking("openrouter/anthropic/claude:exacto");
  assert.equal(exacto.base, "openrouter/anthropic/claude:exacto");
  assert.equal(exacto.thinking, undefined);
});

test("model validation: unknown bare id is rejected", () => {
  const r = validateSubagentModel("does-not-exist", catalog, "anthropic");
  assertFail(r);
  assert.match(r.error, /unknown model 'does-not-exist'/);
});

linuxTest("worker runs inside its dedicated outer broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-subagent-"));
  const workspace = join(root, "workspace");
  const secret = join(root, "secret.txt");
  const worker = join(workspace, "worker.mjs");
  mkdirSync(workspace);
  writeFileSync(secret, "worker-secret", "utf8");
  writeFileSync(
    worker,
    [
      'import { readFileSync } from "node:fs";',
      "const value = readFileSync(process.env.TEST_SECRET, 'utf8');",
      "const text = value;",
      "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}}));",
    ].join("\n"),
    "utf8",
  );
  let secretReviews = 0;
  try {
    const result = await runProcessBackedSubagent({
      task: "read the test fixture",
      cwd: workspace,
      invocation: { command: process.execPath, args: [worker] },
      env: { ...process.env, TEST_SECRET: secret },
      policy: {
        ...policy(root, workspace),
        filesystem: {
          ...policy(root, workspace).filesystem,
          allowRead: [workspace, secret],
        },
      },
      sandbox: { broker: fakeBroker },
      async review() {
        secretReviews++;
        return "deny";
      },
      async reviewDomain() {
        return "deny";
      },
    });
    assert.equal(result.text, "worker-secret");
    assert.equal(secretReviews, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("concurrent workers have independent outer sandboxes and exits", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workers-"));
  const worker = join(workspace, "worker.mjs");
  writeFileSync(
    worker,
    [
      "const task = process.argv.at(-1);",
      "await new Promise(resolve => setTimeout(resolve, task.includes('one') ? 30 : 10));",
      "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:task}]}}));",
    ].join("\n"),
    "utf8",
  );
  const run = (task: string) =>
    runProcessBackedSubagent({
      task,
      cwd: workspace,
      invocation: { command: process.execPath, args: [worker] },
      sandbox: { broker: fakeBroker },
      async review() {
        return "deny";
      },
      async reviewDomain() {
        return "deny";
      },
    });
  try {
    const [one, two] = await Promise.all([run("one"), run("two")]);
    assert.match(one.text, /Task: one/);
    assert.match(two.text, /Task: two/);
    assert.equal(one.exitCode, 0);
    assert.equal(two.exitCode, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

linuxTest("background RPC session supports follow-up inside one outer sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-"));
  const workspace = join(root, "workspace");
  const secret = join(root, "secret.txt");
  mkdirSync(workspace);
  writeFileSync(secret, "rpc-secret", "utf8");
  const worker = writeRpcWorker(workspace);
  const manager = new ProcessBackedSubagentManager({
    invocation: { command: process.execPath, args: [worker] },
  });
  let reviews = 0;
  try {
    const session = await manager.start({
      task: "background fixture",
      cwd: workspace,
      policy: policy(root, workspace),
      sandbox: { broker: fakeBroker },
      async review() {
        reviews++;
        return "deny";
      },
      async reviewDomain() {
        return "deny";
      },
    });
    const first = await session.waitForSettled(
      await session.prompt(`read:${secret}`),
    );
    assert.equal(first.text, "rpc-secret");
    const second = await session.waitForSettled(
      await session.followUp("follow-up"),
    );
    assert.equal(second.text, "rpc-secret -> follow-up");
    assert.equal(session.info.state, "idle");
    assert.equal(reviews, 0);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("aborted RPC settlement rejects current and late waiters without terminating the session", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-aborted-"));
  const worker = writeRpcWorker(workspace, { aborted: true });
  const manager = new ProcessBackedSubagentManager({
    maxConcurrency: 1,
    invocation: { command: process.execPath, args: [worker] },
  });
  try {
    const session = await manager.start({
      task: "aborted settlement fixture",
      cwd: workspace,
      sandbox: { broker: fakeBroker },
      async review() { return "deny"; },
      async reviewDomain() { return "deny"; },
    });
    const target = await session.prompt("fixture-settlement:slow");
    const first = assert.rejects(session.waitForSettled(target), /run 1 aborted/);
    const second = assert.rejects(session.waitForSettled(target), /run 1 aborted/);
    await Promise.all([first, second]);
    assert.equal(session.info.state, "idle");
    await assert.rejects(session.waitForSettled(target), /run 1 aborted/);
    await assert.rejects(session.waitForSettled(), /run 1 aborted/);

    // Cancellation does not release the concurrency slot: the RPC child lives.
    await assert.rejects(manager.start({
      task: "another session",
      cwd: workspace,
      sandbox: { broker: fakeBroker },
      async review() { return "deny"; },
      async reviewDomain() { return "deny"; },
    }), /concurrency limit/);
    const successTarget = await session.followUp("resume after cancellation");
    assert.equal(successTarget, target + 1);
    assert.match((await session.waitForSettled(successTarget)).text, /resume after cancellation/);
    await assert.rejects(session.waitForSettled(target), /run 1 aborted/);

    // The event can arrive in the same stdout chunk before prompt's RPC reply.
    const earlyTarget = await session.prompt("fixture-settlement:before-response");
    await assert.rejects(session.waitForSettled(earlyTarget), /run 3 aborted/);
    assert.equal(session.info.state, "idle");
  } finally {
    await manager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
});

linuxTest("RPC abort signal and explicit abort reject only the cancelled run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-abort-"));
  const manager = new ProcessBackedSubagentManager({
    invocation: { command: process.execPath, args: [writeRpcWorker(workspace)] },
  });
  try {
    const session = await manager.start({
      task: "abort race fixture", cwd: workspace,
      sandbox: { broker: fakeBroker },
      async review() { return "deny"; },
      async reviewDomain() { return "deny"; },
    });
    const target = await session.prompt("slow run");
    const controller = new AbortController();
    const localWait = assert.rejects(session.waitForSettled(target, controller.signal), /^Error: aborted$/);
    const runWait = assert.rejects(session.waitForSettled(target), /run 1 aborted/);
    controller.abort();
    await session.abort();
    await Promise.all([localWait, runWait]);
    assert.equal(session.info.state, "idle");
    await assert.rejects(session.waitForSettled(target), /run 1 aborted/);
    const result = await session.waitForSettled(await session.followUp("normal run"));
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /normal run/);
  } finally {
    await manager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
});

linuxTest("legacy, false and malformed aborted fields preserve successful RPC settlement", async () => {
  for (const fields of [{}, { aborted: false }, { aborted: "true" }, { aborted: null }]) {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-legacy-"));
    const manager = new ProcessBackedSubagentManager({
      invocation: { command: process.execPath, args: [writeRpcWorker(workspace, fields)] },
    });
    try {
      const session = await manager.start({
        task: "legacy fixture", cwd: workspace,
        sandbox: { broker: fakeBroker },
        async review() { return "deny"; },
        async reviewDomain() { return "deny"; },
      });
      const target = await session.prompt("fixture-settlement:before-response");
      assert.equal((await session.waitForSettled(target)).exitCode, 0);
      assert.equal(session.info.state, "idle");
    } finally {
      await manager.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("late protocol events cannot resurrect stopped or failed RPC sessions", async () => {
  for (const terminalState of ["stopped", "failed"] as const) {
    const session = new ProcessBackedSubagentSession({
      task: "terminal race", cwd: process.cwd(),
      async review() { return "deny"; },
      async reviewDomain() { return "deny"; },
    });
    // Inject final buffered records without racing an OS pipe close.
    const protocol = session as unknown as { consumeLine(line: string): void; fail(error: Error): void };
    if (terminalState === "stopped") await session.stop();
    else protocol.fail(new Error("fixture failure"));
    for (const event of [
      { type: "agent_start" },
      { type: "agent_settled", aborted: true },
      { type: "agent_settled" },
    ]) protocol.consumeLine(JSON.stringify(event));
    assert.equal(session.info.state, terminalState);
    await assert.rejects(session.waitForSettled(1), /stopped|fixture failure/);
  }
});

linuxTest("manager enforces concurrency and nested handoff depth", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-limits-"));
  const worker = writeRpcWorker(workspace);
  const options = {
    cwd: workspace,
    sandbox: { broker: fakeBroker },
    async review() {
      return "deny" as const;
    },
    async reviewDomain() {
      return "deny" as const;
    },
  };
  const concurrencyManager = new ProcessBackedSubagentManager({
    maxConcurrency: 2,
    invocation: { command: process.execPath, args: [worker] },
  });
  try {
    await concurrencyManager.start({ ...options, task: "one" });
    await concurrencyManager.start({ ...options, task: "two" });
    await assert.rejects(
      concurrencyManager.start({ ...options, task: "three" }),
      /concurrency limit reached \(2\)/,
    );
  } finally {
    await concurrencyManager.shutdown();
  }

  const nestingManager = new ProcessBackedSubagentManager({
    maxConcurrency: 4,
    maxDepth: 2,
    invocation: { command: process.execPath, args: [worker] },
  });
  try {
    const parent = await nestingManager.start({ ...options, task: "parent" });
    const child = await nestingManager.start({
      ...options,
      task: "handoff",
      parentId: parent.id,
    });
    assert.equal(child.info.parentId, parent.id);
    assert.equal(child.info.depth, 2);
    await assert.rejects(
      nestingManager.start({
        ...options,
        task: "too deep",
        parentId: child.id,
      }),
      /nesting depth limit reached \(2\)/,
    );
  } finally {
    await nestingManager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
});

linuxTest("manager shutdown terminates every persistent RPC session", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-rpc-shutdown-"));
  const worker = writeRpcWorker(workspace);
  const manager = new ProcessBackedSubagentManager({
    maxConcurrency: 2,
    invocation: { command: process.execPath, args: [worker] },
  });
  const options = {
    cwd: workspace,
    sandbox: { broker: fakeBroker },
    async review() {
      return "deny" as const;
    },
    async reviewDomain() {
      return "deny" as const;
    },
  };
  try {
    const one = await manager.start({ ...options, task: "one" });
    const two = await manager.start({ ...options, task: "two" });
    await manager.shutdown();
    assert.equal(one.info.state, "stopped");
    assert.equal(two.info.state, "stopped");
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
});
