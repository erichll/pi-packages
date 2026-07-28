import assert from "node:assert/strict";
import test from "node:test";
import { BoundaryApprovalBroker } from "../src/broker/broker.ts";
import { RecentDenialStore } from "../src/broker/overrides.ts";
import type {
  BoundaryRequest,
  BoundaryReview,
  BoundaryReviewerContext,
} from "../src/broker/types.ts";

const request: BoundaryRequest = {
  id: "denied-1",
  source: "sandbox-runtime",
  surface: "filesystem-write",
  operation: "write",
  cwd: "/workspace",
  path: "../release",
  resolvedPath: "/release",
  command: "touch ../release",
};

const denied: BoundaryReview = {
  outcome: "deny",
  riskLevel: "high",
  userAuthorization: "unknown",
  rationale: "Explicit authorization is missing.",
};

const context = {
  sessionId: "session-1",
  scopeKey: "session-1:turn-1",
  issueGrant: true,
};

test("exact override is consumed once and retry still uses reviewer", async () => {
  const seen: Array<BoundaryReviewerContext | undefined> = [];
  const broker = new BoundaryApprovalBroker({
    reviewer: async (_request, reviewerContext) => {
      seen.push(reviewerContext);
      return reviewerContext?.userOverride
        ? {
            outcome: "allow",
            riskLevel: "high",
            userAuthorization: "high",
            rationale: "The exact retry was explicitly approved.",
          }
        : denied;
    },
  });

  const first = await broker.review(request, context);
  assert.equal(first.kind, "deny");
  const recent = broker.recentDenials(context.sessionId);
  assert.equal(recent.length, 1);
  assert.ok(
    broker.authorizeRecentDenial(
      recent[0].requestId,
      context.sessionId,
    ),
  );

  const retry = await broker.review({ ...request, id: "retry-1" }, context);
  assert.equal(retry.kind, "allow");
  assert.ok(seen[1]?.userOverride);
  assert.equal(
    seen[1]?.userOverride?.originalRequestId,
    request.id,
  );

  const third = await broker.review({ ...request, id: "retry-2" }, context);
  assert.equal(third.kind, "deny");
  assert.equal(seen[2]?.userOverride, undefined);
  assert.equal(
    broker.authorizeRecentDenial(
      request.id,
      context.sessionId,
    ),
    undefined,
  );
});

test("changed semantics and a different session cannot consume override", async () => {
  const seen: Array<BoundaryReviewerContext | undefined> = [];
  const broker = new BoundaryApprovalBroker({
    reviewer: async (_request, reviewerContext) => {
      seen.push(reviewerContext);
      return denied;
    },
  });
  await broker.review(request, context);
  assert.ok(
    broker.authorizeRecentDenial(
      request.id,
      context.sessionId,
    ),
  );

  await broker.review(
    { ...request, id: "changed", resolvedPath: "/different" },
    context,
  );
  await broker.review(
    { ...request, id: "other-session" },
    {
      ...context,
      sessionId: "session-2",
      scopeKey: "session-2:turn-1",
    },
  );
  assert.equal(seen[1]?.userOverride, undefined);
  assert.equal(seen[2]?.userOverride, undefined);

  await broker.review(
    { ...request, id: "exact" },
    { ...context, scopeKey: "session-1:turn-2" },
  );
  assert.ok(seen[3]?.userOverride);
});

test("hard deny remains terminal after user authorizes a retry", async () => {
  let hardDeny = false;
  let reviewerCalls = 0;
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => {
      reviewerCalls++;
      return denied;
    },
    hardDeny: () =>
      hardDeny
        ? { rule: "tenant-hard-deny", reason: "Tenant policy forbids it." }
        : undefined,
  });
  await broker.review(request, context);
  assert.ok(
    broker.authorizeRecentDenial(
      request.id,
      context.sessionId,
    ),
  );
  hardDeny = true;
  const result = await broker.review({ ...request, id: "retry" }, context);
  assert.equal(result.kind, "deny");
  assert.equal(
    result.kind === "deny" && result.review.riskLevel,
    "critical",
  );
  assert.equal(reviewerCalls, 1);
});

test("recent denial storage is bounded to ten entries", () => {
  let now = 1_000;
  const store = new RecentDenialStore(10, () => now++);
  for (let index = 0; index < 12; index++) {
    store.record(
      {
        ...request,
        id: `request-${index}`,
        resolvedPath: `/release-${index}`,
      },
      context,
      denied,
    );
  }
  const entries = store.list(context.sessionId);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].requestId, "request-11");
  assert.equal(entries.at(-1)?.requestId, "request-2");
});

test("an authorized retry expires instead of remaining latent", async () => {
  let now = 1_000;
  const store = new RecentDenialStore(10, () => now, 1_000);
  store.record(request, context, denied);
  assert.ok(store.authorize(request.id, context.sessionId));
  now = 2_001;
  assert.equal(store.consume(request, context), undefined);
});
