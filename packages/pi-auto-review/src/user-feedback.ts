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
        ? ` (${formatReviewTokenCount(usage.cacheRead)} toks cache)`
        : "";
    parts.push(`${formatReviewTokenCount(input)} toks in${cache}`);
  }
  if (usage.output !== undefined) {
    parts.push(`${formatReviewTokenCount(usage.output)} toks out`);
  }
  if (parts.length === 0 && usage.totalTokens !== undefined) {
    parts.push(`${formatReviewTokenCount(usage.totalTokens)} toks`);
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

function reviewTargetRationaleLine(input: {
  target?: string;
  rationale?: string;
}): string | undefined {
  const target = compactReviewText(input.target, 100);
  const rationale = compactReviewText(input.rationale, 180);
  if (target && rationale) return `${target} · ${rationale}`;
  return target || rationale || undefined;
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

export type UserReviewGroupMember = UserReviewNoticeInput & {
  requestId: string;
  permissionResult?: "allow" | "deny";
};

export type UserReviewGroupEntryData = {
  kind: "group";
  type: UserReviewNotice["type"];
  sessionId: string;
  toolCallId: string;
  fullCommand?: string;
  members: UserReviewGroupMember[];
};

export type AnyUserReviewEntryData =
  | UserReviewEntryData
  | UserReviewGroupEntryData;

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

function memberOutcomeText(outcome: UserReviewOutcome): string {
  switch (outcome) {
    case "auto_confirm":
      return "allowed · auto-confirm";
    case "needs_confirmation":
      return "allowed · confirm locally";
    default:
      return outcomeVerb(outcome);
  }
}

export function buildUserReviewLines(input: UserReviewNoticeInput): string[] {
  return joinNoticeLines([
    reviewHeadline(input.outcome, input.surface),
    reviewTargetRationaleLine(input),
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
 * Structured for TUI wrapping: headline, target+rationale, then model/tokens.
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
  return message;
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
  const contentWidth = Math.max(1, width);
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
          /(\d+(?:\.\d+)?[kM]?)(?=\s(?:toks|calls)|ms\b|s\b)/g,
          `${numberAnsi}$1\x1b[0m`,
        );
      }
      rendered.push(withQuoteStyle(theme, painted));
    }
  }
  return rendered;
}

function groupOutcome(members: readonly UserReviewGroupMember[]): UserReviewOutcome {
  if (members.some((member) => member.permissionResult === "deny")) return "deny";
  for (const outcome of [
    "circuit_breaker",
    "deny",
    "unavailable",
    "defer",
    "needs_confirmation",
    "auto_confirm",
  ] as const) {
    if (members.some((member) => member.outcome === outcome)) return outcome;
  }
  return "allow";
}

function groupHeadline(data: UserReviewGroupEntryData): string {
  const outcome = groupOutcome(data.members);
  const result = outcome === "deny" || outcome === "circuit_breaker" ||
      outcome === "unavailable"
    ? "denied"
    : outcome === "defer" || outcome === "needs_confirmation"
      ? "deferred"
      : "allowed";
  return `Auto-review · ${result} · ${data.members.length} checks`;
}

export function buildUserReviewGroupLines(
  data: UserReviewGroupEntryData,
): UserReviewEntryData {
  if (data.members.length === 1) {
    const member = data.members[0];
    const lines = buildUserReviewLines(member);
    if (member.permissionResult === "deny" && member.outcome !== "deny") {
      lines.push("Local confirmation · denied");
    }
    return { outcome: groupOutcome(data.members), type: data.type, lines };
  }

  const lines: string[] = [groupHeadline(data)];
  const command = String(data.fullCommand ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (command) lines.push(command);
  for (const member of data.members) {
    const summary = joinNoticeLines([
      member.surface,
      memberOutcomeText(member.outcome),
      reviewTargetRationaleLine(member),
    ]).join(" · ");
    lines.push(
      summary,
      ...joinNoticeLines([
        recoveryLine(member.outcome, member.recoveryCommand),
        member.permissionResult === "deny" && member.outcome !== "deny"
          ? "Local confirmation · denied"
          : undefined,
        formatReviewMeta(member),
      ]),
    );
  }
  return { outcome: groupOutcome(data.members), type: data.type, lines };
}

export function renderUserReviewEntry(
  entry: { data?: unknown },
  _options: unknown,
  theme: UserReviewTheme,
): { render(width: number): string[]; invalidate(): void } | undefined {
  const data = entry.data;
  if (
    data &&
    typeof data === "object" &&
    (data as UserReviewGroupEntryData).kind === "group" &&
    Array.isArray((data as UserReviewGroupEntryData).members) &&
    (data as UserReviewGroupEntryData).members.length > 0
  ) {
    const parsed = data as UserReviewGroupEntryData;
    return {
      render(width: number) {
        return renderUserReviewQuoteLines(
          buildUserReviewGroupLines(parsed),
          theme,
          width,
        );
      },
      invalidate() {},
    };
  }
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

function presentUserReviewGroupEntry(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext | undefined,
  data: UserReviewGroupEntryData,
): boolean {
  if (!pi || !ctx?.hasUI || ctx.mode !== "tui") return false;
  try {
    pi.appendEntry(USER_REVIEW_ENTRY_TYPE, data);
    return true;
  } catch {
    return false;
  }
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

/** TUI structured entry when possible; otherwise a plain notify toast. */
export function presentUserReview(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext | undefined,
  notice: UserReviewNotice,
  data: UserReviewEntryData,
): void {
  if (presentUserReviewEntry(pi, ctx, data)) return;
  notifyUserReview(ctx, notice);
}

type PendingReviewGroup = {
  sessionId: string;
  toolCallId: string;
  fullCommand?: string;
  members: Map<string, {
    member: UserReviewGroupMember;
    notice: UserReviewNotice;
    data: UserReviewEntryData;
  }>;
  ctx: ExtensionContext;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type ReviewEntryBatcherOptions = {
  maxGroups?: number;
  maxMembers?: number;
  ttlMs?: number;
  now?: () => number;
};

/** Buffers only transcript presentation; permission requests remain independent. */
export class ReviewEntryBatcher {
  readonly #groups = new Map<string, PendingReviewGroup>();
  readonly #maxGroups: number;
  readonly #maxMembers: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(
    private readonly pi: ExtensionAPI,
    options: ReviewEntryBatcherOptions = {},
  ) {
    this.#maxGroups = options.maxGroups ?? 32;
    this.#maxMembers = options.maxMembers ?? 8;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  enqueue(input: {
    sessionId: string;
    toolCallId: string;
    fullCommand?: string;
    member: UserReviewGroupMember;
    notice: UserReviewNotice;
    data: UserReviewEntryData;
    ctx: ExtensionContext;
  }): void {
    try {
      const key = this.#key(input.sessionId, input.toolCallId);
      let group = this.#groups.get(key);
      if (group?.members.has(input.member.requestId)) return;
      if (group && group.members.size >= this.#maxMembers) {
        this.#flushKey(key);
        group = undefined;
      }
      if (!group) {
        if (this.#groups.size >= this.#maxGroups) {
          const oldest = [...this.#groups.entries()].sort(
            (left, right) => left[1].createdAt - right[1].createdAt,
          )[0]?.[0];
          if (oldest) this.#flushKey(oldest);
        }
        const timer = setTimeout(() => this.#flushKey(key), this.#ttlMs);
        timer.unref?.();
        group = {
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          fullCommand: input.fullCommand,
          members: new Map(),
          ctx: input.ctx,
          createdAt: this.#now(),
          timer,
        };
        this.#groups.set(key, group);
      } else if (!group.fullCommand && input.fullCommand) {
        group.fullCommand = input.fullCommand;
      }
      group.members.set(input.member.requestId, {
        member: input.member,
        notice: input.notice,
        data: input.data,
      });
      if (input.member.outcome === "deny" ||
          input.member.outcome === "circuit_breaker") {
        this.#flushKey(key);
      }
    } catch {
      presentUserReview(this.pi, input.ctx, input.notice, input.data);
    }
  }

  toolExecutionStarted(
    sessionId: string,
    toolCallId: string,
    args: unknown,
  ): void {
    const key = this.#key(sessionId, toolCallId);
    const group = this.#groups.get(key);
    if (!group) return;
    if (!group.fullCommand && args && typeof args === "object" &&
        !Array.isArray(args) &&
        typeof (args as Record<string, unknown>).command === "string") {
      group.fullCommand = String((args as Record<string, unknown>).command);
    }
    this.#flushKey(key);
  }

  permissionDecision(event: unknown): void {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    if (typeof record.requestId !== "string" ||
        (record.result !== "allow" && record.result !== "deny")) return;
    for (const [key, group] of this.#groups) {
      const pending = group.members.get(record.requestId);
      if (!pending) continue;
      pending.member.permissionResult = record.result;
      if (record.result === "deny") this.#flushKey(key);
      return;
    }
  }

  flushAll(): void {
    for (const key of [...this.#groups.keys()]) this.#flushKey(key);
  }

  get pendingGroups(): number {
    return this.#groups.size;
  }

  #key(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u0000${toolCallId}`;
  }

  #flushKey(key: string): void {
    const group = this.#groups.get(key);
    if (!group) return;
    this.#groups.delete(key);
    clearTimeout(group.timer);
    const pending = [...group.members.values()];
    if (pending.length === 0) return;
    const members = pending.map((entry) => entry.member);
    const data: UserReviewGroupEntryData = {
      kind: "group",
      type: noticeType(groupOutcome(members)),
      sessionId: group.sessionId,
      toolCallId: group.toolCallId,
      ...(group.fullCommand ? { fullCommand: group.fullCommand } : {}),
      members,
    };
    if (presentUserReviewGroupEntry(this.pi, group.ctx, data)) return;
    for (const entry of pending) {
      presentUserReview(this.pi, group.ctx, entry.notice, entry.data);
    }
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
