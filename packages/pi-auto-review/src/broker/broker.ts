import { DenialCircuitBreaker } from "./circuit-breaker.ts";
import { OneShotGrantStore } from "./grants.ts";
import { RecentDenialStore } from "./overrides.ts";
import type {
  BoundaryAuditEvent,
  BoundaryDecision,
  BoundaryHardDeny,
  BoundaryRequest,
  BoundaryReview,
  BoundaryReviewContext,
  BoundaryReviewer,
  RecentBoundaryDenial,
} from "./types.ts";

export type BoundaryApprovalBrokerOptions = {
  reviewer: BoundaryReviewer;
  hardDeny?: BoundaryHardDeny;
  failureMode?: "deny" | "defer";
  grants?: OneShotGrantStore;
  breaker?: DenialCircuitBreaker;
  denials?: RecentDenialStore;
  breakGlassEnabled?: boolean;
  audit?: (event: BoundaryAuditEvent) => void;
};

const FAILURE_REVIEW: BoundaryReview = {
  outcome: "deny",
  riskLevel: "high",
  userAuthorization: "unknown",
  rationale: "Automatic review is unavailable.",
};

function assertRequest(request: BoundaryRequest): void {
  for (const [name, value] of [
    ["id", request.id],
    ["source", request.source],
    ["surface", request.surface],
    ["operation", request.operation],
    ["cwd", request.cwd],
  ]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`boundary request ${name} must be a non-empty string`);
    }
  }
}

export class BoundaryApprovalBroker {
  readonly #reviewer: BoundaryReviewer;
  readonly #hardDeny?: BoundaryHardDeny;
  readonly #failureMode: "deny" | "defer";
  readonly #grants: OneShotGrantStore;
  readonly #breaker: DenialCircuitBreaker;
  readonly #denials: RecentDenialStore;
  readonly #breakGlassEnabled: boolean;
  readonly #audit?: (event: BoundaryAuditEvent) => void;

  constructor(options: BoundaryApprovalBrokerOptions) {
    this.#reviewer = options.reviewer;
    this.#hardDeny = options.hardDeny;
    this.#failureMode = options.failureMode ?? "deny";
    this.#grants = options.grants ?? new OneShotGrantStore();
    this.#breaker = options.breaker ?? new DenialCircuitBreaker();
    this.#denials = options.denials ?? new RecentDenialStore();
    this.#breakGlassEnabled = options.breakGlassEnabled ?? true;
    this.#audit = options.audit;
  }

  async review(
    request: BoundaryRequest,
    context: BoundaryReviewContext,
  ): Promise<BoundaryDecision> {
    assertRequest(request);
    const hardDeny = this.#hardDeny?.(request);
    if (hardDeny) {
      const breaker = this.#breaker.record(context.scopeKey, true);
      const review: BoundaryReview = {
        outcome: "deny",
        riskLevel: "critical",
        userAuthorization: "unknown",
        rationale: hardDeny.reason,
      };
      this.audit("hard_deny", request, {
        rule: hardDeny.rule,
        reason: hardDeny.reason,
      });
      if (breaker.tripped) {
        this.audit("circuit_breaker", request, breaker);
      }
      return {
        kind: "deny",
        review,
        circuitBreakerTripped: breaker.tripped,
        denialSource: "hard-deny",
        recoveryCommand: false,
      };
    }

    const breakGlass = this.#breakGlassEnabled
      ? this.#denials.consumeCritical(request, context)
      : undefined;
    if (breakGlass) {
      const review: BoundaryReview = {
        outcome: "allow",
        riskLevel: "critical",
        userAuthorization: "high",
        rationale: "A human completed break-glass confirmation for this exact request.",
      };
      const grant = context.issueGrant
        ? this.#grants.issue(request, context.sessionId)
        : undefined;
      this.audit("break_glass_consumed", request, {
        originalRequestId: breakGlass.originalRequestId,
        confirmedAt: breakGlass.confirmedAt,
        scopeKey: context.scopeKey,
      });
      if (grant) {
        this.audit("grant_issued", request, {
          requestHash: grant.requestHash,
          expiresAt: grant.expiresAt,
        });
      }
      return {
        kind: "allow",
        review,
        grant,
        authorization: { kind: "break-glass", ...breakGlass },
      };
    }

    const userOverride = this.#denials.consume(request, context);
    if (userOverride) {
      this.audit("override_consumed", request, {
        originalRequestId: userOverride.originalRequestId,
        approvedAt: userOverride.approvedAt,
        scopeKey: context.scopeKey,
      });
    } else if (this.#breaker.isTripped(context.scopeKey)) {
      const review: BoundaryReview = {
        ...FAILURE_REVIEW,
        rationale:
          "Automatic review stopped after repeated denials in this turn.",
      };
      this.audit("circuit_breaker", request, { scopeKey: context.scopeKey });
      return {
        kind: "deny",
        review,
        circuitBreakerTripped: true,
        denialSource: "circuit-breaker",
        recoveryCommand: "/auto-review-approve",
      };
    }

    let review: BoundaryReview;
    try {
      review = await this.#reviewer(request, { userOverride });
    } catch {
      const reason = "Automatic review is unavailable.";
      this.audit("review_failure", request, {
        errorClass: "reviewer_unavailable",
      });
      if (this.#failureMode === "defer") {
        this.#breaker.record(context.scopeKey, false);
        return {
          kind: "defer",
          review: { ...FAILURE_REVIEW, outcome: "defer", rationale: reason },
        };
      }
      const breaker = this.#breaker.record(context.scopeKey, true);
      return {
        kind: "deny",
        review: { ...FAILURE_REVIEW, rationale: reason },
        circuitBreakerTripped: breaker.tripped,
        denialSource: "reviewer",
        recoveryCommand: "/auto-review-approve",
      };
    }

    this.audit("review_decision", request, review);
    if (review.outcome === "deny") {
      this.#denials.record(request, context, review);
      const breaker = this.#breaker.record(context.scopeKey, true);
      if (breaker.tripped) {
        this.audit("circuit_breaker", request, breaker);
      }
      return {
        kind: "deny",
        review,
        circuitBreakerTripped: breaker.tripped,
        denialSource: "reviewer",
        recoveryCommand:
          review.riskLevel === "critical"
            ? this.#breakGlassEnabled
              ? "/auto-review-break-glass"
              : false
            : "/auto-review-approve",
      };
    }

    this.#breaker.record(context.scopeKey, false);
    if (review.outcome === "defer") return { kind: "defer", review };

    const grant = context.issueGrant
      ? this.#grants.issue(request, context.sessionId)
      : undefined;
    if (grant) {
      this.audit("grant_issued", request, {
        requestHash: grant.requestHash,
        expiresAt: grant.expiresAt,
      });
    }
    return { kind: "allow", review, grant };
  }

  consumeGrant(
    request: BoundaryRequest,
    sessionId: string,
    token: string,
  ): boolean {
    const consumed = this.#grants.consume(request, sessionId, token);
    this.audit(consumed ? "grant_consumed" : "grant_rejected", request, {
      sessionId,
    });
    return consumed;
  }

  recentDenials(
    sessionId: string,
  ): RecentBoundaryDenial[] {
    return this.#denials.list(sessionId);
  }

  recentCriticalDenials(
    sessionId: string,
    scopeKey?: string,
  ): RecentBoundaryDenial[] {
    if (!this.#breakGlassEnabled) return [];
    return this.#denials.listCritical(sessionId, scopeKey);
  }

  startBreakGlassChallenge(
    requestId: string,
    sessionId: string,
    scopeKey: string,
  ): RecentBoundaryDenial | undefined {
    if (!this.#breakGlassEnabled) return;
    const denial = this.#denials
      .listCritical(sessionId, scopeKey)
      .find((entry) => entry.requestId === requestId);
    if (denial) {
      this.audit("break_glass_challenge_started", denial.request, {
        scopeKey,
        deniedAt: denial.deniedAt,
        requestHash: denial.requestHash,
      });
    }
    return denial;
  }

  rejectBreakGlassChallenge(
    denial: RecentBoundaryDenial,
    reason: string,
  ): void {
    this.audit("break_glass_rejected", denial.request, {
      scopeKey: denial.scopeKey,
      reason,
      requestHash: denial.requestHash,
    });
  }

  authorizeCriticalDenial(
    requestId: string,
    sessionId: string,
    scopeKey: string,
  ): RecentBoundaryDenial | undefined {
    if (!this.#breakGlassEnabled) return;
    const result = this.#denials.authorizeCritical(
      requestId,
      sessionId,
      scopeKey,
    );
    if (result) {
      this.audit("break_glass_authorized", result.denial.request, {
        scopeKey,
        deniedAt: result.denial.deniedAt,
        requestHash: result.denial.requestHash,
        confirmedAt: result.authorization.confirmedAt,
      });
    }
    return result?.denial;
  }

  authorizeRecentDenial(
    requestId: string,
    sessionId: string,
  ): RecentBoundaryDenial | undefined {
    const denial = this.#denials.authorize(
      requestId,
      sessionId,
    );
    if (denial) {
      this.audit("override_authorized", denial.request, {
        scopeKey: denial.scopeKey,
        deniedAt: denial.deniedAt,
      });
    }
    return denial;
  }

  clear(): void {
    this.#grants.clear();
    this.#breaker.clear();
    this.#denials.clear();
  }

  private audit(
    type: BoundaryAuditEvent["type"],
    request: BoundaryRequest,
    details: Record<string, unknown>,
  ): void {
    this.#audit?.({
      type,
      requestId: request.id,
      surface: request.surface,
      details: { ...details, requestEvidence: request },
    });
  }
}
