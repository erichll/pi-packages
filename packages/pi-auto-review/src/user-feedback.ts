import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const USER_REVIEW_STATUS_KEY = "pi-auto-review";
export const USER_REVIEW_ENTRY_TYPE = "pi-auto-review";

export type UserReviewOutcome =
  | "allow"
  | "deny"
  | "defer"
  | "auto_confirm"
  | "needs_confirmation"
  | "circuit_breaker"
  | "unavailable";

export type UserReviewUsageAvailability =
  | "reported"
  | "estimated"
  | "unavailable"
  | "unknown_provenance";

export type UserReviewUsage = {
  availability: UserReviewUsageAvailability;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  observedInputTokens?: number;
};

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
  const compact = compactReviewText(target, 100);
  return compact || undefined;
}

/** Footer/status bar text while the model review is in flight. */
export function buildUserReviewStatus(
  surface: string,
  target?: string,
): string {
  const compact = compactReviewText(target, 48);
  return compact
    ? `auto-review · reviewing · ${surface} · ${compact}`
    : `auto-review · reviewing · ${surface}`;
}

export function formatReviewTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatReviewDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function formatReviewUsage(usage: UserReviewUsage): string | undefined {
  if (usage.availability === "unavailable") return undefined;
  const parts: string[] = [];
  const input = usage.input ?? usage.observedInputTokens;
  if (input !== undefined) {
    const cache =
      usage.cacheRead && usage.cacheRead > 0
        ? ` (${formatReviewTokenCount(usage.cacheRead)} cache)`
        : "";
    parts.push(`${formatReviewTokenCount(input)} in${cache}`);
  }
  if (usage.output !== undefined) {
    parts.push(`${formatReviewTokenCount(usage.output)} out`);
  }
  if (parts.length === 0 && usage.totalTokens !== undefined) {
    parts.push(`${formatReviewTokenCount(usage.totalTokens)} tok`);
  }
  if (parts.length === 0) return undefined;
  const approx = usage.availability === "estimated" ? "~" : "";
  return `${approx}${parts.join(" · ")}`;
}

/** Display-only model id; drop a leading provider segment when present. */
export function formatReviewModelName(model: unknown): string | undefined {
  const raw = String(model ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  const name =
    slash > 0 && slash < raw.length - 1 ? raw.slice(slash + 1) : raw;
  return compactReviewText(name, 42) || undefined;
}

export function formatReviewMeta(input: {
  model?: string;
  usage?: UserReviewUsage;
  durationMs?: number;
  attempts?: number;
}): string | undefined {
  const parts: string[] = [];
  const model = formatReviewModelName(input.model);
  if (model) parts.push(model);
  if (input.usage) {
    const usage = formatReviewUsage(input.usage);
    if (usage) parts.push(usage);
  }
  const duration = input.durationMs !== undefined
    ? formatReviewDuration(input.durationMs)
    : undefined;
  if (duration) parts.push(duration);
  if (input.attempts && input.attempts > 1) {
    parts.push(`${input.attempts} calls`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function reviewHeadline(outcome: UserReviewOutcome, surface: string): string {
  switch (outcome) {
    case "allow":
      return `Auto-review · allowed · ${surface}`;
    case "auto_confirm":
      return `Auto-review · allowed · auto-confirm · ${surface}`;
    case "needs_confirmation":
      return `Auto-review · allowed · confirm locally · ${surface}`;
    case "defer":
      return `Auto-review · deferred · ${surface}`;
    case "deny":
      return `Auto-review · denied · ${surface}`;
    case "circuit_breaker":
      return `Auto-review · stopped · ${surface}`;
    case "unavailable":
      return `Auto-review · unavailable · ${surface}`;
  }
}

function recoveryLine(
  outcome: UserReviewOutcome,
  recoveryCommand?: "/auto-review-approve" | "/auto-review-break-glass" | false,
): string | undefined {
  if (outcome === "circuit_breaker") {
    return "use /auto-review-approve for one exact retry";
  }
  if (outcome !== "deny") return undefined;
  if (recoveryCommand === false) {
    return "local safety denials cannot be overridden";
  }
  if (recoveryCommand) {
    return `use ${recoveryCommand} for one exact retry`;
  }
  return undefined;
}

function joinNoticeLines(lines: Array<string | undefined>): string[] {
  return lines
    .map((line) => (typeof line === "string" ? line.trimEnd() : ""))
    .filter((line) => line.length > 0);
}

export type UserReviewNoticeInput = {
  outcome: UserReviewOutcome;
  surface: string;
  target?: string;
  rationale?: string;
  recoveryCommand?: "/auto-review-approve" | "/auto-review-break-glass" | false;
  model?: string;
  usage?: UserReviewUsage;
  durationMs?: number;
  attempts?: number;
};

export type UserReviewEntryData = {
  outcome: UserReviewOutcome;
  type: UserReviewNotice["type"];
  lines: string[];
};

type UserReviewTheme = {
  fg(color: string, text: string): string;
  italic(text: string): string;
  getFgAnsi(color: string): string;
};

function noticeType(outcome: UserReviewOutcome): UserReviewNotice["type"] {
  if (outcome === "unavailable") return "error";
  if (outcome === "deny" || outcome === "circuit_breaker") return "warning";
  return "info";
}

function outcomeAccent(
  outcome: UserReviewOutcome,
): "success" | "warning" | "error" | "muted" {
  switch (outcome) {
    case "allow":
    case "auto_confirm":
    case "needs_confirmation":
      return "success";
    case "defer":
      return "muted";
    case "deny":
    case "circuit_breaker":
      return "warning";
    case "unavailable":
      return "error";
  }
}

function outcomeVerb(outcome: UserReviewOutcome): string {
  switch (outcome) {
    case "allow":
    case "auto_confirm":
    case "needs_confirmation":
      return "allowed";
    case "defer":
      return "deferred";
    case "deny":
      return "denied";
    case "circuit_breaker":
      return "stopped";
    case "unavailable":
      return "unavailable";
  }
}

export function buildUserReviewLines(input: UserReviewNoticeInput): string[] {
  return joinNoticeLines([
    reviewHeadline(input.outcome, input.surface),
    compactReviewText(input.target, 100) || undefined,
    compactReviewText(input.rationale, 180) || undefined,
    recoveryLine(input.outcome, input.recoveryCommand),
    formatReviewMeta({
      model: input.model,
      usage: input.usage,
      durationMs: input.durationMs,
      attempts: input.attempts,
    }),
  ]);
}

/**
 * User-facing (not agent-facing) notice after a review decision.
 * Structured for TUI wrapping: headline, target, rationale, then model/tokens.
 */
export function buildUserReviewNotice(
  input: UserReviewNoticeInput,
): UserReviewNotice {
  return {
    type: noticeType(input.outcome),
    message: buildUserReviewLines(input).join("\n"),
  };
}

export function buildUserReviewEntryData(
  input: UserReviewNoticeInput,
): UserReviewEntryData {
  return {
    outcome: input.outcome,
    type: noticeType(input.outcome),
    lines: buildUserReviewLines(input),
  };
}

export function formatUserReviewQuoteMessage(message: string): string {
  return message
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n");
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 0xff ? 2 : 1;
  }
  return width;
}

export function wrapReviewDisplayText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = "";
    currentWidth = 0;
  };
  for (const token of text.split(/(\s+)/)) {
    const tokenWidth = displayWidth(token);
    if (currentWidth + tokenWidth <= width) {
      current += token;
      currentWidth += tokenWidth;
      continue;
    }
    if (/^\s+$/.test(token)) {
      flush();
      continue;
    }
    if (currentWidth > 0) flush();
    if (tokenWidth <= width) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }
    for (const char of token) {
      const charWidth = (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
      if (currentWidth + charWidth > width) flush();
      current += char;
      currentWidth += charWidth;
    }
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

function withQuoteStyle(theme: UserReviewTheme, text: string): string {
  const marker = "\u0000";
  const prefix = theme.italic(theme.fg("mdQuote", marker)).split(marker)[0] ?? "";
  const body = theme.italic(theme.fg("mdQuote", text));
  return prefix ? body.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`) : body;
}

export function renderUserReviewQuoteLines(
  data: UserReviewEntryData,
  theme: UserReviewTheme,
  width: number,
): string[] {
  const contentWidth = Math.max(1, width - 2);
  const border = theme.fg("mdQuoteBorder", "│ ");
  const verb = outcomeVerb(data.outcome);
  const verbAnsi = theme.getFgAnsi(outcomeAccent(data.outcome));
  const numberAnsi = theme.getFgAnsi("success");
  const rendered: string[] = [];
  for (const [index, line] of data.lines.entries()) {
    for (const visual of wrapReviewDisplayText(line, contentWidth)) {
      let painted = visual;
      if (index === 0) {
        painted = painted.replace(
          verb,
          `${verbAnsi}${verb}\x1b[0m`,
        );
      }
      if (index === data.lines.length - 1) {
        painted = painted.replace(
          /(\d+(?:\.\d+)?[kM]?)(?=\s(?:in|out|tok|cache|calls)|ms\b|s\b)/g,
          `${numberAnsi}$1\x1b[0m`,
        );
      }
      rendered.push(border + withQuoteStyle(theme, painted));
    }
  }
  return rendered;
}

export function renderUserReviewEntry(
  entry: { data?: unknown },
  _options: unknown,
  theme: UserReviewTheme,
): { render(width: number): string[]; invalidate(): void } | undefined {
  const data = entry.data;
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as UserReviewEntryData).lines) ||
    (data as UserReviewEntryData).lines.length === 0
  ) {
    return undefined;
  }
  const parsed = data as UserReviewEntryData;
  return {
    render(width: number) {
      return renderUserReviewQuoteLines(parsed, theme, width);
    },
    invalidate() {},
  };
}

function presentUserReviewEntry(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext | undefined,
  data: UserReviewEntryData,
): boolean {
  if (!pi || !ctx?.hasUI || ctx.mode !== "tui") return false;
  try {
    pi.appendEntry(USER_REVIEW_ENTRY_TYPE, data);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort toast; never throws into the authorizer path. */
export function notifyUserReview(
  ctx: ExtensionContext | undefined,
  notice: UserReviewNotice,
): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.notify(formatUserReviewQuoteMessage(notice.message), notice.type);
  } catch {
    // UI delivery is observational and must not change a decision.
  }
}

/** TUI quote-style entry when possible; otherwise a quoted notify toast. */
export function presentUserReview(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext | undefined,
  notice: UserReviewNotice,
  data: UserReviewEntryData,
): void {
  if (presentUserReviewEntry(pi, ctx, data)) return;
  notifyUserReview(ctx, notice);
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
