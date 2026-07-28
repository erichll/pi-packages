import { boundaryRequestHash } from "./grants.ts";
import type {
  BoundaryRequest,
  BoundaryReview,
  BoundaryReviewContext,
  BoundaryUserOverride,
  RecentBoundaryDenial,
} from "./types.ts";

type PendingOverride = {
  originalRequestId: string;
  approvedAt: number;
};

export class RecentDenialStore {
  readonly #denials: RecentBoundaryDenial[] = [];
  readonly #pending = new Map<string, PendingOverride>();
  readonly #used = new Set<string>();
  readonly #limit: number;
  readonly #now: () => number;
  readonly #overrideTtlMs: number;

  constructor(
    limit = 10,
    now: () => number = Date.now,
    overrideTtlMs = 60_000,
  ) {
    this.#limit = limit;
    this.#now = now;
    this.#overrideTtlMs = overrideTtlMs;
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
      .filter((denial) => denial.sessionId === sessionId)
      .map((denial) => structuredClone(denial));
  }

  authorize(
    requestId: string,
    sessionId: string,
  ): RecentBoundaryDenial | undefined {
    const denial = this.#denials.find(
      (entry) =>
        entry.requestId === requestId &&
        entry.sessionId === sessionId,
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
  }

  private key(
    sessionId: string,
    requestHash: string,
  ): string {
    return `${sessionId}\u0000${requestHash}`;
  }
}
