import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { AuthorizerRegistry } from "../../../node_modules/@gotgenes/pi-permission-system/src/authority/authorizer-registry.ts";
import { composeAuthorizerChain } from "../../../node_modules/@gotgenes/pi-permission-system/src/authority/authorizer-chain.ts";
import { encloseInDelegationEnvelope } from "../../../node_modules/@gotgenes/pi-permission-system/src/authority/delegation-envelope.ts";
import {
  createPiAutoReviewExtension,
  loadConfig,
  type Config,
} from "../src/index.ts";
import { getBoundaryBroker } from "../src/broker/index.ts";
import { boundaryRequestHash } from "../src/broker/grants.ts";
import { approveSandboxTrap } from "../../pi-sandbox/src/approval.ts";

const PERMISSIONS_SERVICE_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:service",
);

type ModelBehavior =
  | string
  | Error
  | ((signal: AbortSignal) => Promise<string>);

class PermissionPromptComponent {
  constructor(
    private readonly message: string,
  ) {}

  render(): string[] {
    return ["Permission Required", this.message];
  }
}

class UnrelatedPromptComponent {
  render(): string[] {
    return ["Unrelated custom UI"];
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    retries: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function harness(
  behavior: ModelBehavior,
  options: {
    config?: Config;
    providerAvailable?: boolean;
    signal?: AbortSignal;
    interactiveTui?: boolean;
    uiPromptRequestId?: string;
    recognizePermissionComponent?: boolean;
  } = {},
) {
  const registry = new AuthorizerRegistry();
  const events = new EventEmitter();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const reviews: Array<{ event: string; data: Record<string, unknown> }> = [];
  const modelContexts: unknown[] = [];
  const sentUserMessages: string[] = [];
  const uiDecisions: unknown[] = [];
  const modelCallOptions: Array<Record<string, unknown>> = [];
  let reviewerResolveCalls = 0;
  let reviewerMetaCalls = 0;
  const service = {
    registerAuthorizer: registry.register.bind(registry),
    checkPermission: () => "ask",
  };
  (globalThis as Record<symbol, unknown>)[PERMISSIONS_SERVICE_KEY] = service;

  const pi = {
    events,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, command);
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
  };
  const model = {
    id: "codex-auto-review",
    name: "codex-auto-review",
    provider: "test-provider",
    api: "test-api",
  };
  const streamSimple = (
    _model: unknown,
    modelContext: unknown,
    callOptions: { signal: AbortSignal; sessionId?: string },
  ) => {
    modelContexts.push(modelContext);
    modelCallOptions.push(callOptions);
    return {
    async result() {
      if (behavior instanceof Error) throw behavior;
      const text =
        typeof behavior === "function"
          ? await behavior(callOptions.signal)
          : behavior;
      return {
        stopReason: "stop",
        content: [{ type: "text", text }],
      };
    },
    };
  };
  let currentModel: Record<string, unknown> = model;
  let currentStreamSimple: typeof streamSimple = streamSimple;
  let currentAuth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    env?: Record<string, string>;
  } = { apiKey: "test" };
  const seenModels: Record<string, unknown>[] = [];
  const context = {
    cwd: process.cwd(),
    signal: options.signal,
    mode: options.interactiveTui ? "tui" : "rpc",
    hasUI: options.interactiveTui === true,
    ui: {
      custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (decision: unknown) => void,
        ) => unknown,
        _options: unknown,
      ) {
        return new Promise((resolve) => {
          let settled = false;
          const done = (decision: unknown) => {
            if (settled) return;
            settled = true;
            uiDecisions.push(decision);
            resolve(decision);
          };
          factory({}, {}, {}, done);
          queueMicrotask(() =>
            done({ approved: false, state: "denied" }),
          );
        });
      },
    },
    modelRegistry: {
      find: () =>
        options.providerAvailable === false ? undefined : currentModel,
      getAvailable: () => {
        reviewerMetaCalls++;
        return options.providerAvailable === false ? [] : [currentModel];
      },
      getApiKeyAndHeaders: async (modelArg: unknown) => {
        reviewerResolveCalls++;
        seenModels.push(modelArg as Record<string, unknown>);
        return { ok: true, ...currentAuth };
      },
      getRegisteredProviderConfig: () => ({
        api: "test-api",
        streamSimple: currentStreamSimple,
      }),
    },
    sessionManager: {
      getSessionId: () => "integration-session",
      buildContextEntries: () => [
        {
          message: {
            role: "user",
            content: "Run the exact operation requested in this test.",
          },
        },
      ],
    },
  };

  createPiAutoReviewExtension({
    config: options.config ?? config(),
    allowUntrustedWorkspace: true,
  })(pi as never);
  handlers.get("session_start")?.({}, context);
  events.emit("permissions:ready");

  const log = {
    review(event: string, data: Record<string, unknown>) {
      reviews.push({ event, data });
    },
  };
  const query = {
    checkPermission: () => "ask",
    getToolPermission: () => "ask",
  };

  return {
    async authorize(
      surface: string,
      overrides: Record<string, unknown> = {},
    ) {
      const registered = registry.get("pi-auto-review");
      assert.ok(registered, "pi-auto-review registered through the service");
      let terminalCalls = 0;
      const chain = composeAuthorizerChain(
        [{ authorize: encloseInDelegationEnvelope(registered) }],
        {
          async authorize(details) {
            terminalCalls++;
            if (options.interactiveTui) {
              events.emit("permissions:ui_prompt", {
                requestId:
                  options.uiPromptRequestId ?? details.requestId,
                source: details.source,
                surface: details.surface ?? null,
                value: details.value ?? null,
                agentName: details.agentName ?? null,
                message: details.message,
                forwarding: details.forwarding ?? null,
              });
              return context.ui.custom(
                (_tui, _theme, _keybindings, _done) =>
                  options.recognizePermissionComponent === false
                    ? new UnrelatedPromptComponent()
                    : new PermissionPromptComponent(details.message),
                { overlay: false },
              ) as never;
            }
            return { approved: false, state: "denied" };
          },
        },
        query as never,
        log,
      );
      const pathSurface =
        surface === "path" || surface === "external_directory";
      const decision = await chain.authorize({
        requestId: `request-${surface}`,
        surface: surface === "external_directory" ? undefined : surface,
        source: "tool",
        message: "test request",
        command: surface === "bash_escalated" ? "touch /tmp/reviewed" : undefined,
        path: pathSurface ? "/tmp/reviewed" : undefined,
        accessIntent: pathSurface
          ? {
              surface,
              matchValues: ["/tmp/reviewed"],
              boundaryValue: "/tmp/reviewed",
            }
          : undefined,
        ...overrides,
      });
      return { decision, terminalCalls };
    },
    handlers,
    commands,
    reviews,
    modelContexts,
    sentUserMessages,
    uiDecisions,
    modelCallOptions,
    context,
    get reviewerResolveCalls() {
      return reviewerResolveCalls;
    },
    get reviewerMetaCalls() {
      return reviewerMetaCalls;
    },
    get seenModels() {
      return seenModels;
    },
    // Simulate a mid-session models.json / provider refresh: re-register a
    // different model (and optionally stream binding) so the next review
    // must observe the new metadata instead of a stale cached object.
    setRegistry(models: {
      model: Record<string, unknown>;
      streamSimple?: typeof streamSimple;
    }) {
      currentModel = models.model;
      if (models.streamSimple !== undefined) {
        currentStreamSimple = models.streamSimple;
      }
    },
    setAuth(auth: typeof currentAuth) {
      currentAuth = auth;
    },
    dispose() {
      handlers.get("session_shutdown")?.();
      delete (globalThis as Record<symbol, unknown>)[PERMISSIONS_SERVICE_KEY];
    },
  };
}

const allow =
  '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Narrow authorized operation."}';
const deny =
  '{"outcome":"deny","risk_level":"high","user_authorization":"unknown","rationale":"Authorization is insufficient."}';
const defer =
  '{"outcome":"defer","risk_level":"medium","user_authorization":"unknown","rationale":"Human confirmation is required."}';

test("request hashes bind forwarded requester sessions", () => {
  const request = {
    id: "request",
    source: "permission-system" as const,
    surface: "bash_escalated",
    operation: "tool",
    cwd: "/parent-cwd",
    command: "printf exact",
    agentName: "worker",
    requesterSessionId: "child-a",
  };
  assert.notEqual(
    boundaryRequestHash(request),
    boundaryRequestHash({ ...request, requesterSessionId: "child-b" }),
  );
});

test("real permission-system authorizer chain integration", async (t) => {
  await t.test("ask is decided as allow, deny, or terminal defer", async () => {
    for (const [output, approved, terminalCalls] of [
      [allow, true, 0],
      [deny, false, 0],
      [defer, false, 1],
    ] as const) {
      const instance = harness(output);
      try {
        const result = await instance.authorize("bash_escalated");
        assert.equal(result.decision.approved, approved);
        assert.equal(result.terminalCalls, terminalCalls);
      } finally {
        instance.dispose();
      }
    }
  });

  await t.test("forwarded v24 evidence reaches reviewer and audit records", async () => {
    const instance = harness(allow);
    try {
      const result = await instance.authorize("tool", {
        requestId: "forwarded-bash",
        surface: "tool",
        value: "printf forwarded",
        accessIntent: {
          surface: "bash_escalated",
          matchValues: ["printf forwarded"],
        },
        forwarding: {
          requesterAgentName: "worker-a",
          requesterSessionId: "child-session-a",
        },
      });
      assert.equal(result.decision.approved, true);
      const rendered = JSON.stringify(instance.modelContexts.at(-1));
      assert.match(rendered, /printf forwarded/);
      assert.match(rendered, /worker-a/);
      assert.match(rendered, /child-session-a/);
      const audit = instance.reviews.at(-1)?.data;
      assert.equal(audit?.command, "printf forwarded");
      assert.equal(audit?.agentName, "worker-a");
      assert.equal(audit?.requesterSessionId, "child-session-a");
    } finally {
      instance.dispose();
    }
  });

  await t.test("forwarded dangerous Bash is denied before the model", async () => {
    const instance = harness(allow);
    try {
      const result = await instance.authorize("tool", {
        requestId: "forwarded-danger",
        surface: "tool",
        value: "rm -rf $HOME",
        accessIntent: {
          surface: "bash_escalated",
          matchValues: ["rm -rf $HOME"],
        },
        forwarding: { requesterAgentName: "worker-a", requesterSessionId: "child-a" },
      });
      assert.equal(result.decision.approved, false);
      assert.equal(instance.modelContexts.length, 0);
      assert.equal(instance.reviews.at(-1)?.data.command, "rm -rf $HOME");
    } finally {
      instance.dispose();
    }
  });

  await t.test("forwarded path preserves child canonical boundary and remains capped", async () => {
    const instance = harness(allow);
    try {
      const result = await instance.authorize("tool", {
        requestId: "forwarded-path",
        surface: "tool",
        value: "/worktree/src/file.ts",
        accessIntent: {
          surface: "path",
          matchValues: ["/worktree/src/file.ts", "/worktree/src"],
          boundaryValue: "/canonical/worktree/src",
        },
        forwarding: { requesterAgentName: "worker-a", requesterSessionId: "child-a" },
      });
      assert.equal(result.decision.approved, false);
      assert.equal(result.terminalCalls, 1);
      const rendered = JSON.stringify(instance.modelContexts.at(-1));
      assert.match(rendered, /canonical\/worktree\/src/);
      assert.match(rendered, /worktree\/src\/file.ts/);
      assert.equal(instance.reviews.at(-1)?.data.allowCapped, true);
    } finally {
      instance.dispose();
    }
  });

  await t.test("path and external_directory allows are capped", async () => {
    for (const surface of ["path", "external_directory"]) {
      const instance = harness(allow);
      try {
        const result = await instance.authorize(surface);
        assert.equal(result.decision.approved, false);
        assert.equal(result.terminalCalls, 1);
        assert.equal(
          instance.reviews.at(-1)?.data.allowCapped,
          true,
        );
      } finally {
        instance.dispose();
      }
    }
  });

  await t.test("model allow auto-confirms external_directory in the v24 TUI terminal", async () => {
    const instance = harness(allow, { interactiveTui: true });
    try {
      const result = await instance.authorize("external_directory");
      assert.equal(result.decision.approved, true);
      assert.equal(result.decision.autoApproved, true);
      assert.equal(result.terminalCalls, 1);
      assert.deepEqual(instance.uiDecisions, [
        {
          approved: true,
          state: "approved",
          autoApproved: true,
        },
      ]);
      assert.equal(
        instance.reviews.at(-1)?.data.autoConfirmQueued,
        true,
      );
    } finally {
      instance.dispose();
    }
  });

  await t.test("trusted config can leave capped allows for manual review", async () => {
    const instance = harness(allow, {
      interactiveTui: true,
      config: config({ autoConfirmBoundedAllows: [] }),
    });
    try {
      const result = await instance.authorize("external_directory");
      assert.equal(result.decision.approved, false);
      assert.equal(result.terminalCalls, 1);
      assert.equal(
        instance.reviews.at(-1)?.data.autoConfirmQueued,
        false,
      );
    } finally {
      instance.dispose();
    }
  });

  await t.test("request or permission-component mismatch fails closed", async () => {
    for (const options of [
      {
        interactiveTui: true,
        uiPromptRequestId: "different-request",
      },
      {
        interactiveTui: true,
        recognizePermissionComponent: false,
      },
    ]) {
      const instance = harness(allow, options);
      try {
        const result = await instance.authorize("external_directory");
        assert.equal(result.decision.approved, false);
        assert.deepEqual(instance.uiDecisions, [
          { approved: false, state: "denied" },
        ]);
      } finally {
        instance.dispose();
      }
    }
  });

  await t.test("provider missing and malformed JSON fail closed", async () => {
    for (const createInstance of [
      () => harness(allow, { providerAvailable: false }),
      () => harness('{"outcome":"allow","extra":true}'),
    ]) {
      const instance = createInstance();
      try {
        const result = await instance.authorize("bash_escalated");
        assert.equal(result.decision.approved, false);
        assert.equal(result.terminalCalls, 0);
      } finally {
        instance.dispose();
      }
    }
  });

  await t.test("timeout and session abort fail closed", async () => {
    const timeout = harness(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    try {
      const result = await timeout.authorize("bash_escalated");
      assert.equal(result.decision.approved, false);
    } finally {
      timeout.dispose();
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = harness(allow, { signal: controller.signal });
    try {
      const result = await aborted.authorize("bash_escalated");
      assert.equal(result.decision.approved, false);
    } finally {
      aborted.dispose();
    }
  });

  await t.test("sandbox consumes the exact one-shot grant", async () => {
    const instance = harness(allow);
    try {
      const broker = getBoundaryBroker();
      assert.ok(broker);
      const result = await approveSandboxTrap(
        {
          kind: "filesystem",
          code: "FILESYSTEM_DENIED",
          state: "query",
          query_id: "77",
          operation: "write",
          path: "/tmp/reviewed",
          requested_path: "/tmp/reviewed",
          syscall: "openat",
          errno: "EACCES",
          flags: ["O_WRONLY"],
          reason: "allow_miss",
          suggested_grant: { allowWrite: "/tmp/reviewed" },
          process: {
            pid: process.pid,
            exe: "/usr/bin/touch",
            cwd: process.cwd(),
          },
          mechanism: "seccomp",
        },
        {
          broker,
          command: "touch /tmp/reviewed",
          cwd: process.cwd(),
          sessionId: "integration-session",
          scopeKey: "turn-1",
        },
      );
      assert.equal(result.action, "allow");
      assert.equal(result.source, "reviewer");
    } finally {
      instance.dispose();
    }
  });

  await t.test("security package writes are hard-denied before review", async () => {
    const instance = harness(allow);
    try {
      const broker = getBoundaryBroker();
      assert.ok(broker);
      const protectedPath = join(
        process.cwd(),
        "packages",
        "pi-auto-review",
        "src",
        "config.json",
      );
      const result = await approveSandboxTrap(
        {
          kind: "filesystem",
          code: "FILESYSTEM_DENIED",
          state: "query",
          query_id: "78",
          operation: "write",
          path: protectedPath,
          requested_path: protectedPath,
          syscall: "openat",
          errno: "EACCES",
          flags: ["O_WRONLY"],
          reason: "allow_miss",
          suggested_grant: { allowWrite: protectedPath },
          process: {
            pid: process.pid,
            exe: "/usr/bin/sh",
            cwd: process.cwd(),
          },
          mechanism: "seccomp",
        },
        {
          broker,
          command: `printf tamper > '${protectedPath}'`,
          cwd: process.cwd(),
          sessionId: "integration-session",
          scopeKey: "turn-2",
        },
      );
      assert.equal(result.action, "deny");
      assert.match(result.reason || "", /security.*forbidden/i);
    } finally {
      instance.dispose();
    }
  });

  await t.test("security configuration writes are hard-denied", async () => {
    const instance = harness(allow);
    try {
      const broker = getBoundaryBroker();
      assert.ok(broker);
      const protectedPath = `${process.cwd()}/.pi/settings.json`;
      const result = await approveSandboxTrap(
        {
          kind: "filesystem",
          code: "FILESYSTEM_DENIED",
          state: "query",
          query_id: "78",
          operation: "write",
          path: protectedPath,
          requested_path: ".pi/settings.json",
          syscall: "openat",
          errno: "EACCES",
          flags: ["O_WRONLY"],
          reason: "allow_miss",
          suggested_grant: { allowWrite: protectedPath },
          process: {
            pid: process.pid,
            exe: "/usr/bin/touch",
            cwd: process.cwd(),
          },
          mechanism: "seccomp",
        },
        {
          broker,
          command: "touch .pi/settings.json",
          cwd: process.cwd(),
          sessionId: "integration-session",
          scopeKey: "turn-1",
        },
      );
      assert.equal(result.action, "deny");
      assert.equal(result.source, "reviewer");
      assert.match(result.reason ?? "", /security|configuration|forbidden/i);
    } finally {
      instance.dispose();
    }
  });

  await t.test("/approve selects one denial and injects trusted retry evidence", async () => {
    const instance = harness(deny);
    const notices: string[] = [];
    try {
      const first = await instance.authorize("bash_escalated");
      assert.equal(first.decision.approved, false);
      const command = instance.commands.get("approve");
      assert.ok(command);
      await command.handler("", {
        ...instance.context,
        hasUI: true,
        mode: "tui",
        isIdle: () => true,
        ui: {
          async select(_title: string, choices: string[]) {
            assert.equal(choices.length, 1);
            return choices[0];
          },
          notify(message: string) {
            notices.push(message);
          },
        },
      });
      assert.match(notices.at(-1) ?? "", /authorized once/i);
      assert.match(
        instance.sentUserMessages.at(-1) ?? "",
        /Retry the prior tool call once/,
      );

      const retry = await instance.authorize("bash_escalated");
      assert.equal(retry.decision.approved, false);
      const rendered = JSON.stringify(instance.modelContexts.at(-1));
      assert.match(rendered, /<trusted-user-override>/);
      assert.match(rendered, /request-bash_escalated/);

      await command.handler("", {
        ...instance.context,
        hasUI: true,
        mode: "tui",
        isIdle: () => true,
        ui: {
          async select(_title: string, choices: string[]) {
            return choices[0];
          },
          notify(message: string) {
            notices.push(message);
          },
        },
      });
      assert.match(notices.at(-1) ?? "", /already approved|expired/i);
    } finally {
      instance.dispose();
    }
  });

  await t.test("reviewer metadata and auth are re-resolved per review so registry refreshes take effect", async () => {
    const instance = harness(deny);
    try {
      const first = await instance.authorize("bash_escalated");
      const second = await instance.authorize("bash_escalated");
      assert.equal(first.decision.approved, false);
      assert.equal(second.decision.approved, false);
      assert.equal(
        instance.reviewerMetaCalls,
        2,
        "reviewer metadata (model/stream/session) should be re-resolved per review so a mid-session registry refresh is observed",
      );
      assert.equal(
        instance.reviewerResolveCalls,
        2,
        "authentication should be reacquired for each review so rotated OAuth tokens or dynamic model headers never go stale",
      );
    } finally {
      instance.dispose();
    }
  });

  await t.test("reviewer uses refreshed model metadata after a mid-session registry refresh", async () => {
    const instance = harness(deny);
    try {
      const first = await instance.authorize("bash_escalated");
      assert.equal(first.decision.approved, false);
      // A models.json / provider refresh swaps the model record (and its
      // baseUrl/api/headers binding) while the session stays alive.
      instance.setRegistry({
        model: {
          id: "codex-auto-review",
          name: "codex-auto-review",
          provider: "test-provider",
          api: "test-api",
          baseUrl: "https://refreshed.example/base",
        },
      });
      const second = await instance.authorize("bash_escalated");
      assert.equal(second.decision.approved, false);
      assert.equal(
        instance.reviewerMetaCalls,
        2,
        "metadata must be re-resolved instead of cached for the session",
      );
      assert.equal(instance.seenModels.length, 2);
      assert.equal(
        (instance.seenModels[1] as Record<string, unknown>).baseUrl,
        "https://refreshed.example/base",
        "the second review must talk through the refreshed model object, not the stale cached one",
      );
      assert.equal(instance.modelCallOptions.length, 2);
      const firstSessionId = instance.modelCallOptions[0]?.sessionId;
      const secondSessionId = instance.modelCallOptions[1]?.sessionId;
      assert.equal(typeof firstSessionId, "string");
      assert.equal(typeof secondSessionId, "string");
      assert.notEqual(
        secondSessionId,
        firstSessionId,
        "an endpoint refresh must change pi-ai's session-based WebSocket cache identity",
      );
      assert.ok(
        (secondSessionId as string).length <= 64,
        "the endpoint fingerprint must survive pi-ai's prompt-cache-key clamp",
      );
    } finally {
      instance.dispose();
    }
  });

  await t.test("reviewer rotates the WebSocket identity when effective authentication headers refresh", async () => {
    const instance = harness(deny);
    try {
      instance.setAuth({
        apiKey: "first-token",
        headers: { "x-reviewer-auth": "first" },
      });
      const first = await instance.authorize("bash_escalated");
      assert.equal(first.decision.approved, false);

      instance.setAuth({
        apiKey: "second-token",
        headers: { "x-reviewer-auth": "second" },
      });
      const second = await instance.authorize("bash_escalated");
      assert.equal(second.decision.approved, false);

      const firstOptions = instance.modelCallOptions[0];
      const secondOptions = instance.modelCallOptions[1];
      assert.deepEqual(firstOptions?.headers, { "x-reviewer-auth": "first" });
      assert.deepEqual(secondOptions?.headers, { "x-reviewer-auth": "second" });
      assert.notEqual(
        secondOptions?.sessionId,
        firstOptions?.sessionId,
        "refreshed handshake authentication must not reuse pi-ai's cached WebSocket",
      );
    } finally {
      instance.dispose();
    }
  });
});
