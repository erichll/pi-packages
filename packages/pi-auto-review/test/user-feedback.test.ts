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
  ReviewEntryBatcher,
  buildUserReviewGroupLines,
  renderUserReviewQuoteLines,
  reviewTargetFromRequest,
} from "../src/user-feedback.ts";

test("compactReviewText collapses whitespace and bounds length", () => {
  assert.equal(compactReviewText("  a\n\tb  "), "a b");
  assert.equal(compactReviewText("x".repeat(20), 8), "xxxxxxxx");
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
  assert.match(rendered.at(-1) ?? "", /\[success\]2\.1k/);
});

function batchHarness(options: ConstructorParameters<typeof ReviewEntryBatcher>[1] = {}) {
  const entries: unknown[] = [];
  const notifications: unknown[] = [];
  const pi = {
    appendEntry(_type: string, data: unknown) {
      entries.push(data);
    },
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };
  return {
    entries,
    notifications,
    pi,
    ctx,
    batcher: new ReviewEntryBatcher(pi as never, options),
  };
}

function enqueueMember(
  harness: ReturnType<typeof batchHarness>,
  requestId: string,
  toolCallId: string,
  surface = "bash",
  sessionId = "session-a",
) {
  const input = {
    outcome: "allow" as const,
    surface,
    target: surface === "bash" ? "printf hi" : "/tmp/out",
    rationale: `${surface} is narrow`,
  };
  harness.batcher.enqueue({
    sessionId,
    toolCallId,
    member: { requestId, ...input },
    notice: buildUserReviewNotice(input),
    data: buildUserReviewEntryData(input),
    ctx: harness.ctx as never,
  });
}

test("ReviewEntryBatcher groups members by local session and tool call", () => {
  const harness = batchHarness();
  enqueueMember(harness, "request-path", "call-a", "external_directory");
  enqueueMember(harness, "request-bash", "call-a");
  enqueueMember(harness, "request-other", "call-b");
  enqueueMember(harness, "request-session", "call-a", "bash", "session-b");
  assert.equal(harness.entries.length, 0);

  harness.batcher.toolExecutionStarted("session-a", "call-a", {
    command: "printf hi && wc -l /tmp/out",
  });
  assert.equal(harness.entries.length, 1);
  const grouped = harness.entries[0] as {
    kind: string;
    fullCommand: string;
    members: Array<{ requestId: string }>;
  };
  assert.equal(grouped.kind, "group");
  assert.equal(grouped.fullCommand, "printf hi && wc -l /tmp/out");
  assert.deepEqual(
    grouped.members.map((member) => member.requestId),
    ["request-path", "request-bash"],
  );
  assert.ok(
    buildUserReviewGroupLines(grouped as never).lines.includes(
      "external_directory · allowed · /tmp/out · external_directory is narrow",
    ),
  );

  harness.batcher.flushAll();
  assert.equal(harness.entries.length, 3);
});

test("ReviewEntryBatcher flushes terminal deny and records local disagreement", () => {
  const harness = batchHarness();
  enqueueMember(harness, "request-defer", "call-a");
  harness.batcher.permissionDecision({
    requestId: "request-defer",
    result: "deny",
  });
  assert.equal(harness.entries.length, 1);
  const grouped = harness.entries[0] as Parameters<typeof buildUserReviewGroupLines>[0];
  assert.equal(grouped.members[0]?.permissionResult, "deny");
  assert.match(
    buildUserReviewGroupLines(grouped).lines.join("\n"),
    /Local confirmation · denied/,
  );
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

test("ReviewEntryBatcher bounds groups and members without dropping feedback", () => {
  const harness = batchHarness({ maxGroups: 2, maxMembers: 2 });
  enqueueMember(harness, "a-1", "call-a");
  enqueueMember(harness, "b-1", "call-b");
  enqueueMember(harness, "c-1", "call-c");
  assert.equal(harness.entries.length, 1, "oldest group flushed on overflow");
  enqueueMember(harness, "c-2", "call-c");
  enqueueMember(harness, "c-3", "call-c");
  assert.equal(harness.entries.length, 2, "full member group flushed");
  harness.batcher.flushAll();
  const memberCount = harness.entries.reduce<number>(
    (count, entry) => count + (entry as { members: unknown[] }).members.length,
    0,
  );
  assert.equal(memberCount, 5);
});

test("ReviewEntryBatcher TTL and append failure fall back without loss", async () => {
  const ttl = batchHarness({ ttlMs: 5 });
  enqueueMember(ttl, "ttl", "call-ttl");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(ttl.entries.length, 1);

  const fallback = batchHarness();
  fallback.pi.appendEntry = () => {
    throw new Error("renderer storage unavailable");
  };
  enqueueMember(fallback, "fallback", "call-fallback");
  fallback.batcher.flushAll();
  assert.equal(fallback.notifications.length, 1);
});
