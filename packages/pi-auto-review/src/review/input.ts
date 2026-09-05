import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
  canonicalReviewerJson,
  normalizePermissionEvidence,
  type TranscriptResult,
} from "../policy.ts";
import { parseHostPort } from "../integrations/sandbox.ts";
import { isPathSurface } from "../path-surfaces.ts";
import type { BoundaryRequest, BoundaryReviewerContext } from "../broker/index.ts";
import type {
  CompletionMessage,
  Config,
  PreflightPart,
  ReviewPreflight,
} from "./types.ts";
import {
  EXTENSION_NAME,
  PROJECT_CONFIG_PATH,
  REVIEWER_FRAMING_RESERVE_TOKENS,
} from "./consts.ts";
import { REVIEWER_SYSTEM_PROMPT } from "./prompts.ts";
import { applyProjectConfig } from "./config.ts";
import { assertTrustedInstallation } from "./guards.ts";

export function sessionConfig(
  cwd: string,
  trusted: Config,
  allowUntrustedWorkspace: boolean,
): Readonly<Config> {
  if (!allowUntrustedWorkspace) assertTrustedInstallation(cwd);
  const projectPath = join(cwd, PROJECT_CONFIG_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(projectPath, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Object.freeze({ ...trusted });
    }
    throw new Error(
      `${EXTENSION_NAME}: cannot load ${projectPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return applyProjectConfig(trusted, raw);
}

export function boundedRequest(surface: string): boolean {
  return isPathSurface(surface);
}

export type PermissionsService = {
  registerAuthorizer(
    name: string,
    authorize: (
      details: PromptPermissionDetails,
      query: PermissionQuery,
      log: AuthorizerLog,
    ) => Promise<AuthorizerVerdict>,
  ): () => void;
};

export function boundaryRequest(
  ctx: ExtensionContext,
  details: PromptPermissionDetails,
  query: PermissionQuery,
): BoundaryRequest {
  const evidence = normalizePermissionEvidence(details);
  const surface = evidence.surface;
  const value =
    evidence.resolvedPath ??
    (isPathSurface(surface)
      ? evidence.path
      : evidence.command ?? evidence.value ?? evidence.destination) ??
    details.skillName ??
    details.toolName;
  const deterministicPolicy = query.checkPermission(
    surface,
    value,
    evidence.requester?.agentName,
  );
  const policyRule =
    typeof deterministicPolicy === "string"
      ? deterministicPolicy
      : JSON.stringify(deterministicPolicy);
  const destParsed = parseHostPort(evidence.destination);
  return {
    id: details.requestId,
    source: "permission-system",
    surface,
    operation: details.source || surface,
    cwd: ctx.cwd,
    command: evidence.command,
    path: evidence.path,
    resolvedPath: evidence.resolvedPath,
    destination: evidence.destination,
    destinationHost: destParsed?.host,
    destinationPort: destParsed?.port,
    toolCallId:
      typeof (details as unknown as Record<string, unknown>).toolCallId ===
      "string"
        ? String(
            (details as unknown as Record<string, unknown>).toolCallId,
          )
        : undefined,
    toolName: details.toolName,
    skillName: details.skillName,
    toolInputPreview: details.toolInputPreview,
    agentName: evidence.requester?.agentName,
    requesterSessionId: evidence.requester?.sessionId,
    accessIntent: evidence.accessIntent,
    matchedPolicy: {
      decision: "ask" as const,
      rule: policyRule,
    },
  } satisfies BoundaryRequest;
}

export function textFromAssistant(message: CompletionMessage): string {
  return (message.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function sharedReviewContext(
  request: BoundaryRequest,
  transcript: TranscriptResult,
  reviewerContext?: BoundaryReviewerContext,
): string {
  return canonicalReviewerJson({
    evidence: {
      relevantResults: {
        items: transcript.reviewerEvidence.relevantResults,
        trust: "untrusted",
      },
      toolCalls: {
        items: transcript.reviewerEvidence.toolCalls,
        trust: "untrusted",
      },
      userMessages: {
        items: transcript.reviewerEvidence.userMessages,
        trust: "untrusted",
      },
    },
    omissions: {
      ...(transcript.compactionState !== "none"
        ? { agentGeneratedSummaryExcludedFromAuthorization: true }
        : {}),
      evidenceOmittedOrTruncated: transcript.truncated,
      rawUserAuthorizationUnavailable:
        transcript.compactionState === "authorization-unavailable",
      ...(transcript.budgetRemovals.length > 0
        ? { budgetRemovals: transcript.budgetRemovals }
        : {}),
    },
    ...(reviewerContext?.userOverride
      ? {
          override: {
            ...reviewerContext.userOverride,
            kind: "trusted-exact-retry",
            trust: "host-generated",
          },
        }
      : {}),
    profile: transcript.surfaceProfile,
    request,
  });
}

/**
 * Conservative token estimate for reviewer prompt sizing.
 *
 * CJK code points are estimated at one token each: UTF-8 encodes them as
 * three bytes, so the previous byte-for-token estimator overestimated
 * CJK-heavy review payloads ~3x and synchronously failed the input-budget
 * preflight ("reviewer_input_budget_exceeded") for large CJK tool inputs
 * such as long Chinese plan documents — before the reviewer model was ever
 * called. Remaining code points are estimated from their UTF-8 byte length
 * at 3 bytes per token, slightly conservative for ASCII (typical tokenizers
 * average ~4 bytes per token) and safely conservative for 2-4 byte scripts.
 */
const OTHER_BYTES_PER_TOKEN = 3;

function codePointUtf8Bytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // CJK symbols, punctuation, ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0xff00 && code <= 0xffef) // fullwidth/halfwidth forms
  );
}

/** Exported for tests; see the estimator doc comment above. */
export function estimateReviewerTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    tokens += isCjkCodePoint(code)
      ? 1
      : codePointUtf8Bytes(code) / OTHER_BYTES_PER_TOKEN;
  }
  return Math.ceil(tokens);
}

export function preflightPart(text: string): PreflightPart {
  return {
    characters: text.length,
    estimatedTokens: estimateReviewerTokens(text),
  };
}

export function combinedPreflightPart(values: readonly string[]): PreflightPart {
  return values.reduce<PreflightPart>(
    (total, value) => ({
      characters: total.characters + value.length,
      estimatedTokens:
        total.estimatedTokens + estimateReviewerTokens(value),
    }),
    { characters: 0, estimatedTokens: 0 },
  );
}

export function reviewPreflight(
  request: BoundaryRequest,
  transcript: TranscriptResult,
  reviewerContext: BoundaryReviewerContext | undefined,
  sharedContext: string,
  maxReviewerInputTokens: number,
): ReviewPreflight {
  const fixedPrompt = preflightPart(REVIEWER_SYSTEM_PROMPT);
  const canonicalRequest = preflightPart(canonicalReviewerJson(request));
  const override = preflightPart(
    reviewerContext?.userOverride
      ? canonicalReviewerJson(reviewerContext.userOverride)
      : "",
  );
  const user = combinedPreflightPart(
    transcript.reviewerEvidence.userMessages.map((item) => item.content),
  );
  const tool = combinedPreflightPart(
    transcript.reviewerEvidence.toolCalls.map((item) => item.content),
  );
  const relevantResult = combinedPreflightPart(
    transcript.reviewerEvidence.relevantResults.map((item) => item.content),
  );
  const dynamic = preflightPart(sharedContext);
  const dynamicEvidenceCharacters =
    canonicalRequest.characters +
    override.characters +
    user.characters +
    tool.characters +
    relevantResult.characters;
  const dynamicEvidenceTokens =
    canonicalRequest.estimatedTokens +
    override.estimatedTokens +
    user.estimatedTokens +
    tool.estimatedTokens +
    relevantResult.estimatedTokens;
  const framing: PreflightPart = {
    characters: Math.max(0, dynamic.characters - dynamicEvidenceCharacters),
    estimatedTokens:
      Math.max(0, dynamic.estimatedTokens - dynamicEvidenceTokens) +
      REVIEWER_FRAMING_RESERVE_TOKENS,
  };
  const total: PreflightPart = {
    characters: fixedPrompt.characters + dynamic.characters,
    estimatedTokens:
      fixedPrompt.estimatedTokens +
      dynamic.estimatedTokens +
      REVIEWER_FRAMING_RESERVE_TOKENS,
  };
  return {
    estimator: "conservative:cjk-aware",
    maxReviewerInputTokens,
    framingReserveTokens: REVIEWER_FRAMING_RESERVE_TOKENS,
    fixedPrompt,
    canonicalRequest,
    override,
    user,
    tool,
    relevantResult,
    framing,
    total,
  };
}

export function cloneTranscript(transcript: TranscriptResult): TranscriptResult {
  const cloneItems = (items: TranscriptResult["reviewerEvidence"]["userMessages"]) =>
    items.map((item) => ({
      ...item,
      secondaryReasons: [...item.secondaryReasons],
    }));
  return {
    ...transcript,
    reviewerEvidence: {
      userMessages: cloneItems(transcript.reviewerEvidence.userMessages),
      toolCalls: cloneItems(transcript.reviewerEvidence.toolCalls),
      relevantResults: cloneItems(transcript.reviewerEvidence.relevantResults),
    },
    budgetRemovals: transcript.budgetRemovals.map((item) => ({ ...item })),
    selectedCandidates: transcript.selectedCandidates.map((item) => ({
      ...item,
      secondaryReasons: [...item.secondaryReasons],
    })),
  };
}

export function recordBudgetRemoval(
  transcript: TranscriptResult,
  reason: TranscriptResult["budgetRemovals"][number]["reason"],
  count: number,
): void {
  if (count <= 0) return;
  const existing = transcript.budgetRemovals.find(
    (item) => item.reason === reason,
  );
  if (existing) existing.count += count;
  else transcript.budgetRemovals.push({ reason, count });
}

export function refreshBudgetedTranscript(transcript: TranscriptResult): void {
  const retainedIds = new Set([
    ...transcript.reviewerEvidence.userMessages,
    ...transcript.reviewerEvidence.toolCalls,
    ...transcript.reviewerEvidence.relevantResults,
  ].map((item) => item.id));
  transcript.selectedCandidates = transcript.selectedCandidates.filter(
    (item) => retainedIds.has(item.id),
  );
  transcript.userCharacters = transcript.reviewerEvidence.userMessages.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  transcript.toolCharacters = transcript.reviewerEvidence.toolCalls.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  transcript.relevantResultCharacters =
    transcript.reviewerEvidence.relevantResults.reduce(
      (total, item) => total + item.content.length,
      0,
    );
  if (transcript.budgetRemovals.length > 0) transcript.truncated = true;
}

export function applyReviewerInputBudget(
  request: BoundaryRequest,
  source: TranscriptResult,
  reviewerContext: BoundaryReviewerContext | undefined,
  maxReviewerInputTokens: number,
): TranscriptResult {
  const transcript = cloneTranscript(source);
  if (transcript.failureCode) return transcript;
  const estimatedTokens = () => {
    const context = sharedReviewContext(request, transcript, reviewerContext);
    return reviewPreflight(
      request,
      transcript,
      reviewerContext,
      context,
      maxReviewerInputTokens,
    ).total.estimatedTokens;
  };
  if (estimatedTokens() <= maxReviewerInputTokens) return transcript;

  let secondaryReasonCount = 0;
  for (const item of [
    ...transcript.reviewerEvidence.userMessages,
    ...transcript.reviewerEvidence.toolCalls,
    ...transcript.reviewerEvidence.relevantResults,
  ]) {
    secondaryReasonCount += item.secondaryReasons.length;
    item.secondaryReasons = [];
  }
  for (const item of transcript.selectedCandidates) {
    item.secondaryReasons = [];
  }
  recordBudgetRemoval(transcript, "secondary-reasons", secondaryReasonCount);
  refreshBudgetedTranscript(transcript);
  if (estimatedTokens() <= maxReviewerInputTokens) return transcript;

  for (let index = 0; index < transcript.reviewerEvidence.toolCalls.length;) {
    const item = transcript.reviewerEvidence.toolCalls[index];
    if (!item || item.reason !== "structured-request-match") {
      index++;
      continue;
    }
    transcript.reviewerEvidence.toolCalls.splice(index, 1);
    recordBudgetRemoval(transcript, "older-structured-tool", 1);
    refreshBudgetedTranscript(transcript);
    if (estimatedTokens() <= maxReviewerInputTokens) return transcript;
  }

  for (let index = 0; index < transcript.reviewerEvidence.relevantResults.length;) {
    const item = transcript.reviewerEvidence.relevantResults[index];
    if (!item || item.reason === "sandbox-trap") {
      index++;
      continue;
    }
    transcript.reviewerEvidence.relevantResults.splice(index, 1);
    if (item.toolCallId) {
      transcript.reviewerEvidence.toolCalls =
        transcript.reviewerEvidence.toolCalls.filter(
          (tool) =>
            tool.toolCallId !== item.toolCallId ||
            tool.reason === "exact-tool-call" ||
            tool.reason === "security-combination",
        );
    }
    recordBudgetRemoval(transcript, "optional-result", 1);
    refreshBudgetedTranscript(transcript);
    if (estimatedTokens() <= maxReviewerInputTokens) return transcript;
  }

  transcript.failureCode = "reviewer_input_budget_exceeded";
  return transcript;
}

