import assert from "node:assert/strict";
import test from "node:test";
import type {
  BoundaryApprovalBrokerService,
  BoundaryDecision,
} from "@erichll/pi-auto-review/broker";
import { BoundaryApprovalBroker } from "@erichll/pi-auto-review/broker";
import {
  approveDomainEndpoint,
  approveHostIPCExecution,
  approveSandboxTrap,
} from "../src/approval.ts";
import type {
  SandboxFilesystemTrap,
  SandboxNetworkTrap,
} from "../src/traps.ts";

const trap: SandboxFilesystemTrap = {
  kind: "filesystem",
  query_id: "7",
  operation: "read",
  path: "/home/user/secret",
  requested_path: "secret",
  reason: "allow_miss",
  process: { pid: 42, exe: "/usr/bin/cat", cwd: "/repo" },
};

const networkTrap: SandboxNetworkTrap = {
  kind: "network",
  query_id: "8",
  operation: "connect",
  target: "93.184.216.34:443",
  process: { pid: 43, exe: "/usr/bin/curl", cwd: "/repo" },
};

const review = {
  outcome: "allow" as const,
  riskLevel: "low" as const,
  userAuthorization: "medium" as const,
  rationale: "Narrow read authorized by the user.",
};

function brokerFor(
  decision: BoundaryDecision,
  consume = true,
): {
  broker: BoundaryApprovalBrokerService;
  consumed: () => number;
  reviewed: () => number;
} {
  let consumeCalls = 0;
  let reviewCalls = 0;
  return {
    broker: {
      async review() {
        reviewCalls += 1;
        return decision;
      },
      consumeGrant() {
        consumeCalls += 1;
        return consume;
      },
    },
    consumed: () => consumeCalls,
    reviewed: () => reviewCalls,
  };
}

const context = {
  command: "cat secret",
  cwd: "/repo",
  sessionId: "session-1",
  scopeKey: "session-1:turn:3",
};

test("host-IPC approval carries the exact command, cwd, and trigger evidence", async () => {
  let request:
    | Parameters<BoundaryApprovalBrokerService["review"]>[0]
    | undefined;
  const fake = brokerFor({
    kind: "deny",
    review: { ...review, outcome: "deny" },
    circuitBreakerTripped: false,
  });
  const broker: BoundaryApprovalBrokerService = {
    async review(value, reviewContext) {
      request = value;
      return fake.broker.review(value, reviewContext);
    },
    consumeGrant: fake.broker.consumeGrant.bind(fake.broker),
  };

  const result = await approveHostIPCExecution(
    { reason: "preflight-prefix", rule: "tmux" },
    { ...context, broker },
  );

  assert.equal(result.action, "deny");
  assert.equal(request?.source, "sandbox-runtime");
  assert.equal(request?.surface, "host-ipc");
  assert.equal(request?.operation, "execute-host");
  assert.equal(request?.command, "cat secret");
  assert.equal(request?.cwd, "/repo");
  assert.equal(request?.matchedPolicy?.rule, "preflight-prefix:tmux");
});

test("host-IPC fallback warns that the first attempt may have side effects", async () => {
  let preview = "";
  const result = await approveHostIPCExecution(
    { reason: "unix-socket-eperm", rule: "unix-socket-eperm" },
    {
      ...context,
      humanApproval: async (request) => {
        preview = request.toolInputPreview ?? "";
        return "deny";
      },
    },
  );
  assert.equal(result.action, "deny");
  assert.match(preview, /partial side effects/);
});

test("domain approval consumes a grant bound to the exact hostname and port", async () => {
  let reviewedDestination = "";
  const broker = new BoundaryApprovalBroker({
    reviewer: async (request) => {
      reviewedDestination = request.destination || "";
      return review;
    },
  });
  const result = await approveDomainEndpoint(
    { hostname: "registry.npmjs.org", port: 443, protocol: "https" },
    {
      broker,
      command: "npm install",
      cwd: "/workspace",
      sessionId: "session-domain",
      scopeKey: "turn-domain",
    },
  );
  assert.equal(result.action, "allow");
  assert.equal(result.source, "reviewer");
  assert.equal(reviewedDestination, "registry.npmjs.org:443");
});

test("allows only after consuming the exact reviewer grant", async () => {
  const fake = brokerFor({
    kind: "allow",
    review,
    grant: {
      token: "token",
      requestHash: "hash",
      sessionId: "session-1",
      expiresAt: Date.now() + 60_000,
      usesRemaining: 1,
    },
  });
  const result = await approveSandboxTrap(trap, {
    ...context,
    broker: fake.broker,
  });
  assert.equal(result.action, "allow");
  assert.equal(result.source, "reviewer");
  assert.equal(fake.consumed(), 1);
});

test("direct IP network traps cannot bypass domain approval", async () => {
  const fake = brokerFor({
    kind: "allow",
    review,
    grant: {
      token: "network-token",
      requestHash: "hash",
      sessionId: "session-1",
      expiresAt: Date.now() + 60_000,
      usesRemaining: 1,
    },
  });
  const result = await approveSandboxTrap(networkTrap, {
    ...context,
    broker: fake.broker,
  });
  assert.equal(result.action, "deny");
  assert.equal(result.source, "hard-deny");
  assert.equal(fake.reviewed(), 0);
  assert.equal(fake.consumed(), 0);
});

test("completes the real broker grant issue and consume lifecycle", async () => {
  const auditTypes: string[] = [];
  const broker = new BoundaryApprovalBroker({
    reviewer: async () => review,
    audit(event) {
      auditTypes.push(event.type);
    },
  });
  const result = await approveSandboxTrap(trap, {
    ...context,
    broker,
  });
  assert.equal(result.action, "allow");
  assert.deepEqual(auditTypes, [
    "review_decision",
    "grant_issued",
    "grant_consumed",
  ]);
});

test("fails closed when the reviewer grant cannot be consumed", async () => {
  const fake = brokerFor(
    {
      kind: "allow",
      review,
      grant: {
        token: "token",
        requestHash: "hash",
        sessionId: "session-1",
        expiresAt: Date.now() + 60_000,
        usesRemaining: 1,
      },
    },
    false,
  );
  const result = await approveSandboxTrap(trap, {
    ...context,
    broker: fake.broker,
  });
  assert.equal(result.action, "deny");
  assert.equal(result.source, "invalid-grant");
});

test("uses a human only for defer or an unavailable broker", async () => {
  const fake = brokerFor({
    kind: "defer",
    review: { ...review, outcome: "defer" },
  });
  let prompts = 0;
  const humanApproval = async () => {
    prompts += 1;
    return "allow-once" as const;
  };
  const deferred = await approveSandboxTrap(trap, {
    ...context,
    broker: fake.broker,
    humanApproval,
  });
  const unavailable = await approveSandboxTrap(trap, {
    ...context,
    humanApproval,
  });
  assert.equal(deferred.action, "allow");
  assert.equal(unavailable.action, "allow");
  assert.equal(prompts, 2);
});

test("never sends an explicit deny-match to a model or human", async () => {
  const fake = brokerFor({ kind: "allow", review });
  let prompted = false;
  const result = await approveSandboxTrap(
    { ...trap, reason: "deny_match" },
    {
      ...context,
      broker: fake.broker,
      humanApproval: async () => {
        prompted = true;
        return "allow-once";
      },
    },
  );
  assert.equal(result.action, "deny");
  assert.equal(result.source, "hard-deny");
  assert.equal(fake.reviewed(), 0);
  assert.equal(prompted, false);
});

test("an explicit reviewer denial cannot be overridden by a human", async () => {
  const fake = brokerFor({
    kind: "deny",
    review: { ...review, outcome: "deny" },
    circuitBreakerTripped: false,
  });
  let prompted = false;
  const result = await approveSandboxTrap(trap, {
    ...context,
    broker: fake.broker,
    humanApproval: async () => {
      prompted = true;
      return "allow-once";
    },
  });
  assert.equal(result.action, "deny");
  assert.equal(prompted, false);
});

test("a broker protocol failure cannot be overridden by a human", async () => {
  let prompted = false;
  const result = await approveSandboxTrap(trap, {
    ...context,
    broker: {
      async review() {
        throw new Error("service invariant failed");
      },
      consumeGrant() {
        return false;
      },
    },
    humanApproval: async () => {
      prompted = true;
      return "allow-once";
    },
  });
  assert.equal(result.action, "deny");
  assert.equal(result.source, "unavailable");
  assert.equal(prompted, false);
});
