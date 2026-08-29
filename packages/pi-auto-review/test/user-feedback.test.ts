import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUserReviewEntryData,
  buildUserReviewNotice,
  buildUserReviewStatus,
  compactReviewText,
  formatReviewDuration,
  formatReviewMeta,
  formatReviewModelName,
  formatReviewTokenCount,
  formatReviewUsage,
  formatUserReviewQuoteMessage,
  buildUserReviewWidgetData,
  buildUserReviewGroupLines,
  renderUserReviewQuoteLines,
  renderUserReviewWidgetLines,
  reviewTargetFromRequest,
  truncateReviewText,
  UserReviewWidgetController,
} from "../src/user-feedback.ts";

test("compactReviewText collapses whitespace and bounds length", () => {
  assert.equal(compactReviewText("  a\n\tb  "), "a b");
  assert.equal(compactReviewText("x".repeat(20), 8), "xxxxxxxx");
});

test("truncateReviewText uses an ellipsis when widget text is bounded", () => {
  assert.equal(truncateReviewText("  a\n b  ", 8), "a b");
  assert.equal(truncateReviewText("abcdefghij", 6), "abcde…");
});

test("reviewTargetFromRequest prefers resolved path then path/command", () => {
  assert.equal(
    reviewTargetFromRequest({
      resolvedPath: "/tmp/real",
      path: "/tmp/link",
      command: "echo hi",
    }),
    "/tmp/real",
  );
  assert.equal(
    reviewTargetFromRequest({
      path: "/workspace/file.ts",
      command: "cat file.ts",
    }),
    "/workspace/file.ts",
  );
  assert.equal(
    reviewTargetFromRequest({ command: "git push origin main" }),
    "git push origin main",
  );
});

test("buildUserReviewStatus shows surface and compact target", () => {
  assert.equal(
    buildUserReviewStatus("path", "/tmp/outside"),
    "auto-review · reviewing · path · /tmp/outside",
  );
  assert.equal(
    buildUserReviewStatus("bash"),
    "auto-review · reviewing · bash",
  );
});

test("formatReviewTokenCount uses compact units", () => {
  assert.equal(formatReviewTokenCount(86), "86");
  assert.equal(formatReviewTokenCount(2400), "2.4k");
  assert.equal(formatReviewTokenCount(12_400), "12k");
});

test("formatReviewUsage prefers in/out and omits unavailable counters", () => {
  assert.equal(
    formatReviewUsage({
      availability: "unknown_provenance",
      input: 2400,
      output: 86,
      cacheRead: 800,
    }),
    "2.4k toks in (800 toks cache) · 86 toks out",
  );
  assert.equal(
    formatReviewUsage({
      availability: "estimated",
      totalTokens: 1200,
    }),
    "~1.2k toks",
  );
  assert.equal(
    formatReviewUsage({ availability: "unavailable" }),
    undefined,
  );
});

test("formatReviewModelName drops a leading provider segment", () => {
  assert.equal(formatReviewModelName("cliproxyapi/gpt-5-mini"), "gpt-5-mini");
  assert.equal(formatReviewModelName("openai/gpt-4.1"), "gpt-4.1");
  assert.equal(formatReviewModelName("codex-auto-review"), "codex-auto-review");
  assert.equal(formatReviewModelName("provider/org/model"), "org/model");
});

test("formatReviewMeta joins model, usage, duration, and extra calls", () => {
  assert.equal(
    formatReviewMeta({
      model: "cliproxyapi/gpt-5-mini",
      usage: {
        availability: "unknown_provenance",
        input: 2400,
        output: 86,
      },
      durationMs: 1120,
      attempts: 2,
    }),
    "gpt-5-mini · 2.4k toks in · 86 toks out · 1.1s · 2 calls",
  );
  assert.equal(formatReviewDuration(340), "340ms");
  assert.equal(formatReviewMeta({}), undefined);
});

test("buildUserReviewNotice covers decisive user outcomes", () => {
  assert.deepEqual(
    buildUserReviewNotice({
      outcome: "allow",
      surface: "bash",
      target: "ls",
      rationale: "read-only listing",
      model: "cliproxyapi/gpt-5-mini",
      usage: {
        availability: "unknown_provenance",
        input: 2100,
        output: 64,
      },
      durationMs: 900,
    }),
    {
      type: "info",
      message: [
        "Auto-review · allowed · bash",
        "ls · read-only listing",
        "gpt-5-mini · 2.1k toks in · 64 toks out · 900ms",
      ].join("\n"),
    },
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "auto_confirm",
      surface: "external_directory",
      target: "/tmp/x",
    }).message,
    "Auto-review · allowed · auto-confirm · external_directory\n/tmp/x",
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "needs_confirmation",
      surface: "path",
      target: "/etc/hosts",
    }).message,
    "Auto-review · allowed · confirm locally · path\n/etc/hosts",
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "defer",
      surface: "bash",
      target: "curl example.com",
      rationale: "network side effects",
    }).message,
    [
      "Auto-review · deferred · bash",
      "curl example.com · network side effects",
    ].join("\n"),
  );

  const denied = buildUserReviewNotice({
    outcome: "deny",
    surface: "bash",
    target: "rm -rf /",
    rationale: "destructive root wipe",
    recoveryCommand: "/auto-review-approve",
  });
  assert.equal(denied.type, "warning");
  assert.match(denied.message, /^Auto-review · denied · bash\n/);
  assert.match(denied.message, /\/auto-review-approve/);

  const localDeny = buildUserReviewNotice({
    outcome: "deny",
    surface: "bash",
    target: "cat ~/.ssh/id_rsa",
    rationale: "credential file",
    recoveryCommand: false,
  });
  assert.match(localDeny.message, /cannot be overridden/);
  assert.doesNotMatch(localDeny.message, /cliproxyapi|tok| in ·/);

  const breaker = buildUserReviewNotice({
    outcome: "circuit_breaker",
    surface: "bash",
  });
  assert.equal(breaker.type, "warning");
  assert.match(breaker.message, /stopped/);
  assert.match(breaker.message, /\/auto-review-approve/);

  const unavailable = buildUserReviewNotice({
    outcome: "unavailable",
    surface: "path",
    rationale: "review context is unavailable",
  });
  assert.equal(unavailable.type, "error");
  assert.match(unavailable.message, /unavailable/);
});

test("review formatting has no left bar and combines target with rationale", () => {
  assert.equal(
    formatUserReviewQuoteMessage("Auto-review · allowed · bash\nls"),
    "Auto-review · allowed · bash\nls",
  );

  const theme = {
    fg(color: string, text: string) {
      return `[${color}]${text}`;
    },
    italic(text: string) {
      return `/${text}/`;
    },
    getFgAnsi(color: string) {
      return `[${color}]`;
    },
  };
  const data = buildUserReviewEntryData({
    outcome: "allow",
    surface: "bash",
    target: "ls",
    rationale: "read-only listing",
    model: "cliproxyapi/gpt-5-mini",
    usage: {
      availability: "unknown_provenance",
      input: 2100,
      output: 64,
    },
    durationMs: 900,
  });
  const rendered = renderUserReviewQuoteLines(data, theme, 80);
  assert.equal(rendered.length, 3);
  for (const line of rendered) {
    assert.doesNotMatch(line, /│|mdQuoteBorder/);
    assert.match(line, /\[mdQuote\]/);
  }
  assert.match(rendered[1] ?? "", /ls · read-only listing/);
  assert.match(rendered[0] ?? "", /\[success\]allowed/);
  assert.doesNotMatch(rendered.at(-1) ?? "", /\[success\]/);
  assert.match(rendered.at(-1) ?? "", /2\.1k toks in/);
});

function widgetHarness(mode = "tui") {
  const widgets: Array<{
    key: string;
    content: unknown;
    options: unknown;
  }> = [];
  const notifications: unknown[] = [];
  const ctx = {
    hasUI: true,
    mode,
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      setWidget(key: string, content: unknown, options: unknown) {
        widgets.push({ key, content, options });
      },
    },
  };
  return {
    widgets,
    notifications,
    ctx,
    controller: new UserReviewWidgetController(),
  };
}

const widgetTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  italic(text: string) {
    return text;
  },
  getFgAnsi(color: string) {
    return `[${color}]`;
  },
};

function renderLastWidget(harness: ReturnType<typeof widgetHarness>, width = 80) {
  const content = harness.widgets.at(-1)?.content;
  assert.equal(typeof content, "function");
  const component = (content as Function)({}, widgetTheme);
  return component.render(width) as string[];
}

/** Widget rendering embeds ANSI accents and fake theme markers; strip both. */
function renderedText(harness: ReturnType<typeof widgetHarness>, width = 80) {
  return renderLastWidget(harness, width)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\[(muted|success|warning|error)\]/g, "");
}

test("reviewing widget uses dynamic model, above-editor placement, and wrapping", () => {
  const harness = widgetHarness();
  harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    target: "printf a very long value",
    model: "cliproxyapi/gpt-5-mini",
  });
  assert.equal(harness.widgets.at(-1)?.key, "pi-auto-review");
  assert.deepEqual(harness.widgets.at(-1)?.options, {
    placement: "aboveEditor",
  });
  const lines = renderLastWidget(harness, 12);
  assert.match(lines.join("\n"), /Auto-review/);
  assert.match(lines.join("\n"), /gpt-5-mini/);
  assert.ok(lines.length > 3);
});

test("widget bounds target and rationale with ellipses and colors only verdict", () => {
  const input = {
    outcome: "allow" as const,
    surface: "bash",
    target: "t".repeat(120),
    rationale: "r".repeat(220),
    model: "provider/reviewer",
    usage: { availability: "reported" as const, input: 2100, output: 64 },
    durationMs: 900,
  };
  const data = buildUserReviewWidgetData(input);
  assert.match(data.lines[1] ?? "", /t… · r.*…$/);
  const rendered = renderUserReviewWidgetLines(data, widgetTheme, 400);
  assert.match(rendered[0] ?? "", /\[success\]allowed/);
  assert.doesNotMatch(rendered.at(-1) ?? "", /\[success\]/);
  assert.match(rendered.at(-1) ?? "", /2\.1k toks in/);
});

test("controller overwrites checks, retains completion, and rejects stale updates", () => {
  const harness = widgetHarness();
  const first = harness.controller.begin("request-a", harness.ctx as never, {
    surface: "path",
    target: "/tmp/a",
    model: "provider/a",
  });
  const second = harness.controller.begin("request-b", harness.ctx as never, {
    surface: "bash",
    target: "printf b",
    model: "provider/b",
  });
  const firstInput = { outcome: "allow" as const, surface: "path", target: "/tmp/a" };
  harness.controller.complete(
    "request-a",
    first,
    harness.ctx as never,
    buildUserReviewNotice(firstInput),
    buildUserReviewWidgetData(firstInput),
  );
  assert.match(renderLastWidget(harness).join("\n"), /printf b/);

  const secondInput = { outcome: "allow" as const, surface: "bash", target: "printf b" };
  harness.controller.complete(
    "request-b",
    second,
    harness.ctx as never,
    buildUserReviewNotice(secondInput),
    buildUserReviewWidgetData(secondInput),
  );
  const callsAfterCompletion = harness.widgets.length;
  harness.controller.permissionDecision({ requestId: "request-a", result: "deny" });
  assert.equal(harness.widgets.length, callsAfterCompletion);
  harness.controller.permissionDecision({ requestId: "request-b", result: "deny" });
  assert.match(renderLastWidget(harness).join("\n"), /Local confirmation · denied/);
  assert.equal(harness.widgets.at(-1)?.content === undefined, false);
  harness.controller.clear(harness.ctx as never);
  assert.equal(harness.widgets.at(-1)?.content, undefined);
});

test("waiting overlay flips the reviewing widget to waiting-for-you and restores it", () => {
  const harness = widgetHarness();
  harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    target: "printf a",
    model: "provider/reviewer",
  });
  harness.controller.promptStart({ kind: "custom", title: "Permission Required" });
  const waitingLines = renderedText(harness);
  assert.match(waitingLines, /Auto-review · waiting for you · Permission Required/);
  assert.doesNotMatch(waitingLines, /Waiting for reviewer/);
  assert.match(renderLastWidget(harness)[0] ?? "", /\[muted\]waiting/);

  harness.controller.promptEnd();
  const restored = renderedText(harness);
  assert.match(restored, /Auto-review · reviewing · bash/);
  assert.match(restored, /Waiting for reviewer…/);
});

test("waiting overlay prefers the prompt title, falls back to kind, and truncates", () => {
  const harness = widgetHarness();
  harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    model: "provider/reviewer",
  });
  harness.controller.promptStart({ kind: "select" });
  assert.match(renderedText(harness), /waiting for you · select/);
  harness.controller.promptEnd();
  harness.controller.promptStart({
    kind: "confirm",
    title: `x`.repeat(120),
  });
  const rendered = renderedText(harness, 200);
  assert.match(rendered, /waiting for you · x+…$/);
  assert.ok(rendered.length < 200);
});

test("completed outcomes are never overlaid by the waiting state", () => {
  const harness = widgetHarness();
  const generation = harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    model: "provider/reviewer",
  });
  const input = { outcome: "allow" as const, surface: "bash" };
  harness.controller.complete(
    "request-a",
    generation,
    harness.ctx as never,
    buildUserReviewNotice(input),
    buildUserReviewWidgetData(input),
  );
  harness.controller.promptStart({ kind: "confirm", title: "Confirm?" });
  assert.match(renderedText(harness), /allowed/);
  assert.doesNotMatch(renderedText(harness), /waiting for you/);
  harness.controller.promptEnd();
  assert.match(renderedText(harness), /allowed/);
});

test("prompt events without a live widget and stray ends are no-ops", () => {
  const harness = widgetHarness();
  harness.controller.promptStart({ kind: "confirm" });
  assert.equal(harness.widgets.length, 0);
  harness.controller.promptEnd();
  assert.equal(harness.widgets.length, 0);

  // A review starting while a prompt span is open shows the overlay, and
  // clear resets the waiting state so later reviews render normally.
  harness.controller.promptStart({ kind: "confirm", title: "Confirm?" });
  harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    model: "provider/reviewer",
  });
  assert.match(renderedText(harness), /waiting for you · Confirm/);
  harness.controller.clear(harness.ctx as never);
  assert.equal(harness.widgets.at(-1)?.content, undefined);
  harness.controller.begin("request-b", harness.ctx as never, {
    surface: "bash",
    model: "provider/reviewer",
  });
  assert.match(renderedText(harness), /reviewing · bash/);
});

test("group member summaries preserve auto-confirm detail on one line", () => {
  const data = {
    kind: "group" as const,
    type: "info" as const,
    sessionId: "session-a",
    toolCallId: "call-a",
    members: [
      {
        requestId: "path",
        outcome: "auto_confirm" as const,
        surface: "external_directory",
        target: "/tmp/demo",
        rationale: "temporary output only",
      },
      {
        requestId: "bash",
        outcome: "allow" as const,
        surface: "bash",
        target: "printf hi",
        rationale: "harmless output",
      },
    ],
  };
  assert.deepEqual(buildUserReviewGroupLines(data).lines, [
    "Auto-review · allowed · 2 checks",
    "external_directory · allowed · auto-confirm · /tmp/demo · temporary output only",
    "bash · allowed · printf hi · harmless output",
  ]);
});

test("widget completion falls back to notify when setWidget fails", () => {
  const harness = widgetHarness();
  const generation = harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
    model: "provider/reviewer",
  });
  harness.ctx.ui.setWidget = () => {
    throw new Error("renderer storage unavailable");
  };
  const input = { outcome: "unavailable" as const, surface: "bash" };
  harness.controller.complete(
    "request-a",
    generation,
    harness.ctx as never,
    buildUserReviewNotice(input),
    buildUserReviewWidgetData(input),
  );
  assert.equal(harness.notifications.length, 1);
});

test("non-TUI completions keep independent notification behavior", () => {
  const harness = widgetHarness("rpc");
  const first = harness.controller.begin("request-a", harness.ctx as never, {
    surface: "bash",
  });
  const second = harness.controller.begin("request-b", harness.ctx as never, {
    surface: "path",
  });
  for (const [requestId, generation, surface] of [
    ["request-a", first, "bash"],
    ["request-b", second, "path"],
  ] as const) {
    const input = { outcome: "allow" as const, surface };
    harness.controller.complete(
      requestId,
      generation,
      harness.ctx as never,
      buildUserReviewNotice(input),
      buildUserReviewWidgetData(input),
    );
  }
  assert.equal(harness.widgets.length, 0);
  assert.equal(harness.notifications.length, 2);
});
