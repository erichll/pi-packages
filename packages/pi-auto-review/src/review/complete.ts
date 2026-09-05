import {
  ReviewExecutionError,
} from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildClassifierTranscript,
  parseDecision,
  type ModelDecision,
} from "../policy.ts";
import type {
  BoundaryRequest,
  BoundaryReview,
  BoundaryReviewerContext,
} from "../broker/index.ts";
import type {
  CompletionMessage,
  Config,
  ReviewAttemptObservation,
  ReviewAttemptStatus,
  ReviewErrorClass,
  ReviewExecutionSummary,
  ReviewResult,
  ReviewerMeta,
  ReviewerRuntime,
  ReviewerTelemetryEvent,
} from "./types.ts";
import { FORMAT_RETRY_INSTRUCTION } from "./consts.ts";
import {
  applyReviewerInputBudget,
  preflightPart,
  reviewPreflight,
  sharedReviewContext,
  textFromAssistant,
} from "./input.ts";
import {
  abortableDelay,
  abortableOperation,
  classifyProviderFailure,
  incrementError,
  isFormatError,
  isRetryableError,
  modelCall,
  normalizedStopReason,
  observedUsage,
  parseErrorClass,
  resolveApiKeyAndHeaders,
  resolveReviewerMeta,
  retryDelayMs,
  reviewerSessionId,
  type ProviderAttemptMetadata,
  type ReviewerResolver,
} from "./provider.ts";

export async function complete(
  ctx: ExtensionContext,
  config: Config,
  request: BoundaryRequest,
  reviewerContext?: BoundaryReviewerContext,
  resolve: ReviewerResolver = resolveReviewerMeta,
  observe?: (event: ReviewerTelemetryEvent) => void,
): Promise<ReviewResult> {
  const started = Date.now();
  const selectedTranscript = buildClassifierTranscript(
    ctx.sessionManager.buildContextEntries(),
    config,
    {
      ...request,
      trustedRetryOriginalRequestId:
        reviewerContext?.userOverride?.originalRequestId,
    },
  );
  const transcript = applyReviewerInputBudget(
    request,
    selectedTranscript,
    reviewerContext,
    config.maxReviewerInputTokens,
  );
  const sharedContext = sharedReviewContext(
    request,
    transcript,
    reviewerContext,
  );
  const preflight = reviewPreflight(
    request,
    transcript,
    reviewerContext,
    sharedContext,
    config.maxReviewerInputTokens,
  );
  const deadlineAt = started + config.timeoutMs;
  const controller = new AbortController();
  const onSessionAbort = () => controller.abort();
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", onSessionAbort, { once: true });
  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, Math.max(0, deadlineAt - Date.now()));
  const attempts: ReviewAttemptObservation[] = [];
  const errorCounts: ReviewExecutionSummary["errorCounts"] = {};

  const summary = (): ReviewExecutionSummary => ({
    attempts,
    errorCounts,
    durationMs: Date.now() - started,
    transcript,
    preflight,
  });

  try {
    // A budget preflight failure is a sizing estimate, not a safety verdict.
    // When a human explicitly authorized this exact retry, their decision
    // must not be vetoed by an estimator: proceed with the truncated
    // evidence and let the reviewer see the override. The failureCode stays
    // on the transcript for observability.
    if (transcript.failureCode && !reviewerContext?.userOverride) {
      incrementError(errorCounts, transcript.failureCode);
      throw new ReviewExecutionError(
        transcript.failureCode,
        summary(),
      );
    }
    if (controller.signal.aborted) {
      incrementError(errorCounts, "abort");
      throw new ReviewExecutionError("abort", summary());
    }
    let meta: ReviewerMeta;
    try {
      meta = await abortableOperation(resolve(ctx, config), controller.signal);
    } catch {
      const errorClass = controller.signal.aborted
        ? timeoutFired ? "timeout" : "abort"
        : "model_resolution";
      incrementError(errorCounts, errorClass);
      throw new ReviewExecutionError(errorClass, summary());
    }
    let lastError: unknown;
    let lastErrorClass: ReviewErrorClass = "unknown";
    const retryErrors: ReviewErrorClass[] = [];
    const maxAttempts = Math.min(config.retries + 1, 2);
    const formatRetryFitsBudget =
      preflight.total.estimatedTokens +
        preflightPart(`\n\n${FORMAT_RETRY_INSTRUCTION}`).estimatedTokens <=
      config.maxReviewerInputTokens;
    let formatRetry = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let runtime: ReviewerRuntime;
      try {
        const auth = await abortableOperation(
          resolveApiKeyAndHeaders(ctx, meta.model),
          controller.signal,
        );
        runtime = {
          ...meta,
          auth,
          sessionId: reviewerSessionId(ctx, config, meta.model, auth),
        };
      } catch (error) {
        lastError = error;
        lastErrorClass = controller.signal.aborted
          ? timeoutFired ? "timeout" : "abort"
          : "authentication";
        retryErrors.push(lastErrorClass);
        incrementError(errorCounts, lastErrorClass);
        break;
      }
      if (controller.signal.aborted) {
        lastErrorClass = timeoutFired ? "timeout" : "abort";
        retryErrors.push(lastErrorClass);
        incrementError(errorCounts, lastErrorClass);
        break;
      }

      const attemptStarted = Date.now();
      let message: CompletionMessage | undefined;
      let status: ReviewAttemptStatus = "transport_failure";
      let errorClass: ReviewErrorClass = "unknown";
      let decision: ModelDecision | undefined;
      const providerMetadata: ProviderAttemptMetadata = {};
      try {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          timeoutFired = true;
          controller.abort();
          throw new Error("review deadline exhausted");
        }
        message = await modelCall(
          runtime,
          config,
          controller,
          sharedContext,
          config.maxTokens,
          remainingMs,
          formatRetry,
          providerMetadata,
        );
        if (message.stopReason !== "stop") {
          if (message.stopReason === "aborted") {
            status = timeoutFired ? "timeout" : "abort";
            errorClass = timeoutFired ? "timeout" : "abort";
          } else {
            status = message.stopReason === "error"
              ? "transport_failure"
              : "non_stop";
            errorClass = message.stopReason === "length"
              ? "output_limit"
              : message.stopReason === "error"
                ? classifyProviderFailure(message, undefined, providerMetadata)
                : "provider_stop";
          }
          throw new Error("reviewer returned a non-stop response");
        }
        const text = textFromAssistant(message);
        if (!text) {
          status = "format_error";
          errorClass = "empty_output";
          throw new Error("reviewer returned empty output");
        }
        try {
          decision = parseDecision(text);
        } catch (error) {
          status = "format_error";
          errorClass = parseErrorClass(error);
          throw error;
        }
        status = "success";
        errorClass = "none";
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) {
          status = timeoutFired ? "timeout" : "abort";
          errorClass = timeoutFired ? "timeout" : "abort";
        } else if (errorClass === "unknown") {
          errorClass = classifyProviderFailure(
            message,
            error,
            providerMetadata,
          );
        }
      }
      const usage = observedUsage(message);
      const delayMs = retryDelayMs(errorClass, providerMetadata);
      const willRetry =
        !decision &&
        isRetryableError(errorClass) &&
        (!isFormatError(errorClass) || formatRetryFitsBudget) &&
        attempt < maxAttempts &&
        !controller.signal.aborted &&
        deadlineAt - Date.now() > delayMs;
      const observation: ReviewAttemptObservation = {
        attempt: attempts.length + 1,
        model: message?.responseModel || `${meta.model.provider}/${meta.model.id}`,
        status,
        errorClass,
        stopReason: normalizedStopReason(message?.stopReason),
        durationMs: Date.now() - attemptStarted,
        willRetry,
        usageAvailability: usage.availability,
        usage: usage.usage,
      };
      attempts.push(observation);
      observe?.({
        type: "review_attempt",
        requestId: request.id,
        surface: request.surface,
        ...observation,
      });
      if (decision) {
        return {
          decision,
          attempts: attempts.length,
          retryErrors,
          durationMs: Date.now() - started,
          transcript,
          summary: summary(),
        };
      }
      lastErrorClass = errorClass;
      retryErrors.push(errorClass);
      incrementError(errorCounts, errorClass);
      if (controller.signal.aborted) break;
      if (!willRetry) break;
      formatRetry = isFormatError(errorClass);
      try {
        await abortableDelay(delayMs, controller.signal);
      } catch {
        lastErrorClass = timeoutFired ? "timeout" : "abort";
        incrementError(errorCounts, lastErrorClass);
        break;
      }
    }
    void lastError;
    throw new ReviewExecutionError(lastErrorClass, summary());
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener("abort", onSessionAbort);
  }
}

export function modelDecisionToBoundaryReview(
  decision: ModelDecision,
): BoundaryReview {
  return {
    outcome: decision.outcome,
    riskLevel: decision.risk_level,
    userAuthorization: decision.user_authorization,
    rationale: decision.rationale,
  };
}

export function currentTurnScope(ctx: ExtensionContext): string {
  const userMessages = ctx.sessionManager
    .buildContextEntries()
    .filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const message = (entry as unknown as Record<string, unknown>).message;
      return (
        Boolean(message) &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "user"
      );
    }).length;
  return `${ctx.sessionManager.getSessionId()}:${userMessages}`;
}

export function denialLabel(
  denial: {
    request: BoundaryRequest;
    review: BoundaryReview;
  },
  index: number,
): string {
  const target =
    denial.request.resolvedPath ??
    denial.request.path ??
    denial.request.destination ??
    denial.request.command ??
    denial.request.toolName ??
    denial.request.operation;
  const compact = String(target).replace(/\s+/g, " ").slice(0, 90);
  return `${index + 1}. ${denial.request.surface}: ${compact} — ${denial.review.rationale.slice(0, 70)}`;
}

