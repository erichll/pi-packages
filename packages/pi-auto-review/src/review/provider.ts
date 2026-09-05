import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { BoundaryRequest } from "../broker/index.ts";
import type { UserReviewUsage } from "../user-feedback.ts";
import type {
  CompletionMessage,
  Config,
  ReviewUsage,
  ReviewAttemptObservation,
  ReviewErrorClass,
  ReviewExecutionSummary,
  ReviewResult,
  ReviewerMeta,
  ReviewerRuntime,
  ReviewerTelemetryEvent,
  UsageAvailability,
} from "./types.ts";
import {
  FORMAT_RETRY_INSTRUCTION,
  REVIEWER_FRAMING_RESERVE_TOKENS,
  REVIEWER_MAX_RETRY_AFTER_MS,
  REVIEWER_RETRY_DELAY_MS,
} from "./consts.ts";
import { REVIEWER_SYSTEM_PROMPT } from "./prompts.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { preflightPart } from "./input.ts";

export function finiteUsageValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function observedUsage(message: CompletionMessage | undefined): {
  availability: UsageAvailability;
  usage: ReviewUsage;
} {
  if (!message?.usage || typeof message.usage !== "object") {
    return { availability: "unavailable", usage: {} };
  }
  const input = finiteUsageValue(message.usage.input);
  const output = finiteUsageValue(message.usage.output);
  const cacheRead = finiteUsageValue(message.usage.cacheRead);
  const cacheWrite = finiteUsageValue(message.usage.cacheWrite);
  const reasoning = finiteUsageValue(message.usage.reasoning);
  const totalTokens = finiteUsageValue(message.usage.totalTokens);
  const usage: ReviewUsage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  if (
    input !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined
  ) {
    usage.observedInputTokens = input + cacheRead + cacheWrite;
  }
  // pi-ai always exposes a Usage-shaped object and initializes it with
  // zeroes before provider data arrives, but does not expose provenance.
  // Preserve valid values without claiming that framework zeroes were
  // reported by the provider.
  return {
    availability:
      Object.keys(usage).length > 0
        ? "unknown_provenance"
        : "unavailable",
    usage,
  };
}

export function normalizedStopReason(
  value: string | undefined,
): ReviewAttemptObservation["stopReason"] {
  return ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
    value ?? "",
  )
    ? value as ReviewAttemptObservation["stopReason"]
    : "unknown";
}

export function parseErrorClass(error: unknown): ReviewErrorClass {
  if (!(error instanceof Error)) return "unknown";
  if (error.message === "reviewer returned non-JSON output") return "non_json";
  if (error.message.startsWith("reviewer returned") ||
      error.message.startsWith("reviewer attempted")) return "schema";
  return "unknown";
}

export type ProviderAttemptMetadata = {
  status?: number;
  retryAfterMs?: number;
};

export function numericErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const value of [record.statusCode, record.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

export function classifyProviderFailure(
  message: CompletionMessage | undefined,
  error: unknown,
  metadata: ProviderAttemptMetadata,
): ReviewErrorClass {
  const status = metadata.status ?? numericErrorStatus(error);
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500 && status <= 599) {
    return "transient_server";
  }
  if (status === 401 || status === 403) return "authentication";
  if (status !== undefined && status >= 400 && status <= 499) {
    return "request_configuration";
  }

  const code = errorCode(error);
  if (
    code &&
    new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ENETDOWN",
      "ENETRESET",
      "ENETUNREACH",
      "EHOSTDOWN",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ]).has(code)
  ) {
    return "transient_connection";
  }

  const detail = message?.errorMessage ??
    (error instanceof Error ? error.message : "");
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|authentication/i.test(detail)) {
    return "authentication";
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(detail)) {
    return "rate_limit";
  }
  if (/\b5(?:00|02|03|04)\b|service.?unavailable|server.?error|internal.?error|overloaded/i.test(detail)) {
    return "transient_server";
  }
  if (/unknown model|model not found|invalid model|unsupported model/i.test(detail)) {
    return "model_resolution";
  }
  if (/timed? out|timeout/i.test(detail)) return "timeout";
  if (/\b(?:400|404|405|409|413|415|422)\b|invalid request|configuration|context length|input (?:is )?too long/i.test(detail)) {
    return "request_configuration";
  }
  if (/connection (?:reset|refused|lost)|socket hang up|fetch failed|network.?error|other side closed|stream ended|ended without|eai_again|enotfound/i.test(detail)) {
    return "transient_connection";
  }
  return "unknown";
}

export function isFormatError(errorClass: ReviewErrorClass): boolean {
  return ["non_json", "schema", "empty_output"].includes(errorClass);
}

export function isRetryableError(errorClass: ReviewErrorClass): boolean {
  return isFormatError(errorClass) || [
    "transient_connection",
    "transient_server",
    "rate_limit",
  ].includes(errorClass);
}

export function retryDelayMs(
  errorClass: ReviewErrorClass,
  metadata: ProviderAttemptMetadata,
): number {
  if (isFormatError(errorClass)) return 0;
  if (errorClass === "rate_limit" && metadata.retryAfterMs !== undefined) {
    return metadata.retryAfterMs <= REVIEWER_MAX_RETRY_AFTER_MS
      ? metadata.retryAfterMs
      : Number.POSITIVE_INFINITY;
  }
  return REVIEWER_RETRY_DELAY_MS;
}

export function parseRetryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const retryAfterMs = normalizedHeaders["retry-after-ms"];
  if (retryAfterMs !== undefined) {
    const value = Number.parseFloat(retryAfterMs);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const retryAfter = normalizedHeaders["retry-after"];
  if (retryAfter === undefined) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  const value = Number.isNaN(seconds)
    ? Date.parse(retryAfter) - Date.now()
    : seconds * 1_000;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("review retry aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("review retry aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortableOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      void operation.catch(() => undefined);
      reject(new Error("review operation aborted"));
      return;
    }
    const onAbort = () => {
      reject(new Error("review operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function incrementError(
  counts: ReviewExecutionSummary["errorCounts"],
  errorClass: ReviewErrorClass,
): void {
  if (errorClass === "none") return;
  counts[errorClass] = (counts[errorClass] ?? 0) + 1;
}

export function aggregateUsage(attempts: readonly ReviewAttemptObservation[]): {
  availability: UsageAvailability;
  usage: ReviewUsage;
} {
  const withUsage = attempts.filter(
    (attempt) => attempt.usageAvailability !== "unavailable",
  );
  if (withUsage.length === 0) {
    return { availability: "unavailable", usage: {} };
  }
  const usage: ReviewUsage = {};
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "totalTokens",
    "observedInputTokens",
  ] as const) {
    const values = withUsage
      .map((attempt) => attempt.usage[key])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) {
      usage[key] = values.reduce((total, value) => total + value, 0);
    }
  }
  const availability = withUsage.every(
    (attempt) => attempt.usageAvailability === "reported",
  )
    ? "reported"
    : withUsage.every((attempt) => attempt.usageAvailability === "estimated")
      ? "estimated"
      : "unknown_provenance";
  return { availability, usage };
}

export function userReviewMetaFromResult(
  result: ReviewResult | undefined,
  fallbackModel: string,
): {
  model?: string;
  usage?: UserReviewUsage;
  durationMs?: number;
  attempts?: number;
} {
  if (!result) return {};
  const attempts = result.summary.attempts;
  const aggregate = aggregateUsage(attempts);
  return {
    ...(attempts.length > 0
      ? {
          model: attempts.at(-1)?.model ?? fallbackModel,
          usage: {
            availability: aggregate.availability,
            ...aggregate.usage,
          },
        }
      : {}),
    durationMs: result.durationMs,
    attempts: result.attempts,
  };
}

export function completeTelemetry(
  request: BoundaryRequest,
  config: Readonly<Config>,
  summary: ReviewExecutionSummary,
  outcome: "allow" | "deny" | "defer",
  failureMode?: "deny" | "defer",
): ReviewerTelemetryEvent {
  const aggregate = aggregateUsage(summary.attempts);
  return {
    type: "review_complete",
    requestId: request.id,
    surface: request.surface,
    model: summary.attempts.at(-1)?.model ?? config.model,
    reasoning: config.reasoning,
    outcome,
    ...(failureMode ? { failureMode } : {}),
    attempts: summary.attempts.length,
    errorCounts: { ...summary.errorCounts },
    durationMs: summary.durationMs,
    usageAvailability: aggregate.availability,
    usage: aggregate.usage,
    transcript: {
      userCharacters: summary.transcript.userCharacters,
      toolCharacters: summary.transcript.toolCharacters,
      relevantResultCharacters:
        summary.transcript.relevantResultCharacters,
      truncated: summary.transcript.truncated,
      selectedCandidates: summary.transcript.selectedCandidates.map(
        (candidate) => ({ ...candidate, secondaryReasons: [...candidate.secondaryReasons] }),
      ),
      ...(summary.transcript.failureCode
        ? { failureCode: summary.transcript.failureCode }
        : {}),
      userAuthorizationCeiling: summary.transcript.userAuthorizationCeiling,
      userConstraint: summary.transcript.userConstraint,
      compactionState: summary.transcript.compactionState,
      budgetRemovals: summary.transcript.budgetRemovals.map((item) => ({
        ...item,
      })),
    },
    preflight: summary.preflight,
  };
}

export function noModelSummary(): ReviewExecutionSummary {
  const zero = preflightPart("");
  return {
    attempts: [],
    errorCounts: {},
    durationMs: 0,
    transcript: {
      text: "(model not called)",
      surfaceProfile: "generic",
      reviewerEvidence: {
        userMessages: [],
        toolCalls: [],
        relevantResults: [],
      },
      budgetRemovals: [],
      userCharacters: 0,
      toolCharacters: 0,
      relevantResultCharacters: 0,
      truncated: false,
      selectedCandidates: [],
      userAuthorizationCeiling: "unknown",
      userConstraint: "none",
      compactionState: "none",
    },
    preflight: {
      estimator: "conservative:cjk-aware",
      maxReviewerInputTokens: DEFAULT_CONFIG.maxReviewerInputTokens,
      framingReserveTokens: REVIEWER_FRAMING_RESERVE_TOKENS,
      fixedPrompt: zero,
      canonicalRequest: zero,
      override: zero,
      user: zero,
      tool: zero,
      relevantResult: zero,
      framing: zero,
      total: zero,
    },
  };
}

export function parseModelRef(modelRef: string): {
  provider?: string;
  modelId: string;
} {
  if (!modelRef.includes("/")) {
    return { modelId: modelRef };
  }
  const [provider, ...idParts] = modelRef.split("/");
  return { provider, modelId: idParts.join("/") };
}


export function reviewerSessionId(
  ctx: ExtensionContext,
  config: Config,
  model: ReviewerMeta["model"],
  auth: ReviewerRuntime["auth"],
): string {
  // Providers can use sessionId for prompt caches, routing, or affinity.
  // Bind that identity to endpoint and authentication metadata so a live
  // provider/auth refresh cannot reuse stale cache or routing state.
  // Hash the complete identity and keep the result below pi-ai's 64-character
  // prompt-cache-key limit, which would otherwise be able to truncate away a
  // distinguishing suffix on long session IDs or base URLs.
  const identity = JSON.stringify({
    sessionId: ctx.sessionManager.getSessionId(),
    modelRef: config.model,
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    modelHeaders: Object.entries(model.headers ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    auth: {
      apiKey: auth.apiKey,
      headers: Object.entries(auth.headers ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      env: Object.entries(auth.env ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    },
  });
  const fingerprint = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 48);
  return `pi-auto-review-${fingerprint}`;
}

export async function resolveReviewerMeta(
  ctx: ExtensionContext,
  config: Config,
): Promise<ReviewerMeta> {
  const { provider, modelId } = parseModelRef(config.model);
  const available = ctx.modelRegistry.getAvailable();
  const registeredModel = provider
    ? ctx.modelRegistry.find(provider, modelId)
    : available.find(
        (candidate) =>
          candidate.id === modelId || candidate.name === modelId,
      );
  const providerFallback = provider
    ? available.find((candidate) => candidate.provider === provider)
    : undefined;
  const model =
    registeredModel ||
    (providerFallback
      ? { ...providerFallback, id: modelId, name: modelId }
      : undefined);
  if (!model) {
    throw new Error(
      provider
        ? `provider ${provider} is unavailable for custom model ${config.model}`
        : `model ${config.model} is unavailable`,
    );
  }

  const registered = (
    ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
      getRegisteredProviderConfig?: (
        name: string,
      ) =>
        | {
            api?: string;
            streamSimple?: ReviewerRuntime["streamSimple"];
          }
        | undefined;
    }
  ).getRegisteredProviderConfig?.(model.provider);

  return {
    model,
    streamSimple:
      registered?.api === model.api ? registered.streamSimple : undefined,
  };
}

// pi resolves models.json auth and headers dynamically on every request;
// reacquire authentication per model call instead of pinning it for the
// session (rotating OAuth tokens would otherwise go stale and fail closed
// until session restart).
export async function resolveApiKeyAndHeaders(
  ctx: ExtensionContext,
  model: ReviewerMeta["model"],
): Promise<ReviewerRuntime["auth"]> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`model authentication failed: ${auth.error}`);
  return auth;
}

export async function modelCall(
  runtime: ReviewerRuntime,
  config: Config,
  controller: AbortController,
  sharedContext: string,
  maxTokens: number,
  timeoutMs: number,
  formatRetry: boolean,
  metadata: ProviderAttemptMetadata,
): Promise<CompletionMessage> {
  const context = {
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: formatRetry
          ? `${sharedContext}\n\n${FORMAT_RETRY_INSTRUCTION}`
          : sharedContext,
        timestamp: Date.now(),
      },
    ],
  };
  const options = {
    apiKey: runtime.auth.apiKey,
    headers: runtime.auth.headers,
    env: runtime.auth.env,
    signal: controller.signal,
    maxTokens,
    maxRetries: 0,
    reasoning: config.reasoning === "off" ? undefined : config.reasoning,
    cacheRetention: "short" as const,
    // A permission review is a complete independent request. In particular,
    // do not let Codex WebSocket continuation attach a prior review response
    // to the next approval merely because they share a cache identity.
    transport: "sse" as const,
    sessionId: runtime.sessionId,
    timeoutMs,
    onResponse: (response: { status: number; headers: Record<string, string> }) => {
      metadata.status = response.status;
      metadata.retryAfterMs = parseRetryAfterMs(response.headers);
    },
  };
  return (runtime.streamSimple
    ? await runtime.streamSimple(runtime.model, context, options).result()
    : await completeSimple(runtime.model, context, options)) as CompletionMessage;
}

export type ReviewerResolver = (
  ctx: ExtensionContext,
  config: Config,
) => Promise<ReviewerMeta>;
