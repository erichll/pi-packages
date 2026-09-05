import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const probeBroker = {
  modulePath: join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "srt-broker-probe.mjs",
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

linuxTest("main Bash and builtin subagents receive the same trusted network policy", async () => {
  let bashTool: ToolDefinition | undefined;
  let subagentTool: ToolDefinition | undefined;
  let subagentPolicy: Parameters<ProcessBackedSubagentManager["start"]>[0]["policy"];
  const session = {
    id: "network-session",
    info: { id: "network-session", state: "idle", text: "ok" },
    onUpdate: () => () => {},
    prompt: async () => "target",
    waitForSettled: async () => ({ text: "ok", exitCode: 0 }),
    abort: async () => {},
  } as unknown as Awaited<ReturnType<ProcessBackedSubagentManager["start"]>>;
  const manager = {
    async start(options: Parameters<ProcessBackedSubagentManager["start"]>[0]) {
      subagentPolicy = options.policy;
      return session;
    },
    async remove() {},
    async shutdown() {},
  } as unknown as ProcessBackedSubagentManager;
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "bash") bashTool = tool;
      if (tool.name === "subagent") subagentTool = tool;
    },
    on() {},
    getActiveTools() { return ["bash", "subagent"]; },
  } as unknown as ExtensionAPI;
  const network = {
    allowedDomains: ["github.com", "*.github.com:443"],
    deniedDomains: ["uploads.github.com"],
  };
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-network-surfaces-"));
  const trustedHome = join(cwd, "home");
  const configPath = join(
    trustedHome,
    ".pi",
    "agent",
    "extensions",
    "pi-sandbox",
    "config.json",
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ network }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = trustedHome;
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  try {
    await registerPiSandbox(pi, {
      subagentProvider: "builtin",
      subagentManager: manager,
      sandbox: { broker: probeBroker },
    });
    assert.ok(bashTool);
    assert.ok(subagentTool);
    const bashResult = await bashTool.execute(
      "network-bash",
      { command: "probe" },
      undefined,
      undefined,
      ctx,
    );
    const bashText = bashResult.content[0]?.type === "text"
      ? bashResult.content[0].text
      : "";
    assert.deepEqual(JSON.parse(bashText).network, {
      ...network,
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
    });

    await subagentTool.execute(
      "network-subagent",
      { action: "start", task: "probe" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(subagentPolicy?.network.allowedDomains, network.allowedDomains);
    assert.deepEqual(subagentPolicy?.network.deniedDomains, network.deniedDomains);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
  }
});

linuxTest("subagent tool fails fast on invalid model before spawning", async () => {
  let subagentTool: ToolDefinition | undefined;
  let spawnAttempts = 0;
  const viableSession = () =>
    ({
      id: "viable-1",
      info: { id: "viable-1", state: "idle", text: "first" },
      onUpdate: () => () => {},
      prompt: async () => "t1",
      waitForSettled: async () => ({ text: "first -> second", exitCode: 0 }),
      followUp: async () => "t2",
      abort: async () => {},
    }) as unknown as Awaited<ReturnType<ProcessBackedSubagentManager["start"]>>;
  const fakeManager = {
    start: async () => {
      spawnAttempts++;
      return viableSession();
    },
    get: (id: string) =>
      id === "viable-1" ? viableSession() : undefined,
    list: () => [viableSession().info],
    remove: async () => {},
    shutdown: async () => {},
  } as unknown as ProcessBackedSubagentManager;
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "subagent") subagentTool = tool;
    },
    on() {},
    getActiveTools() {
      return ["bash", "subagent"];
    },
  } as unknown as ExtensionAPI;
  await registerPiSandbox(pi, {
    subagentProvider: "builtin",
    createSubagentManager: () => fakeManager,
  });
  assert.ok(subagentTool);
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-model-failfast-"));
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "model-failfast-session",
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      getAvailable: () => [
        { id: "claude-sonnet", provider: "anthropic" },
        { id: "shared-model", provider: "anthropic" },
        { id: "shared-model", provider: "openai" },
        { id: "tied", provider: "vertex" },
        { id: "tied", provider: "bedrock" },
      ],
    },
    model: { provider: "anthropic" },
  } as unknown as ExtensionContext;
  try {
    // Unknown provider/model -> throws before any spawn/session is created.
    await assert.rejects(
      subagentTool.execute(
        "bad-1",
        { action: "start", task: "x", model: "example/missing" },
        undefined,
        undefined,
        ctx,
      ),
      /unknown model 'example\/missing'/,
    );
    assert.equal(spawnAttempts, 0, "invalid model must not reach manager.start");

    // Ambiguous bare id with no preferred-provider match -> rejected with hint.
    await assert.rejects(
      subagentTool.execute(
        "bad-2",
        { action: "start", task: "x", model: "tied" },
        undefined,
        undefined,
        ctx,
      ),
      /multiple providers \(vertex, bedrock\)/,
    );
    assert.equal(spawnAttempts, 0, "ambiguous model must not spawn");

    // A valid explicit model passes validation and reaches manager.start.
    const started = await subagentTool.execute(
      "good-1",
      { action: "start", model: "anthropic/claude-sonnet", task: "x" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(spawnAttempts, 1, "valid model should reach manager.start");
    assert.equal(
      (started.content[0]?.type === "text" ? started.content[0].text : "").trim(),
      "first -> second",
    );

    // status/stop/follow_up are NOT intercepted by model validation even with
    // an invalid model param.
    spawnAttempts = 0;
    const status = await subagentTool.execute(
      "status-1",
      { action: "status", sessionId: "viable-1", model: "example/missing" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(spawnAttempts, 0);
    const statusText =
      status.content[0]?.type === "text" ? status.content[0].text : "";
    assert.match(statusText, /viable-1/);

    const followed = await subagentTool.execute(
      "follow-1",
      {
        action: "follow_up",
        sessionId: "viable-1",
        task: "second",
        model: "example/missing",
      },
      undefined,
      undefined,
      ctx,
    );
    const followText =
      followed.content[0]?.type === "text" ? followed.content[0].text : "";
    assert.equal(followText, "first -> second");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const tmuxTest =
  process.platform === "linux" &&
  spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0
    ? test
    : test.skip;

tmuxTest("preflight host backend reaches an isolated tmux socket", async () => {
  let bashTool: ToolDefinition | undefined;
  let approvals = 0;
  const approvalPrompts: string[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "bash") bashTool = tool;
    },
    on() {},
    getActiveTools() {
      return ["bash"];
    },
  } as unknown as ExtensionAPI;
  await registerPiSandbox(pi, {
    subagentProvider: "off",
    hostIPC: {
      mode: "ask",
      preflightCommandPrefixes: ["tmux"],
      retryOnUnixSocketError: true,
    },
  });
  assert.ok(bashTool);

  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-host-ipc-tmux-"));
  const socket = `pi-sandbox-smoke-${process.pid}-${Date.now()}`;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      async select(prompt: string) {
        approvals += 1;
        approvalPrompts.push(prompt);
        return "Allow this exact operation once";
      },
      notify() {},
    },
    sessionManager: {
      getSessionId: () => "host-ipc-smoke-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  const execute = async (command: string): Promise<string> => {
    const result = await bashTool!.execute(
      `call-${approvals}`,
      { command },
      undefined,
      undefined,
      ctx,
    );
    return result.content[0]?.type === "text" ? result.content[0].text : "";
  };

  try {
    await execute(
      `tmux -L ${socket} new-session -d -s smoke 'printf host-ipc-ok; sleep 30'`,
    );
    assert.match(
      await execute(`tmux -L ${socket} list-sessions`),
      /smoke:/,
    );
    assert.match(
      await execute(`tmux -L ${socket} capture-pane -p -t smoke:0.0`),
      /host-ipc-ok/,
    );
    assert.equal(approvals, 3);
    assert.match(approvalPrompts[1] ?? "", /tmux .* list-sessions/);
    assert.match(approvalPrompts[2] ?? "", /tmux .* capture-pane/);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
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
      ...(provider === "pi-subagents" ? { allowedNativeAgents: ["worker"] } : {}),
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
      tool_call: 1,
      tool_result: 1,
      session_start: 1,
      session_shutdown: 1,
    },
  );
});

test("session start diagnoses external subagent ownership and security level", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-sandbox-native-config-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const upstreamConfig = join(agentDir, "extensions", "subagent", "config.json");
  mkdirSync(dirname(upstreamConfig), { recursive: true });
  writeFileSync(upstreamConfig, JSON.stringify({ scheduledRuns: { enabled: false } }));
  const cases = [
    {
      activeTools: [] as string[],
      tools: [] as ReturnType<ExtensionAPI["getAllTools"]>,
      expected: /no external subagent tool is active/,
      level: "warning",
      fails: true,
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
      expected: /tool boundary, not outer worker process isolation/,
      level: "info",
      fails: false,
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
      fails: true,
    },
  ] as const;

  try {
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
    await registerPiSandbox(pi, {
      subagentProvider: "pi-subagents",
      allowedNativeAgents: ["worker"],
    });
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: { getSessionId: () => `native-${diagnosticCase.level}` },
    } as unknown as ExtensionContext;

    if (diagnosticCase.fails) {
      await assert.rejects(sessionStart?.({}, ctx) as Promise<unknown>, diagnosticCase.expected);
      continue;
    }
    await sessionStart?.({}, ctx);

    const diagnostic = notifications.find(({ message }) =>
      diagnosticCase.expected.test(message),
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.level, diagnosticCase.level);
  }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("native child acknowledges pi-sandbox without requiring parent orchestration", async () => {
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  const acknowledgements: unknown[] = [];
  const pi = {
    registerTool() {},
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (event === "session_start") sessionStart = handler;
    },
    events: {
      emit(event: string, payload: unknown) {
        if (event === "subagent:acknowledge-extension") acknowledgements.push(payload);
      },
    },
    getActiveTools: () => ["bash"],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  try {
    await registerPiSandbox(pi, { subagentProvider: "pi-subagents" });
    await sessionStart?.({}, {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: { getSessionId: () => "native-child" },
    } as unknown as ExtensionContext);
    assert.deepEqual(acknowledgements, [{ id: "@erichll:pi-sandbox" }]);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
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
