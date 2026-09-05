import {
  completeSimple,
  type ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai/compat";
import type { ModelDecision, TranscriptResult } from "../policy.ts";
import type { PolicyAuditConfig } from "../policy-audit/index.ts";

export type ReasoningLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type BoundedSurface = "external_directory" | "path";

export type Config = {
  model: string;
  reasoning: ReasoningLevel;
  timeoutMs: number;
  maxTokens: number;
  retries: number;
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  maxRelevantResultTokens: number;
  maxReviewerInputTokens: number;
  breakGlassEnabled: boolean;
  failureMode: "deny" | "defer";
  grantTtlMs: number;
  autoConfirmBoundedAllows: readonly BoundedSurface[];
  policyAudit: Readonly<PolicyAuditConfig>;
};

export type CompletionMessage = {
  stopReason?: string;
  responseModel?: string;
  errorMessage?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
  };
};

export type UsageAvailability =
  | "reported"
  | "estimated"
  | "unavailable"
  | "unknown_provenance";

export type ReviewUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  observedInputTokens?: number;
};

export type ReviewAttemptStatus =
  | "success"
  | "format_error"
  | "non_stop"
  | "transport_failure"
  | "timeout"
  | "abort";

export type ReviewErrorClass =
  | "none"
  | "non_json"
  | "schema"
  | "empty_output"
  | "output_limit"
  | "provider_stop"
  | "transient_connection"
  | "transient_server"
  | "rate_limit"
  | "timeout"
  | "abort"
  | "authentication"
  | "model_resolution"
  | "request_configuration"
  | "circuit_breaker"
  | "critical_evidence_overflow"
  | "required_profile_overflow"
  | "reviewer_input_budget_exceeded"
  | "unknown";

export type ReviewAttemptObservation = {
  attempt: number;
  model: string;
  status: ReviewAttemptStatus;
  errorClass: ReviewErrorClass;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | "unknown";
  durationMs: number;
  willRetry: boolean;
  usageAvailability: UsageAvailability;
  usage: ReviewUsage;
};

export type PreflightPart = { characters: number; estimatedTokens: number };

export type ReviewPreflight = {
  estimator: "conservative:cjk-aware";
  maxReviewerInputTokens: number;
  framingReserveTokens: number;
  fixedPrompt: PreflightPart;
  canonicalRequest: PreflightPart;
  override: PreflightPart;
  user: PreflightPart;
  tool: PreflightPart;
  relevantResult: PreflightPart;
  framing: PreflightPart;
  total: PreflightPart;
};

export type ReviewExecutionSummary = {
  attempts: ReviewAttemptObservation[];
  errorCounts: Partial<Record<Exclude<ReviewErrorClass, "none">, number>>;
  durationMs: number;
  transcript: TranscriptResult;
  preflight: ReviewPreflight;
};

export type ReviewerTelemetryEvent =
  | ({
      type: "review_attempt";
      requestId: string;
      surface: string;
    } & ReviewAttemptObservation)
  | {
      type: "review_complete";
      requestId: string;
      surface: string;
      model: string;
      reasoning: ReasoningLevel;
      outcome: "allow" | "deny" | "defer";
      failureMode?: "deny" | "defer";
      attempts: number;
      errorCounts: ReviewExecutionSummary["errorCounts"];
      durationMs: number;
      usageAvailability: UsageAvailability;
      usage: ReviewUsage;
      transcript: {
        userCharacters: number;
        toolCharacters: number;
        relevantResultCharacters: number;
        truncated: boolean;
        selectedCandidates: TranscriptResult["selectedCandidates"];
        failureCode?: TranscriptResult["failureCode"];
        userAuthorizationCeiling: TranscriptResult["userAuthorizationCeiling"];
        userConstraint: TranscriptResult["userConstraint"];
        compactionState: TranscriptResult["compactionState"];
        budgetRemovals: TranscriptResult["budgetRemovals"];
      };
      preflight: ReviewPreflight;
    };

export type ReviewerRuntime = {
  model: Parameters<typeof completeSimple>[0];
  auth: {
    apiKey?: string;
    // ProviderHeaders allows null values (e.g. "clear" directives) in 0.84.x.
    headers?: Record<string, string | null>;
    env?: Record<string, string>;
  };
  streamSimple?: ApiStreamSimpleFunction;
  sessionId: string;
};

// Model/stream metadata is re-resolved for every review instead of being
// cached for the session: pi can refresh models.json or re-register a
// provider while a session is live, and the resolved model's baseUrl, api
// or streamSimple may have changed, so a per-session cache could keep
// calling a stale endpoint. Authentication is also deliberately excluded
// because pi resolves models.json auth and headers dynamically on every
// request (including OAuth refresh); it is reacquired per model call in
// complete().
export type ReviewerMeta = Omit<ReviewerRuntime, "auth" | "sessionId">;

export type ReviewResult = {
  decision: ModelDecision;
  attempts: number;
  retryErrors: ReviewErrorClass[];
  durationMs: number;
  transcript: TranscriptResult;
  summary: ReviewExecutionSummary;
  unavailable?: boolean;
};

export class ReviewExecutionError extends Error {
  constructor(
    readonly errorClass: ReviewErrorClass,
    readonly summary: ReviewExecutionSummary,
  ) {
    super(`automatic review failed (${errorClass})`);
    this.name = "ReviewExecutionError";
  }
}

