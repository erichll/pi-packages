import type {
  BoundaryApprovalBrokerService,
  BoundaryRequest,
} from "@erichll/pi-auto-review/broker";
import { sandboxTrapToBoundaryRequest } from "@erichll/pi-auto-review/sandbox";
import type { SandboxApprovalTrap } from "./traps.ts";
import { randomUUID } from "node:crypto";
export type NetworkEndpoint = {
  hostname: string;
  port: number;
  protocol: "http" | "https" | "tcp";
};

export type HumanApproval = (
  request: BoundaryRequest,
  reason?: string,
  signal?: AbortSignal,
) => Promise<"allow-once" | "deny">;

export type TrapApprovalContext = {
  broker?: BoundaryApprovalBrokerService;
  command: string;
  cwd: string;
  sessionId: string;
  scopeKey: string;
  agentName?: string;
  signal?: AbortSignal;
  humanApproval?: HumanApproval;
};

export type TrapApprovalResult = {
  action: "allow" | "deny";
  source:
    | "hard-deny"
    | "reviewer"
    | "human"
    | "unavailable"
    | "invalid-grant";
  reason?: string;
};

export async function approveDomainEndpoint(
  endpoint: NetworkEndpoint,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  const request: BoundaryRequest = {
    id: `sandbox-runtime-network-${randomUUID()}`,
    source: "sandbox-runtime",
    surface: "network",
    operation: "connect",
    cwd: context.cwd,
    command: context.command,
    destination: `${endpoint.hostname}:${endpoint.port}`,
    agentName: context.agentName,
  };
  return approveBoundaryRequest(request, context);
}

async function askHuman(
  request: BoundaryRequest,
  context: TrapApprovalContext,
  reason?: string,
): Promise<TrapApprovalResult> {
  if (!context.humanApproval || context.signal?.aborted) {
    return { action: "deny", source: "unavailable", reason };
  }
  const choice = await context.humanApproval(request, reason, context.signal);
  return choice === "allow-once"
    ? { action: "allow", source: "human", reason }
    : { action: "deny", source: "human", reason };
}

async function approveBoundaryRequest(
  request: BoundaryRequest,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  if (!context.broker) {
    return askHuman(request, context, "pi-auto-review broker is unavailable");
  }

  let decision;
  try {
    decision = await context.broker.review(request, {
      sessionId: context.sessionId,
      scopeKey: context.scopeKey,
      issueGrant: true,
    });
  } catch (error) {
    return {
      action: "deny",
      source: "unavailable",
      reason: `Broker failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (decision.kind === "deny") {
    return {
      action: "deny",
      source: "reviewer",
      reason: decision.review.rationale,
    };
  }
  if (decision.kind === "defer") {
    return askHuman(request, context, decision.review.rationale);
  }
  if (
    !decision.grant ||
    !context.broker.consumeGrant(
      request,
      context.sessionId,
      decision.grant.token,
    )
  ) {
    return {
      action: "deny",
      source: "invalid-grant",
      reason: "The exact one-shot grant is missing, invalid, or expired.",
    };
  }
  return {
    action: "allow",
    source: "reviewer",
    reason: decision.review.rationale,
  };
}

export async function approveSandboxTrap(
  trap: SandboxApprovalTrap,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  const request = sandboxTrapToBoundaryRequest(trap, {
    command: context.command,
    cwd: context.cwd,
    agentName: context.agentName,
  });

  if (trap.kind === "network") {
    return {
      action: "deny",
      source: "hard-deny",
      reason:
        "Direct network access is disabled; use the authenticated domain proxy.",
    };
  }
  if (trap.kind === "filesystem" && trap.reason === "deny_match") {
    return {
      action: "deny",
      source: "hard-deny",
      reason: "The path matches an explicit sandbox deny rule.",
    };
  }
  return approveBoundaryRequest(request, context);
}
