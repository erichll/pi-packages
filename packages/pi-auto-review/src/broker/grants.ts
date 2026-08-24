import { createHash, randomUUID } from "node:crypto";
import type { BoundaryGrant, BoundaryRequest } from "./types.ts";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function boundaryRequestHash(request: BoundaryRequest): string {
  const material = {
    source: request.source,
    surface: request.surface,
    operation: request.operation,
    cwd: request.cwd,
    command: request.command,
    path: request.path,
    resolvedPath: request.resolvedPath,
    destination: request.destination,
    destinationHost: request.destinationHost,
    destinationPort: request.destinationPort,
    destinationProtocol: request.destinationProtocol,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    skillName: request.skillName,
    toolInputPreview: request.toolInputPreview,
    agentName: request.agentName,
    requesterSessionId: request.requesterSessionId,
    accessIntent: request.accessIntent,
    matchedPolicy: request.matchedPolicy,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(material)))
    .digest("hex");
}

type StoredGrant = Omit<BoundaryGrant, "usesRemaining"> & {
  usesRemaining: number;
};

export class OneShotGrantStore {
  readonly #grants = new Map<string, StoredGrant>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    ttlMs = 60_000,
    now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue(request: BoundaryRequest, sessionId: string): BoundaryGrant {
    this.prune();
    const grant: BoundaryGrant = {
      token: randomUUID(),
      requestHash: boundaryRequestHash(request),
      sessionId,
      expiresAt: this.now() + this.ttlMs,
      usesRemaining: 1,
    };
    this.#grants.set(grant.token, { ...grant });
    return grant;
  }

  consume(
    request: BoundaryRequest,
    sessionId: string,
    token: string,
  ): boolean {
    this.prune();
    const grant = this.#grants.get(token);
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      grant.requestHash !== boundaryRequestHash(request) ||
      grant.usesRemaining !== 1
    ) {
      return false;
    }
    this.#grants.delete(token);
    return true;
  }

  clear(): void {
    this.#grants.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, grant] of this.#grants) {
      if (grant.expiresAt <= now || grant.usesRemaining < 1) {
        this.#grants.delete(token);
      }
    }
  }
}
