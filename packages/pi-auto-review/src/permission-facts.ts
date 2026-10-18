import type { DecidingPath } from "@gotgenes/pi-permission-system";
import { pathSurfaceInfo } from "./path-surfaces.ts";

export type { DecidingPath };
export type DelegationLicense = "nothing-on-disk";
export type PermissionAccessFacts = {
  surface: string;
  matchValues: readonly string[];
  boundaryValue?: string;
  /** Evidence only: this package still caps every path-family model allow. */
  delegationLicense?: DelegationLicense;
};

/** Accept only the bounded upstream fact; never spread arbitrary request fields. */
export function normalizeDecidingPath(value: unknown): DecidingPath | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || !candidate.path.trim() ||
      candidate.path.length > 16_384 ||
      typeof candidate.effect !== "string" || !["read", "write", "unproven"].includes(candidate.effect) ||
      typeof candidate.effectSource !== "string" ||
      !["syntax", "core", "declared-global", "declared-project", "retracted", "unproven"].includes(candidate.effectSource)) {
    return undefined;
  }
  return Object.freeze({
    path: candidate.path,
    effect: candidate.effect as DecidingPath["effect"],
    effectSource: candidate.effectSource as DecidingPath["effectSource"],
  });
}

/** Only the access-intent surface can carry a license, never display/UI text. */
export function normalizeDelegationLicense(intent: Record<string, unknown> | undefined): DelegationLicense | undefined {
  return typeof intent?.surface === "string" &&
    pathSurfaceInfo(intent.surface)?.family === "external_directory" &&
    intent.delegationLicense === "nothing-on-disk"
    ? "nothing-on-disk"
    : undefined;
}
