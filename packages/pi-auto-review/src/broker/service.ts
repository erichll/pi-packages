import type { BoundaryApprovalBroker } from "./broker.ts";
import type {
  BoundaryDecision,
  BoundaryRequest,
  BoundaryReviewContext,
} from "./types.ts";

export const BOUNDARY_BROKER_SERVICE_KEY = Symbol.for(
  "pi-auto-review:boundary-approval-broker",
);

export type BoundaryApprovalBrokerService = {
  review(
    request: BoundaryRequest,
    context: BoundaryReviewContext,
  ): Promise<BoundaryDecision>;
  consumeGrant(
    request: BoundaryRequest,
    sessionId: string,
    token: string,
  ): boolean;
};

export function publishBoundaryBroker(
  broker: BoundaryApprovalBroker,
): () => void {
  const target = globalThis as Record<symbol, unknown>;
  if (target[BOUNDARY_BROKER_SERVICE_KEY]) {
    throw new Error("pi-auto-review boundary broker is already published");
  }
  const service: BoundaryApprovalBrokerService = {
    review: (request, context) => broker.review(request, context),
    consumeGrant: (request, sessionId, token) =>
      broker.consumeGrant(request, sessionId, token),
  };
  target[BOUNDARY_BROKER_SERVICE_KEY] = service;
  return () => {
    if (target[BOUNDARY_BROKER_SERVICE_KEY] === service) {
      delete target[BOUNDARY_BROKER_SERVICE_KEY];
    }
  };
}

export function getBoundaryBroker():
  | BoundaryApprovalBrokerService
  | undefined {
  return (globalThis as Record<symbol, unknown>)[
    BOUNDARY_BROKER_SERVICE_KEY
  ] as BoundaryApprovalBrokerService | undefined;
}
