export type BoundarySurface =
  | "command"
  | "filesystem-read"
  | "filesystem-write"
  | "network"
  | "mcp"
  | "skill"
  | (string & {});

export type BoundarySource =
  | "permission-system"
  | "sandbox-runtime"
  | (string & {});

export type BoundaryRequest = {
  id: string;
  source: BoundarySource;
  surface: BoundarySurface;
  operation: string;
  cwd: string;
  command?: string;
  path?: string;
  resolvedPath?: string;
  destination?: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  toolInputPreview?: string;
  agentName?: string;
  requesterSessionId?: string;
  accessIntent?: {
    surface: string;
    matchValues: readonly string[];
    boundaryValue?: string;
  };
  matchedPolicy?: {
    decision: "ask";
    rule?: string;
  };
};

export type BoundaryRiskLevel = "low" | "medium" | "high" | "critical";
export type UserAuthorization = "unknown" | "low" | "medium" | "high";

export type BoundaryReview = {
  outcome: "allow" | "deny" | "defer";
  riskLevel: BoundaryRiskLevel;
  userAuthorization: UserAuthorization;
  rationale: string;
};

export type BoundaryGrant = {
  token: string;
  requestHash: string;
  sessionId: string;
  expiresAt: number;
  usesRemaining: 1;
};

export type BoundaryDecision =
  | {
      kind: "allow";
      review: BoundaryReview;
      grant?: BoundaryGrant;
      authorization?: {
        kind: "break-glass";
        originalRequestId: string;
        confirmedAt: number;
      };
    }
  | {
      kind: "deny";
      review: BoundaryReview;
      circuitBreakerTripped: boolean;
      denialSource?: "hard-deny" | "reviewer" | "circuit-breaker";
      recoveryCommand?:
        | "/auto-review-approve"
        | "/auto-review-break-glass"
        | false;
    }
  | {
      kind: "defer";
      review: BoundaryReview;
    };

export type BoundaryReviewContext = {
  sessionId: string;
  scopeKey: string;
  issueGrant?: boolean;
};

export type BoundaryUserOverride = {
  originalRequestId: string;
  approvedAt: number;
};

export type BoundaryBreakGlassAuthorization = {
  originalRequestId: string;
  confirmedAt: number;
};

export type BoundaryReviewerContext = {
  userOverride?: BoundaryUserOverride;
};

export type RecentBoundaryDenial = {
  requestId: string;
  requestHash: string;
  request: BoundaryRequest;
  review: BoundaryReview;
  sessionId: string;
  scopeKey: string;
  deniedAt: number;
};

export type BoundaryAuditEvent = {
  type:
    | "hard_deny"
    | "review_decision"
    | "review_failure"
    | "circuit_breaker"
    | "grant_issued"
    | "grant_consumed"
    | "grant_rejected"
    | "override_authorized"
    | "override_consumed"
    | "break_glass_challenge_started"
    | "break_glass_authorized"
    | "break_glass_consumed"
    | "break_glass_rejected";
  requestId: string;
  surface: string;
  details: Record<string, unknown>;
};

export type BoundaryReviewer = (
  request: BoundaryRequest,
  context?: BoundaryReviewerContext,
) => Promise<BoundaryReview>;

export type BoundaryHardDeny = (
  request: BoundaryRequest,
) => { rule: string; reason: string } | undefined;
