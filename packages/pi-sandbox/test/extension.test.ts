import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerPiSandbox } from "../src/index.ts";
import { ProcessBackedSubagentManager } from "../src/subagent.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const fakeBroker = {
  modulePath: join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "srt-broker.mjs",
  ),
  execArgv: [],
};

linuxTest("registers and executes the sandboxed main Bash tool", async () => {
  let bashTool: ToolDefinition | undefined;
  let subagentTool: ToolDefinition | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "bash") bashTool = tool;
      if (tool.name === "subagent") subagentTool = tool;
    },
    on() {},
    getActiveTools() {
      return ["bash", "subagent"];
    },
  } as unknown as ExtensionAPI;
  await registerPiSandbox(pi, {
    subagentProvider: "builtin",
    sandbox: { broker: fakeBroker },
  });
  assert.ok(bashTool);
  assert.ok(subagentTool);

  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-test-"));
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "extension-test-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  try {
    const result = await bashTool.execute(
      "call-1",
      { command: "printf extension-ok" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.content[0]?.type, "text");
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /extension-ok/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagent providers conditionally construct, register, and shut down the builtin manager", async () => {
  for (const provider of ["builtin", "pi-subagents", "off"] as const) {
    const registered: string[] = [];
    const handlers = new Map<string, () => unknown>();
    let constructed = 0;
    let shutdown = 0;
    const manager = {
      async shutdown() {
        shutdown += 1;
      },
    } as unknown as ProcessBackedSubagentManager;
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool.name);
      },
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      getActiveTools() {
        return registered;
      },
    } as unknown as ExtensionAPI;

    await registerPiSandbox(pi, {
      subagentProvider: provider,
      createSubagentManager() {
        constructed += 1;
        return manager;
      },
    });

    assert.ok(registered.includes("bash"));
    assert.equal(registered.includes("subagent"), provider === "builtin");
    assert.equal(constructed, provider === "builtin" ? 1 : 0);

    await handlers.get("session_shutdown")?.();
    assert.equal(shutdown, provider === "builtin" ? 1 : 0);
  }
});

test("repeated registration does not duplicate managers, tools, or event handlers", async () => {
  const tools: string[] = [];
  const eventCounts = new Map<string, number>();
  let constructed = 0;
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool.name);
    },
    on(event: string) {
      eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
    },
    getActiveTools() {
      return tools;
    },
  } as unknown as ExtensionAPI;
  const options = {
    subagentProvider: "builtin" as const,
    createSubagentManager() {
      constructed += 1;
      return {
        async shutdown() {},
      } as unknown as ProcessBackedSubagentManager;
    },
  };

  await Promise.all([
    registerPiSandbox(pi, options),
    registerPiSandbox(pi, options),
  ]);

  assert.equal(constructed, 1);
  assert.equal(tools.filter((name) => name === "bash").length, 1);
  assert.equal(tools.filter((name) => name === "subagent").length, 1);
  assert.deepEqual(
    Object.fromEntries(eventCounts),
    {
      user_bash: 1,
      turn_start: 1,
      session_start: 1,
      session_shutdown: 1,
    },
  );
});

test("session start diagnoses external subagent ownership and security level", async () => {
  const cases = [
    {
      activeTools: [] as string[],
      tools: [] as ReturnType<ExtensionAPI["getAllTools"]>,
      expected: /no external subagent tool is active/,
      level: "warning",
    },
    {
      activeTools: ["subagent"],
      tools: [
        {
          name: "subagent",
          description: "external",
          parameters: {},
          sourceInfo: {
            source: "npm:pi-subagents",
            path: "/trusted/npm/pi-subagents/index.ts",
            scope: "user",
            origin: "package",
          },
        },
      ] as unknown as ReturnType<ExtensionAPI["getAllTools"]>,
      expected:
        /External workers are not yet wrapped in an outer Sandbox Runtime sandbox/,
      level: "info",
    },
    {
      activeTools: ["subagent"],
      tools: [
        {
          name: "subagent",
          description: "unexpected",
          parameters: {},
          sourceInfo: {
            source: "npm:other-agents",
            path: "/trusted/npm/other-agents/index.ts",
            scope: "user",
            origin: "package",
          },
        },
      ] as unknown as ReturnType<ExtensionAPI["getAllTools"]>,
      expected: /owned by unexpected source npm:other-agents/,
      level: "warning",
    },
  ] as const;

  for (const diagnosticCase of cases) {
    let sessionStart:
      | ((event: unknown, ctx: ExtensionContext) => unknown)
      | undefined;
    const notifications: Array<{ message: string; level: string }> = [];
    const pi = {
      registerTool() {},
      on(
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) {
        if (event === "session_start") sessionStart = handler;
      },
      getActiveTools() {
        return [...diagnosticCase.activeTools];
      },
      getAllTools() {
        return [...diagnosticCase.tools];
      },
    } as unknown as ExtensionAPI;
    await registerPiSandbox(pi, { subagentProvider: "pi-subagents" });
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as unknown as ExtensionContext;

    sessionStart?.({}, ctx);

    const diagnostic = notifications.find(({ message }) =>
      diagnosticCase.expected.test(message),
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.level, diagnosticCase.level);
  }
});

linuxTest("subagent tool drives background RPC, follow-up, and shutdown", async () => {
  let subagentTool: ToolDefinition | undefined;
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "subagent") subagentTool = tool;
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return ["bash", "subagent"];
    },
  } as unknown as ExtensionAPI;
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-rpc-"));
  const worker = join(cwd, "rpc-worker.mjs");
  writeFileSync(
    worker,
    [
      "let buffer = ''; const history = [];",
      "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`);",
      "process.stdin.on('data', chunk => {",
      " buffer += chunk; let newline = buffer.indexOf('\\n');",
      " while (newline >= 0) {",
      "  const command = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);",
      "  send({id:command.id,type:'response',command:command.type,success:true,data:command.type === 'get_state' ? {sessionId:'fixture'} : undefined});",
      "  if (command.type === 'prompt' || command.type === 'follow_up') {",
      "   send({type:'agent_start'}); history.push(command.message);",
      "   send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:history.join(' -> ')}]}});",
      "   send({type:'agent_settled'});",
      "  }",
      "  newline = buffer.indexOf('\\n');",
      " }",
      "});",
    ].join("\n"),
    "utf8",
  );
  const manager = new ProcessBackedSubagentManager({
    invocation: { command: process.execPath, args: [worker] },
  });
  await registerPiSandbox(pi, {
    subagentProvider: "builtin",
    subagentManager: manager,
    sandbox: { broker: fakeBroker },
  });
  assert.ok(subagentTool);
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "extension-rpc-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  try {
    const started = await subagentTool.execute(
      "start-1",
      { action: "start", task: "first", background: true },
      undefined,
      undefined,
      ctx,
    );
    const details = started.details as {
      session: { id: string };
    };
    assert.match(
      started.content[0]?.type === "text" ? started.content[0].text : "",
      /Started background subagent/,
    );
    const followed = await subagentTool.execute(
      "follow-1",
      {
        action: "follow_up",
        sessionId: details.session.id,
        task: "second",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      followed.content[0]?.type === "text"
        ? followed.content[0].text
        : "",
      "first -> second",
    );
    const handedOff = await subagentTool.execute(
      "handoff-1",
      {
        action: "handoff",
        sessionId: details.session.id,
        task: "verify independently",
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const handoffDetails = handedOff.details as {
      session: { id: string; parentId?: string; depth: number };
    };
    assert.equal(handoffDetails.session.parentId, details.session.id);
    assert.equal(handoffDetails.session.depth, 2);
    const handoffResult = await subagentTool.execute(
      "wait-handoff-1",
      { action: "wait", sessionId: handoffDetails.session.id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      handoffResult.content[0]?.type === "text"
        ? handoffResult.content[0].text
        : "",
      /Next task:\nverify independently/,
    );
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
