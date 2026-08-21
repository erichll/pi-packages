import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUserReviewNotice,
  buildUserReviewStatus,
  compactReviewText,
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
    "auto-review: reviewing path · /tmp/outside",
  );
  assert.equal(
    buildUserReviewStatus("bash"),
    "auto-review: reviewing bash",
  );
});

test("buildUserReviewNotice covers decisive user outcomes", () => {
  assert.deepEqual(
    buildUserReviewNotice({
      outcome: "allow",
      surface: "bash",
      target: "ls",
      rationale: "read-only listing",
    }),
    {
      type: "info",
      message: "Auto-review allowed bash · ls — read-only listing",
    },
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "auto_confirm",
      surface: "external_directory",
      target: "/tmp/x",
    }).message,
    "Auto-review allowed external_directory · /tmp/x; auto-confirming the local dialog",
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "needs_confirmation",
      surface: "path",
      target: "/etc/hosts",
    }).message,
    "Auto-review allowed path · /etc/hosts; local confirmation is still required",
  );

  assert.equal(
    buildUserReviewNotice({
      outcome: "defer",
      surface: "bash",
      target: "curl example.com",
      rationale: "network side effects",
    }).message,
    "Auto-review deferred bash · curl example.com to you — network side effects",
  );

  const denied = buildUserReviewNotice({
    outcome: "deny",
    surface: "bash",
    target: "rm -rf /",
    rationale: "destructive root wipe",
  });
  assert.equal(denied.type, "warning");
  assert.match(denied.message, /^Auto-review denied bash · rm -rf \//);

  const breaker = buildUserReviewNotice({
    outcome: "circuit_breaker",
    surface: "bash",
  });
  assert.equal(breaker.type, "warning");
  assert.match(breaker.message, /repeated denials/);
  assert.match(breaker.message, /\/auto-review-approve/);

  const unavailable = buildUserReviewNotice({
    outcome: "unavailable",
    surface: "path",
    rationale: "review context is unavailable",
  });
  assert.equal(unavailable.type, "error");
  assert.match(unavailable.message, /unavailable/);
});
