import assert from "node:assert/strict";
import test from "node:test";
import { BoundaryApprovalBroker } from "../src/broker/broker.ts";
import { OneShotGrantStore } from "../src/broker/grants.ts";
import type {
  BoundaryRequest,
  BoundaryReview,
} from "../src/broker/types.ts";

const request: BoundaryRequest = {
  id: "request-1",
  source: "sandbox-runtime",
  surface: "network",
  operation: "connect",
  cwd: "/workspace/project",
  command: "npm install",
  destination: "registry.npmjs.org:443",
};

const allowReview: BoundaryReview = {
  outcome: "allow",
  riskLevel: "medium",
  userAuthorization: "high",
  rationale: "The user requested installing project dependencies.",
};

test("broker issues an exact one-shot grant", async () => {
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => allowReview,
  });
  const decision = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "turn-1",
    issueGrant: true,
  });
  assert.equal(decision.kind, "allow");
  assert.ok(decision.kind === "allow" && decision.grant);
  const token = decision.kind === "allow" ? decision.grant?.token : undefined;
  assert.ok(token);
  assert.equal(
    broker.consumeGrant(request, "session-1", String(token)),
    true,
  );
  assert.equal(
    broker.consumeGrant(request, "session-1", String(token)),
    false,
  );
});

test("grant cannot authorize a materially different request", async () => {
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => allowReview,
  });
  const decision = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "turn-1",
    issueGrant: true,
  });
  assert.ok(decision.kind === "allow" && decision.grant);
  if (decision.kind !== "allow" || !decision.grant) return;
  assert.equal(
    broker.consumeGrant(
      { ...request, destination: "example.com:443" },
      "session-1",
      decision.grant.token,
    ),
    false,
  );
});

test("grant binds both requested and symlink-resolved paths", async () => {
  const symlinkRequest: BoundaryRequest = {
    ...request,
    surface: "filesystem-write",
    operation: "write",
    path: "../release/current",
    resolvedPath: "/srv/releases/v1",
  };
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => allowReview,
  });
  const decision = await broker.review(symlinkRequest, {
    sessionId: "session-1",
    scopeKey: "turn-1",
    issueGrant: true,
  });
  assert.ok(decision.kind === "allow" && decision.grant);
  if (decision.kind !== "allow" || !decision.grant) return;
  assert.equal(
    broker.consumeGrant(
      { ...symlinkRequest, resolvedPath: "/srv/releases/v2" },
      "session-1",
      decision.grant.token,
    ),
    false,
  );
});

test("expired grants fail closed", () => {
  let now = 1_000;
  const grants = new OneShotGrantStore(1_000, () => now);
  const grant = grants.issue(request, "session-1");
  now = 2_001;
  assert.equal(grants.consume(request, "session-1", grant.token), false);
});

test("hard deny bypasses the model", async () => {
  let reviewerCalled = false;
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      reviewerCalled = true;
      return allowReview;
    },
    hardDeny: () => ({
      rule: "destructive-root-delete",
      reason: "Root deletion is forbidden.",
    }),
  });
  const decision = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "turn-1",
  });
  assert.equal(decision.kind, "deny");
  assert.equal(reviewerCalled, false);
});

test("three consecutive denials trip the turn circuit breaker", async () => {
  let calls = 0;
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      calls++;
      return {
        outcome: "deny",
        riskLevel: "high",
        userAuthorization: "unknown",
        rationale: "Not authorized.",
      };
    },
  });
  for (let index = 0; index < 3; index++) {
    await broker.review(
      { ...request, id: `request-${index}` },
      { sessionId: "session-1", scopeKey: "turn-1" },
    );
  }
  const fourth = await broker.review(
    { ...request, id: "request-4" },
    { sessionId: "session-1", scopeKey: "turn-1" },
  );
  assert.equal(fourth.kind, "deny");
  assert.equal(
    fourth.kind === "deny" && fourth.circuitBreakerTripped,
    true,
  );
  assert.equal(calls, 3);
});

test("failure mode can defer to the human terminal", async () => {
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      throw new Error("model unavailable");
    },
    failureMode: "defer",
  });
  const decision = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "turn-1",
  });
  assert.equal(decision.kind, "defer");
});
