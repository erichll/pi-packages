import { boundaryRequestHash } from "./grants.ts";
import type {
  BoundaryRequest,
  BoundaryBreakGlassAuthorization,
  BoundaryReview,
  BoundaryReviewContext,
  BoundaryUserOverride,
  RecentBoundaryDenial,
} from "./types.ts";

type PendingOverride = {
  originalRequestId: string;
  approvedAt: number;
};

type PendingBreakGlass = BoundaryBreakGlassAuthorization & {
  scopeKey: string;
};

export class RecentDenialStore {
  readonly #denials: RecentBoundaryDenial[] = [];
  readonly #pending = new Map<string, PendingOverride>();
  readonly #used = new Set<string>();
  readonly #breakGlassPending = new Map<string, PendingBreakGlass>();
  readonly #limit: number;
  readonly #now: () => number;
  readonly #overrideTtlMs: number;
  readonly #criticalDenialTtlMs: number;

  constructor(
    limit = 10,
    now: () => number = Date.now,
    overrideTtlMs = 60_000,
    criticalDenialTtlMs = 300_000,
  ) {
    this.#limit = limit;
    this.#now = now;
    this.#overrideTtlMs = overrideTtlMs;
    this.#criticalDenialTtlMs = criticalDenialTtlMs;
  }

  record(
    request: BoundaryRequest,
    context: BoundaryReviewContext,
    review: BoundaryReview,
  ): void {
    const requestHash = boundaryRequestHash(request);
    const kept = this.#denials.filter(
      (denial) =>
        !(
          denial.sessionId === context.sessionId &&
          denial.scopeKey === context.scopeKey &&
          denial.requestHash === requestHash
        ),
    );
    this.#denials.splice(0, this.#denials.length, ...kept);
    this.#denials.unshift({
      requestId: request.id,
      requestHash,
      request: structuredClone(request),
      review: { ...review },
      sessionId: context.sessionId,
      scopeKey: context.scopeKey,
      deniedAt: this.#now(),
    });
    if (this.#denials.length > this.#limit) {
      this.#denials.length = this.#limit;
    }
  }

  list(sessionId: string): RecentBoundaryDenial[] {
    return this.#denials
      .filter(
        (denial) =>
          denial.sessionId === sessionId &&
          denial.review.riskLevel !== "critical",
      )
      .map((denial) => structuredClone(denial));
  }

  listCritical(
    sessionId: string,
    scopeKey?: string,
  ): RecentBoundaryDenial[] {
    const now = this.#now();
    return this.#denials
      .filter(
        (denial) =>
          denial.sessionId === sessionId &&
          (scopeKey === undefined || denial.scopeKey === scopeKey) &&
          denial.review.outcome === "deny" &&
          denial.review.riskLevel === "critical" &&
          now - denial.deniedAt <= this.#criticalDenialTtlMs,
      )
      .map((denial) => structuredClone(denial));
  }

  authorize(
    requestId: string,
    sessionId: string,
  ): RecentBoundaryDenial | undefined {
    const denial = this.#denials.find(
      (entry) =>
        entry.requestId === requestId &&
        entry.sessionId === sessionId &&
        entry.review.riskLevel !== "critical",
    );
    if (!denial) return;
    const key = this.key(sessionId, denial.requestHash);
    const pending = this.#pending.get(key);
    if (
      pending &&
      this.#now() - pending.approvedAt > this.#overrideTtlMs
    ) {
      this.#pending.delete(key);
    }
    if (this.#used.has(key) || this.#pending.has(key)) return;
    this.#pending.set(key, {
      originalRequestId: denial.requestId,
      approvedAt: this.#now(),
    });
    return structuredClone(denial);
  }

  authorizeCritical(
    requestId: string,
    sessionId: string,
    scopeKey: string,
  ):
    | {
        denial: RecentBoundaryDenial;
        authorization: BoundaryBreakGlassAuthorization;
      }
    | undefined {
    const index = this.#denials.findIndex(
      (entry) =>
        entry.requestId === requestId &&
        entry.sessionId === sessionId &&
        entry.scopeKey === scopeKey &&
        entry.review.outcome === "deny" &&
        entry.review.riskLevel === "critical" &&
        this.#now() - entry.deniedAt <= this.#criticalDenialTtlMs,
    );
    if (index < 0) return;
    const denial = this.#denials[index];
    const key = this.key(sessionId, denial.requestHash);
    if (this.#breakGlassPending.has(key)) return;
    const authorization = {
      originalRequestId: denial.requestId,
      confirmedAt: this.#now(),
    };
    this.#breakGlassPending.set(key, {
      ...authorization,
      scopeKey,
    });
    this.#denials.splice(index, 1);
    return {
      denial: structuredClone(denial),
      authorization: { ...authorization },
    };
  }

  consumeCritical(
    request: BoundaryRequest,
    context: BoundaryReviewContext,
  ): BoundaryBreakGlassAuthorization | undefined {
    const key = this.key(context.sessionId, boundaryRequestHash(request));
    const pending = this.#breakGlassPending.get(key);
    if (!pending) return;
    if (pending.scopeKey !== context.scopeKey) return;
    this.#breakGlassPending.delete(key);
    if (this.#now() - pending.confirmedAt > this.#overrideTtlMs) {
      return;
    }
    return {
      originalRequestId: pending.originalRequestId,
      confirmedAt: pending.confirmedAt,
    };
  }

  consume(
    request: BoundaryRequest,
    context: BoundaryReviewContext,
  ): BoundaryUserOverride | undefined {
    const requestHash = boundaryRequestHash(request);
    const key = this.key(context.sessionId, requestHash);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    if (this.#now() - pending.approvedAt > this.#overrideTtlMs) return;
    this.#used.add(key);
    return { ...pending };
  }

  clear(): void {
    this.#denials.length = 0;
    this.#pending.clear();
    this.#used.clear();
    this.#breakGlassPending.clear();
  }

  private key(
    sessionId: string,
    requestHash: string,
  ): string {
    return `${sessionId}\u0000${requestHash}`;
  }
}
