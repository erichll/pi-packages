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
    "2.4k in (800 cache) · 86 out",
  );
  assert.equal(
    formatReviewUsage({
      availability: "estimated",
      totalTokens: 1200,
    }),
    "~1.2k tok",
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
    "gpt-5-mini · 2.4k in · 86 out · 1.1s · 2 calls",
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
        "ls",
        "read-only listing",
        "gpt-5-mini · 2.1k in · 64 out · 900ms",
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
      "curl example.com",
      "network side effects",
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

test("quote formatting uses a left bar like markdown blockquotes", () => {
  assert.equal(
    formatUserReviewQuoteMessage("Auto-review · allowed · bash\nls"),
    "│ Auto-review · allowed · bash\n│ ls",
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
  assert.equal(rendered.length, 4);
  for (const line of rendered) {
    assert.match(line, /^\[mdQuoteBorder\]│ /);
    assert.match(line, /\[mdQuote\]/);
  }
  assert.match(rendered[0] ?? "", /\[success\]allowed/);
  assert.match(rendered.at(-1) ?? "", /\[success\]2\.1k/);
});
