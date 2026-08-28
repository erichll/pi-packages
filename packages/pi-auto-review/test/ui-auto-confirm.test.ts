import assert from "node:assert/strict";
import test from "node:test";
import { PermissionUiAutoConfirmer } from "../src/ui-auto-confirm.ts";

class PermissionPromptComponent {
  constructor(private readonly lines: string[]) {}
  render(): string[] {
    return this.lines;
  }
}

class UnrelatedPromptComponent {
  render(): string[] {
    return ["Permission Required", "path : /tmp/reviewed"];
  }
}

const AUTO_APPROVED = {
  approved: true,
  state: "approved",
  autoApproved: true,
} as const;

const HUMAN_DENIED = { approved: false, state: "denied" } as const;

function v26Prompt(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    source: "tool_call",
    surface: "bash",
    value: "/tmp/reviewed",
    agentName: null,
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "external_directory",
      toolName: "bash",
      invokedToolName: null,
      value: "/tmp/reviewed",
      matchedPattern: "*",
      commandContext: null,
      executedUnit: null,
    },
    forwarding: null,
    ...overrides,
  };
}

async function runPrompt(options: {
  event: unknown;
  component: unknown;
  overlay?: boolean;
  stageId?: string;
  stageSurface?: string;
  surfaces?: readonly string[];
}) {
  const decisions: unknown[] = [];
  const ctx = {
    mode: "tui" as const,
    hasUI: true,
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
            decisions.push(decision);
            resolve(decision);
          };
          factory({}, {}, {}, done);
          queueMicrotask(() => done(HUMAN_DENIED));
        });
      },
    },
  };
  const confirmer = new PermissionUiAutoConfirmer(
    () => options.surfaces ?? ["external_directory", "path"],
  );
  confirmer.stage(
    options.stageId ?? "req-1",
    options.stageSurface ?? "external_directory",
  );
  confirmer.handlePrompt(options.event, ctx as never);
  const decision = await ctx.ui.custom(
    () => options.component,
    { overlay: options.overlay ?? false },
  );
  return { decision, decisions };
}

const dialog = () =>
  new PermissionPromptComponent([
    "Permission Required",
    "tool              : bash",
    "surface           : external_directory",
    "rule              : *",
    "path              : /tmp/reviewed",
  ]);

test("26.x ui_prompt without message auto-confirms the matching dialog", async () => {
  const result = await runPrompt({
    event: v26Prompt(),
    component: dialog(),
  });
  assert.deepEqual(result.decision, AUTO_APPROVED);
  assert.deepEqual(result.decisions, [AUTO_APPROVED]);
});

test("top-level value is enough when request.value is absent", async () => {
  const event = v26Prompt({
    value: "/tmp/reviewed",
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "external_directory",
      toolName: "bash",
      invokedToolName: null,
      value: "",
      matchedPattern: "*",
      commandContext: null,
      executedUnit: null,
    },
  });
  const result = await runPrompt({ event, component: dialog() });
  assert.deepEqual(result.decision, AUTO_APPROVED);
});

test("legacy message still auto-confirms", async () => {
  const result = await runPrompt({
    event: {
      requestId: "req-1",
      source: "tool_call",
      surface: "external_directory",
      value: null,
      agentName: null,
      message: "/tmp/reviewed",
      forwarding: null,
    },
    component: dialog(),
  });
  assert.deepEqual(result.decision, AUTO_APPROVED);
});

test("subagent title still matches Permission Required", async () => {
  const result = await runPrompt({
    event: v26Prompt(),
    component: new PermissionPromptComponent([
      "Permission Required (Subagent)",
      "path : /tmp/reviewed",
    ]),
  });
  assert.deepEqual(result.decision, AUTO_APPROVED);
});

test("long command matches the 80-character dialog prefix", async () => {
  const command = `rg -n fingerprint ${"/very/long/path/segment".repeat(8)} --glob '*.ts'`;
  assert.ok(command.length > 80);
  const result = await runPrompt({
    event: v26Prompt({
      value: command,
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "external_directory",
        toolName: "bash",
        invokedToolName: null,
        value: command,
        matchedPattern: "*",
        commandContext: null,
        executedUnit: null,
      },
    }),
    component: new PermissionPromptComponent([
      "Permission Required",
      `command : ${command.slice(0, 80)}\u2026`,
    ]),
  });
  assert.deepEqual(result.decision, AUTO_APPROVED);
});

test("requestId mismatch leaves the human dialog in control", async () => {
  const result = await runPrompt({
    event: v26Prompt({ requestId: "other-request" }),
    component: dialog(),
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("gate-surface mismatch does not auto-confirm", async () => {
  const result = await runPrompt({
    event: v26Prompt({
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "path",
        toolName: "read",
        invokedToolName: null,
        value: "/tmp/reviewed",
        matchedPattern: "*",
        commandContext: null,
        executedUnit: null,
      },
    }),
    component: dialog(),
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("directional surfaces use family configuration but bind the exact prompt surface", async () => {
  for (const [surface, family] of [
    ["path_read", "path"],
    ["path_write", "path"],
    ["external_directory_read", "external_directory"],
    ["external_directory_write", "external_directory"],
  ] as const) {
    const request = {
      ...(v26Prompt().request as Record<string, unknown>),
      surface,
    };
    const approved = await runPrompt({
      event: v26Prompt({ request }),
      component: dialog(),
      stageSurface: surface,
      surfaces: [family],
    });
    assert.deepEqual(approved.decision, AUTO_APPROVED, surface);

    const disabled = await runPrompt({
      event: v26Prompt({ request }),
      component: dialog(),
      stageSurface: surface,
      surfaces: [],
    });
    assert.deepEqual(disabled.decision, HUMAN_DENIED, surface);
  }
});

test("a path_read pending approval cannot confirm a path_write prompt", async () => {
  const result = await runPrompt({
    event: v26Prompt({
      request: {
        ...(v26Prompt().request as Record<string, unknown>),
        surface: "path_write",
      },
    }),
    component: dialog(),
    stageSurface: "path_read",
    surfaces: ["path"],
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("a directional pending approval requires request.surface evidence", async () => {
  const result = await runPrompt({
    event: {
      requestId: "req-1",
      source: "tool_call",
      surface: "read",
      value: "/tmp/reviewed",
    },
    component: dialog(),
    stageSurface: "path_read",
    surfaces: ["path"],
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("display surface bash does not block an external_directory gate", async () => {
  const result = await runPrompt({
    event: v26Prompt({ surface: "bash" }),
    component: dialog(),
  });
  assert.deepEqual(result.decision, AUTO_APPROVED);
});

test("unrecognized component is not auto-confirmed", async () => {
  const result = await runPrompt({
    event: v26Prompt(),
    component: new UnrelatedPromptComponent(),
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("overlay dialogs are left for the human", async () => {
  const result = await runPrompt({
    event: v26Prompt(),
    component: dialog(),
    overlay: true,
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});

test("event without value or message is ignored", async () => {
  const result = await runPrompt({
    event: {
      requestId: "req-1",
      source: "tool_call",
      surface: "bash",
      value: null,
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "external_directory",
        toolName: "bash",
        invokedToolName: null,
        value: "",
        matchedPattern: "*",
        commandContext: null,
        executedUnit: null,
      },
      forwarding: null,
    },
    component: dialog(),
  });
  assert.deepEqual(result.decision, HUMAN_DENIED);
});
