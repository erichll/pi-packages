// Internal barrel for the review pipeline. The package's public API surface
// stays re-exported from src/index.ts (package.json exports "."), mirroring
// the broker/ and policy-audit/ directory convention.
export {
  applyUserConfig,
  applyProjectConfig,
  loadConfig,
  loadTrustedConfig,
  packageConfigPath,
  userConfigPath,
  validateConfig,
  DEFAULT_CONFIG,
  type LoadTrustedConfigOptions,
} from "./config.ts";
export { EXTENSION_NAME, PACKAGE_ROOT } from "./consts.ts";
export { writeOptionalAuditFile } from "./audit.ts";
export {
  LOCAL_HARD_DENY_AGENT_INSTRUCTION,
  REVIEWER_CRITICAL_DENY_AGENT_INSTRUCTION,
  REVIEWER_NONCRITICAL_DENY_AGENT_INSTRUCTION,
  REVIEWER_SYSTEM_PROMPT,
} from "./prompts.ts";
export {
  assertTrustedInstallation,
  isWithin,
  protectedWriteHardDeny,
} from "./guards.ts";
export {
  applyReviewerInputBudget,
  boundaryRequest,
  boundedRequest,
  estimateReviewerTokens,
  reviewPreflight,
  sessionConfig,
  sharedReviewContext,
  textFromAssistant,
  type PermissionsService,
} from "./input.ts";
export {
  completeTelemetry,
  noModelSummary,
  resolveReviewerMeta,
  userReviewMetaFromResult,
} from "./provider.ts";
export {
  complete,
  currentTurnScope,
  denialLabel,
  modelDecisionToBoundaryReview,
} from "./complete.ts";
export type {
  BoundedSurface,
  Config,
  ReasoningLevel,
  ReviewErrorClass,
  ReviewExecutionSummary,
  ReviewPreflight,
  ReviewResult,
  ReviewerTelemetryEvent,
} from "./types.ts";
export { ReviewExecutionError } from "./types.ts";
