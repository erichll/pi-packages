import assert from "node:assert/strict";
import test from "node:test";
import { BoundaryApprovalBroker } from "../src/broker/broker.ts";
import { OneShotGrantStore } from "../src/broker/grants.ts";
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
      critical[0].requestId,
      "session-1",
      "turn-1",
    ),
  );
  now += 1_000;
  assert.ok(
    broker.authorizeCriticalDenial(
      critical[0].requestId,
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
  await broker.review(request, context);
  const blocked = await broker.review(request, context);
  assert.equal(
    blocked.kind === "deny" && blocked.denialSource,
    "circuit-breaker",
    "break glass must not clear denial history",
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

test("break-glass authorization expires and binds session, scope, and every request field", async () => {
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
  );
  assert.ok(
    denials.consumeCritical(request, {
      sessionId: "session-1",
      scopeKey: "turn-1",
    }),
  );

  assert.ok(authorize(request));
  assert.equal(
    denials.consumeCritical(request, {
      sessionId: "session-1",
      scopeKey: "turn-2",
    }),
    undefined,
  );
  assert.ok(
    denials.consumeCritical(request, {
      sessionId: "session-1",
      scopeKey: "turn-1",
    }),
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
