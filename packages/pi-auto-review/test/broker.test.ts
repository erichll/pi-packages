import assert from "node:assert/strict";
import test from "node:test";
import { BoundaryApprovalBroker } from "../src/broker/broker.ts";
import { boundaryRequestHash, OneShotGrantStore } from "../src/broker/grants.ts";
import { RecentDenialStore } from "../src/broker/overrides.ts";
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
  destinationHost: "registry.npmjs.org",
  destinationPort: 443,
  destinationProtocol: "https",
  matchedPolicy: { decision: "ask", rule: "network-unmatched" },
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
      { ...request, destination: "example.com:443", destinationHost: "example.com" },
      "session-1",
      decision.grant.token,
    ),
    false,
  );
});

test("grant hash binds structured destination port independently", async () => {
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
      { ...request, destinationPort: 8443 },
      "session-1",
      decision.grant.token,
    ),
    false,
  );
});

test("grant hash binds structured destination protocol independently", async () => {
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
      { ...request, destinationProtocol: "tcp" },
      "session-1",
      decision.grant.token,
    ),
    false,
  );
});

test("grant binds host-IPC trigger evidence", async () => {
  const hostRequest: BoundaryRequest = {
    ...request,
    surface: "host-ipc",
    operation: "execute-host",
    matchedPolicy: { decision: "ask", rule: "preflight-prefix:tmux" },
  };
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => allowReview,
  });
  const decision = await broker.review(hostRequest, {
    sessionId: "session-1",
    scopeKey: "turn-1",
    issueGrant: true,
  });
  assert.ok(decision.kind === "allow" && decision.grant);
  if (decision.kind !== "allow" || !decision.grant) return;
  assert.equal(
    broker.consumeGrant(
      {
        ...hostRequest,
        matchedPolicy: {
          decision: "ask",
          rule: "unix-socket-eperm",
        },
      },
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

test("critical model denials are separated and break glass allows one exact retry", async () => {
  let now = 1_000;
  let calls = 0;
  const audits: string[] = [];
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      calls++;
      return {
        outcome: "deny",
        riskLevel: "critical",
        userAuthorization: "unknown",
        rationale: "Critical model denial.",
      };
    },
    denials: new RecentDenialStore(10, () => now),
    grants: new OneShotGrantStore(60_000, () => now),
    audit: (event) => audits.push(event.type),
  });
  const context = {
    sessionId: "session-1",
    scopeKey: "turn-1",
    issueGrant: true,
  };
  const denied = await broker.review(request, context);
  assert.equal(denied.kind, "deny");
  assert.equal(
    denied.kind === "deny" && denied.recoveryCommand,
    "/auto-review-break-glass",
  );
  assert.deepEqual(broker.recentDenials("session-1"), []);
  const critical = broker.recentCriticalDenials("session-1", "turn-1");
  assert.equal(critical.length, 1);
  assert.ok(
    broker.startBreakGlassChallenge(
      critical[0]!.requestId,
      "session-1",
      "turn-1",
    ),
  );
  now += 1_000;
  assert.ok(
    broker.authorizeCriticalDenial(
      critical[0]!.requestId,
      "session-1",
      "turn-1",
    ),
  );
  const allowed = await broker.review(request, context);
  assert.equal(allowed.kind, "allow");
  assert.equal(calls, 1, "break glass must not call the reviewer again");
  assert.deepEqual(
    allowed.kind === "allow" && allowed.authorization,
    {
      kind: "break-glass",
      originalRequestId: request.id,
      confirmedAt: now,
    },
  );
  assert.ok(allowed.kind === "allow" && allowed.grant);
  if (allowed.kind !== "allow" || !allowed.grant) return;
  assert.equal(
    broker.consumeGrant(request, "session-1", allowed.grant.token),
    true,
  );
  assert.equal(
    broker.consumeGrant(request, "session-1", allowed.grant.token),
    false,
  );
  const repeated = await broker.review(request, context);
  assert.equal(repeated.kind, "deny");
  assert.equal(calls, 2);
  // The break-glass allow reset the turn breaker (a human re-authorized the
  // scope), so fresh denials start counting from zero again.
  await broker.review(request, context);
  const secondDenial = await broker.review(request, context);
  assert.equal(
    secondDenial.kind === "deny" && secondDenial.denialSource,
    "reviewer",
    "break-glass allow resets the breaker; fresh denials recount",
  );
  await broker.review(request, context);
  const blocked = await broker.review(request, context);
  assert.equal(
    blocked.kind === "deny" && blocked.denialSource,
    "circuit-breaker",
    "repeated denials after break glass trip the breaker again",
  );
  assert.deepEqual(
    audits.filter((type) => type.startsWith("break_glass")),
    [
      "break_glass_challenge_started",
      "break_glass_authorized",
      "break_glass_consumed",
    ],
  );
});

test("break-glass authorization expires and binds session and every request field", async () => {
  let now = 1_000;
  const denials = new RecentDenialStore(20, () => now);
  const criticalReview: BoundaryReview = {
    outcome: "deny",
    riskLevel: "critical",
    userAuthorization: "unknown",
    rationale: "Critical model denial.",
  };
  const authorize = (candidate: BoundaryRequest) => {
    denials.record(candidate, {
      sessionId: "session-1",
      scopeKey: "turn-1",
    }, criticalReview);
    return denials.authorizeCritical(
      candidate.id,
      "session-1",
      "turn-1",
    );
  };
  assert.ok(authorize(request));
  assert.equal(
    denials.consumeCritical(request, {
      sessionId: "session-2",
      scopeKey: "turn-1",
    }),
    undefined,
    "another session must never consume the authorization",
  );
  // The retry always lands in a later turn than the denial (the command flow
  // appends a user message before the agent retries), so the turn scope must
  // not bind the authorization.
  assert.ok(
    denials.consumeCritical(request, {
      sessionId: "session-1",
      scopeKey: "turn-2",
    }),
    "a shifted turn scope must not lose the authorization",
  );

  // A retried action mints a fresh requestId and toolCallId (the model issues
  // a new tool call); neither may participate in the exact match.
  assert.ok(authorize(request));
  assert.ok(
    denials.consumeCritical({
      ...request,
      id: "request-retry",
      toolCallId: "call-retry",
    }, {
      sessionId: "session-1",
      scopeKey: "turn-3",
    }),
    "a retried tool call (new id + toolCallId) must still consume",
  );

  for (const changed of [
    { ...request, command: "npm publish" },
    { ...request, cwd: "/other" },
    { ...request, path: "/other" },
    { ...request, destination: "example.com:443" },
    { ...request, toolInputPreview: "changed" },
    { ...request, requesterSessionId: "other" },
    { ...request, matchedPolicy: { decision: "ask" as const, rule: "other" } },
  ]) {
    assert.ok(authorize(request));
    assert.equal(
      denials.consumeCritical(changed, {
        sessionId: "session-1",
        scopeKey: "turn-1",
      }),
      undefined,
    );
    assert.ok(
      denials.consumeCritical(request, {
        sessionId: "session-1",
        scopeKey: "turn-1",
      }),
      "a mismatched retry must not consume the exact authorization",
    );
  }

  assert.ok(authorize(request));
  now += 60_001;
  assert.equal(
    denials.consumeCritical(request, {
      sessionId: "session-1",
      scopeKey: "turn-1",
    }),
    undefined,
  );
});

test("a local hard deny remains terminal with a pending break-glass authorization", async () => {
  const denials = new RecentDenialStore();
  let hardDenyEnabled = false;
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => ({
      outcome: "deny",
      riskLevel: "critical",
      userAuthorization: "unknown",
      rationale: "Critical model denial.",
    }),
    denials,
    hardDeny: () =>
      hardDenyEnabled
        ? { rule: "terminal", reason: "Terminal local denial." }
        : undefined,
  });
  const context = { sessionId: "session-1", scopeKey: "turn-1" };
  await broker.review(request, context);
  assert.ok(
    broker.authorizeCriticalDenial(request.id, "session-1", "turn-1"),
  );
  hardDenyEnabled = true;
  const decision = await broker.review(request, context);
  assert.equal(decision.kind, "deny");
  assert.equal(
    decision.kind === "deny" && decision.denialSource,
    "hard-deny",
  );
  hardDenyEnabled = false;
  const retry = await broker.review(request, context);
  assert.equal(retry.kind, "allow", "hard deny must not consume the authorization");
});

test("critical denial selection expires after five minutes and can be disabled", async () => {
  let now = 1_000;
  const denials = new RecentDenialStore(10, () => now);
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => ({
      outcome: "deny",
      riskLevel: "critical",
      userAuthorization: "unknown",
      rationale: "Critical model denial.",
    }),
    denials,
    breakGlassEnabled: false,
  });
  const decision = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "turn-1",
  });
  assert.equal(
    decision.kind === "deny" && decision.recoveryCommand,
    false,
  );
  assert.deepEqual(
    broker.recentCriticalDenials("session-1", "turn-1"),
    [],
  );
  assert.equal(
    broker.authorizeCriticalDenial(request.id, "session-1", "turn-1"),
    undefined,
  );
  now += 300_001;
  assert.deepEqual(
    broker.recentCriticalDenials("session-1", "turn-1"),
    [],
  );
  assert.equal(
    broker.authorizeCriticalDenial(request.id, "session-1", "turn-1"),
    undefined,
  );
});

test("the exact-match hash ignores retry-minted identifiers (requestId, toolCallId)", () => {
  const retried: BoundaryRequest = {
    ...request,
    id: "request-retry",
    toolCallId: "call-retry",
  };
  assert.equal(boundaryRequestHash(retried), boundaryRequestHash(request));
  assert.notEqual(
    boundaryRequestHash({ ...request, command: "npm publish" }),
    boundaryRequestHash(request),
  );
});

test("approve override survives a retried tool call id and a shifted turn scope", async () => {
  let now = 1_000;
  let calls = 0;
  const broker = new BoundaryApprovalBroker({
    reviewer: async (_req, reviewContext) => {
      calls++;
      return reviewContext?.userOverride
        ? {
            outcome: "allow",
            riskLevel: "high",
            userAuthorization: "high",
            rationale: "Human approved this exact retry.",
          }
        : {
            outcome: "deny",
            riskLevel: "high",
            userAuthorization: "unknown",
            rationale: "Denied without human approval.",
          };
    },
    denials: new RecentDenialStore(10, () => now),
  });
  const first = await broker.review(request, {
    sessionId: "session-1",
    scopeKey: "session-1:5",
  });
  assert.equal(first.kind, "deny");
  const listed = broker.recentDenials("session-1");
  assert.equal(listed.length, 1);
  assert.ok(broker.authorizeRecentDenial(listed[0]!.requestId, "session-1"));

  // The retry is a new tool call (new id + toolCallId) in a later turn (the
  // command flow appended a user message). The approval must still apply.
  const retry = await broker.review({
    ...request,
    id: "request-retry",
    toolCallId: "call-retry",
  }, {
    sessionId: "session-1",
    scopeKey: "session-1:6",
  });
  assert.equal(retry.kind, "allow");
  assert.equal(calls, 2, "the retry must still pass through the reviewer");
});

test("a fresh denial re-arms one-shot approval after a consumed override", async () => {
  let now = 1_000;
  const denials = new RecentDenialStore(10, () => now);
  const highDeny: BoundaryReview = {
    outcome: "deny",
    riskLevel: "high",
    userAuthorization: "unknown",
    rationale: "Denied.",
  };
  denials.record(request, { sessionId: "session-1", scopeKey: "turn-1" }, highDeny);
  assert.ok(denials.authorize(request.id, "session-1"));
  assert.ok(
    denials.consume(request, { sessionId: "session-1", scopeKey: "turn-1" }),
  );
  // The retry was denied again: a fresh denial is a fresh human decision
  // point and must re-enable approval despite the consumed earlier one.
  denials.record(request, { sessionId: "session-1", scopeKey: "turn-1" }, highDeny);
  assert.ok(
    denials.authorize(request.id, "session-1"),
    "a re-denied action must be approvable again",
  );
  assert.ok(
    denials.consume(request, { sessionId: "session-1", scopeKey: "turn-1" }),
  );
  // But a second approve while one authorization is still pending (not yet
  // consumed by a retry) must fail.
  now += 1_000;
  denials.record(request, { sessionId: "session-1", scopeKey: "turn-1" }, highDeny);
  assert.ok(denials.authorize(request.id, "session-1"));
  assert.equal(
    denials.authorize(request.id, "session-1"),
    undefined,
    "a second approve while one authorization is pending must fail",
  );
});

test("an expired unconsumed break-glass authorization does not block re-approval", async () => {
  let now = 1_000;
  const denials = new RecentDenialStore(10, () => now);
  const criticalReview: BoundaryReview = {
    outcome: "deny",
    riskLevel: "critical",
    userAuthorization: "unknown",
    rationale: "Critical model denial.",
  };
  denials.record(request, { sessionId: "session-1", scopeKey: "turn-1" }, criticalReview);
  assert.ok(denials.authorizeCritical(request.id, "session-1", "turn-1"));

  // The retry never arrives; the same action is denied again later.
  now += 120_000;
  denials.record(request, { sessionId: "session-1", scopeKey: "turn-1" }, criticalReview);
  assert.ok(
    denials.authorizeCritical(request.id, "session-1", "turn-1"),
    "the stale expired authorization must not lock break-glass forever",
  );
});

test("a break-glass allow lets the turn continue after the breaker tripped", async () => {
  let now = 1_000;
  let calls = 0;
  const denials = new RecentDenialStore(10, () => now);
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      calls++;
      return {
        outcome: "deny",
        riskLevel: "critical",
        userAuthorization: "unknown",
        rationale: "Critical model denial.",
      };
    },
    denials,
  });
  const context = { sessionId: "session-1", scopeKey: "turn-1" };
  for (let i = 0; i < 3; i++) {
    await broker.review({ ...request, id: `request-${i}` }, context);
  }
  calls = 0;
  const tripped = await broker.review({ ...request, id: "request-x" }, context);
  assert.equal(
    tripped.kind === "deny" && tripped.denialSource,
    "circuit-breaker",
  );

  const critical = broker.recentCriticalDenials("session-1");
  assert.equal(critical.length, 1);
  assert.ok(
    broker.startBreakGlassChallenge(critical[0]!.requestId, "session-1", "turn-1"),
  );
  assert.ok(
    broker.authorizeCriticalDenial(critical[0]!.requestId, "session-1", "turn-1"),
  );
  const allowed = await broker.review({ ...request, id: "request-retry" }, context);
  assert.equal(allowed.kind, "allow");

  // The human re-authorized the scope: the next ask reaches the reviewer
  // instead of being blocked by the tripped breaker.
  calls = 0;
  const next = await broker.review({ ...request, id: "request-next" }, context);
  assert.equal(next.kind, "deny");
  assert.equal(calls, 1, "the breaker must be reset by the break-glass allow");
  assert.equal(
    next.kind === "deny" && next.denialSource,
    "reviewer",
  );
});
