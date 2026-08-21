import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const USER_REVIEW_STATUS_KEY = "pi-auto-review";

export type UserReviewOutcome =
  | "allow"
  | "deny"
  | "defer"
  | "auto_confirm"
  | "needs_confirmation"
  | "circuit_breaker"
  | "unavailable";

export type UserReviewNotice = {
  message: string;
  type: "info" | "warning" | "error";
};

/** Collapse whitespace and bound length for status/notify text. */
export function compactReviewText(value: unknown, max = 90): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function reviewTargetFromRequest(request: {
  resolvedPath?: string;
  path?: string;
  destination?: string;
  command?: string;
  toolName?: string;
  skillName?: string;
  operation?: string;
}): string | undefined {
  const target =
    request.resolvedPath ??
    request.path ??
    request.destination ??
    request.command ??
    request.toolName ??
    request.skillName ??
    request.operation;
  const compact = compactReviewText(target, 90);
  return compact || undefined;
}

/** Footer/status bar text while the model review is in flight. */
export function buildUserReviewStatus(
  surface: string,
  target?: string,
): string {
  const compact = compactReviewText(target, 48);
  return compact
    ? `auto-review: reviewing ${surface} · ${compact}`
    : `auto-review: reviewing ${surface}`;
}

/**
 * User-facing (not agent-facing) notice after a review decision.
 * Kept short so TUI toasts remain readable.
 */
export function buildUserReviewNotice(input: {
  outcome: UserReviewOutcome;
  surface: string;
  target?: string;
  rationale?: string;
  recoveryCommand?: "/auto-review-approve" | "/auto-review-break-glass" | false;
}): UserReviewNotice {
  const target = compactReviewText(input.target, 70);
  const rationale = compactReviewText(input.rationale, 120);
  const subject = target ? `${input.surface} · ${target}` : input.surface;
  const why = rationale ? ` — ${rationale}` : "";

  switch (input.outcome) {
    case "allow":
      return {
        type: "info",
        message: `Auto-review allowed ${subject}${why}`,
      };
    case "auto_confirm":
      return {
        type: "info",
        message: `Auto-review allowed ${subject}; auto-confirming the local dialog${why}`,
      };
    case "needs_confirmation":
      return {
        type: "info",
        message: `Auto-review allowed ${subject}; local confirmation is still required${why}`,
      };
    case "defer":
      return {
        type: "info",
        message: `Auto-review deferred ${subject} to you${why}`,
      };
    case "deny":
      return {
        type: "warning",
        message: `Auto-review denied ${subject}${why}${
          input.recoveryCommand === false
            ? " — local safety denials cannot be overridden"
            : input.recoveryCommand
              ? ` — use ${input.recoveryCommand} for one exact retry`
              : ""
        }`,
      };
    case "circuit_breaker":
      return {
        type: "warning",
        message: `Auto-review stopped after repeated denials this turn${
          why || " — use /auto-review-approve for one exact retry"
        }`,
      };
    case "unavailable":
      return {
        type: "error",
        message: `Auto-review is unavailable${why}`,
      };
  }
}

/** Best-effort toast; never throws into the authorizer path. */
export function notifyUserReview(
  ctx: ExtensionContext | undefined,
  notice: UserReviewNotice,
): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.notify(notice.message, notice.type);
  } catch {
    // UI delivery is observational and must not change a decision.
  }
}

/** Best-effort footer status; pass undefined to clear. */
export function setUserReviewStatus(
  ctx: ExtensionContext | undefined,
  text: string | undefined,
  key = USER_REVIEW_STATUS_KEY,
): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.setStatus?.(key, text);
  } catch {
    // UI delivery is observational and must not change a decision.
  }
}
