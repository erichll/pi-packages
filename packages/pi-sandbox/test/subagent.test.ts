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
  runProcessBackedSubagent,
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

function writeRpcWorker(workspace: string): string {
  const worker = join(workspace, "rpc-worker.mjs");
  writeFileSync(
    worker,
    [
      'import { readFileSync } from "node:fs";',
      "let buffer = '';",
      "const history = [];",
      "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`);",
      "const respond = command => send({id: command.id, type:'response', command:command.type, success:true, data: command.type === 'get_state' ? {sessionId:'fixture',isStreaming:false} : undefined});",
      "const run = command => {",
      "  send({type:'agent_start'});",
      "  setTimeout(() => {",
      "    let text = command.message;",
      "    if (text.startsWith('read:')) text = readFileSync(text.slice(5), 'utf8');",
      "    history.push(text);",
      "    send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:history.join(' -> ')}]}});",
      "    send({type:'agent_settled'});",
      "  }, command.message.includes('slow') ? 40 : 5);",
      "};",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk.toString('utf8');",
      "  let newline = buffer.indexOf('\\n');",
      "  while (newline >= 0) {",
      "    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);",
      "    const command = JSON.parse(line); respond(command);",
      "    if (command.type === 'prompt' || command.type === 'follow_up') run(command);",
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
