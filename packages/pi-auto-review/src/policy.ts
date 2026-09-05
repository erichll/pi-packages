import { isPathSurface } from "./path-surfaces.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ModelDecision = {
  outcome: "allow" | "deny" | "defer";
  risk_level: RiskLevel;
  user_authorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
};

export type PermissionDetailsLike = {
  surface?: string | null;
  value?: unknown;
  toolName?: string;
  skillName?: string;
  command?: unknown;
  path?: unknown;
  target?: unknown;
  agentName?: unknown;
  toolInputPreview?: unknown;
  accessIntent?: unknown;
  forwarding?: unknown;
};

export type NormalizedPermissionEvidence = {
  surface: string;
  value?: string;
  command?: string;
  path?: string;
  resolvedPath?: string;
  destination?: string;
  accessIntent?: {
    surface: string;
    matchValues: readonly string[];
    boundaryValue?: string;
  };
  requester?: {
    agentName?: string;
    sessionId?: string;
  };
};

export type TranscriptConfig = {
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  maxRelevantResultTokens?: number;
};

export type TranscriptResult = {
  text: string;
  surfaceProfile: EvidenceSurfaceProfile;
  reviewerEvidence: {
    userMessages: ReviewerEvidenceItem[];
    toolCalls: ReviewerEvidenceItem[];
    relevantResults: ReviewerEvidenceItem[];
  };
  budgetRemovals: ReviewerBudgetRemoval[];
  userCharacters: number;
  toolCharacters: number;
  relevantResultCharacters: number;
  truncated: boolean;
  selectedCandidates: EvidenceCandidateMetadata[];
  failureCode?:
    | "critical_evidence_overflow"
    | "required_profile_overflow"
    | "reviewer_input_budget_exceeded";
  userAuthorizationCeiling: "unknown" | "low" | "medium" | "high";
  userConstraint: "none" | "narrowed" | "revoked";
  compactionState: "none" | "summary-present" | "authorization-unavailable";
};

export type ReviewerBudgetRemoval = {
  reason:
    | "secondary-reasons"
    | "older-structured-tool"
    | "optional-result";
  count: number;
};

export type ReviewerEvidenceItem = {
  id: string;
  reason: EvidenceSelectionReason;
  secondaryReasons: EvidenceSelectionReason[];
  toolCallId?: string;
  content: string;
};

type Evidence = {
  id: string;
  index: number;
  entryIndex: number;
  kind: "user" | "tool";
  text: string;
  toolCallId?: string;
  reason: EvidenceSelectionReason;
  secondaryReasons: EvidenceSelectionReason[];
  sensitivity: EvidenceSensitivity;
  originalCharacters: number;
  preTruncated: boolean;
  representationCharacters?: number;
};

export type EvidenceSensitivity =
  | "user-intent"
  | "tool-input"
  | "tool-output"
  | "boundary"
  | "credential"
  | "permission-control"
  | "authorization-persistence"
  | "transport-weakening"
  | "audit-control"
  | "security-control";

export type EvidenceSelectionReason =
  | "latest-user"
  | "exact-request-reference"
  | "trusted-retry-user-message"
  | "exact-tool-call"
  | "structured-request-match"
  | "security-combination"
  | "same-tool"
  | "delete-precheck"
  | "git-push-context"
  | "provider-branch-protection"
  | "sandbox-trap";

export type EvidenceSurfaceProfile =
  | "network"
  | "delete"
  | "git-push"
  | "forwarded"
  | "generic";

export type EvidenceCandidateMetadata = {
  id: string;
  entryIndex: number;
  kind: "user" | "tool-call" | "tool-result" | "sandbox-trap";
  toolCallId?: string;
  reason: EvidenceSelectionReason;
  secondaryReasons: EvidenceSelectionReason[];
  surfaceProfile: EvidenceSurfaceProfile;
  originalCharacters: number;
  selectedCharacters: number;
  estimatedTokens: number;
  truncated: boolean;
  sensitivity: EvidenceSensitivity;
};

export type RelevantBoundaryRequest = {
  id?: string;
  source?: string;
  surface?: string;
  operation?: string;
  cwd?: string;
  command?: string;
  path?: string;
  resolvedPath?: string;
  destination?: string;
  destinationHost?: string;
  destinationPort?: number;
  destinationProtocol?: string;
  toolCallId?: string;
  toolName?: string;
  toolInputPreview?: string;
  agentName?: string;
  requesterSessionId?: string;
  accessIntent?: {
    surface: string;
    matchValues: readonly string[];
    boundaryValue?: string;
  };
  trustedRetryOriginalRequestId?: string;
};

const MAX_EVIDENCE_ITEM_CHARACTERS = 4_000;

/** Stable compact JSON for reviewer-only representations. */
export function canonicalReviewerJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    return Object.fromEntries(
      Object.keys(current as Record<string, unknown>)
        .sort()
        .map((key) => [key, (current as Record<string, unknown>)[key]]),
    );
  }) ?? "null";
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

// Some reviewer models (notably any routed through Claude Code, which always
// markdown-fences JSON) wrap the decision object in a ```json ... ``` block
// despite the prompt forbidding markdown. Strip a single enclosing fence before
// parsing; the strict shape validation below is unchanged.
function stripReviewerFence(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced?.[1] ?? t).trim();
}

export function parseDecision(text: string): ModelDecision {
  let value: unknown;
  try {
    value = JSON.parse(stripReviewerFence(text));
  } catch {
    throw new Error("reviewer returned non-JSON output");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reviewer returned a non-object");
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "outcome",
      "risk_level",
      "user_authorization",
      "rationale",
    ])
  ) {
    throw new Error("reviewer returned unexpected fields");
  }
  if (!["allow", "deny", "defer"].includes(String(record.outcome))) {
    throw new Error("reviewer returned an invalid outcome");
  }
  if (
    !["low", "medium", "high", "critical"].includes(
      String(record.risk_level),
    )
  ) {
    throw new Error("reviewer returned an invalid risk level");
  }
  if (
    !["unknown", "low", "medium", "high"].includes(
      String(record.user_authorization),
    )
  ) {
    throw new Error("reviewer returned invalid user authorization");
  }
  if (
    typeof record.rationale !== "string" ||
    !record.rationale.trim() ||
    record.rationale.length > 600
  ) {
    throw new Error("reviewer returned an invalid rationale");
  }

  const decision = {
    outcome: record.outcome,
    risk_level: record.risk_level,
    user_authorization: record.user_authorization,
    rationale: record.rationale.trim(),
  } as ModelDecision;
  if (
    decision.outcome === "allow" &&
    decision.risk_level === "critical"
  ) {
    throw new Error("reviewer attempted a critical-risk allow");
  }
  if (
    decision.outcome === "allow" &&
    decision.risk_level === "high" &&
    !["medium", "high"].includes(decision.user_authorization)
  ) {
    throw new Error(
      "reviewer attempted an unauthorized high-risk allow",
    );
  }
  if (
    decision.outcome === "defer" &&
    !["medium", "high"].includes(decision.risk_level)
  ) {
    throw new Error("reviewer returned an inconsistent defer");
  }
  return decision;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsedPreviewCommand(value: unknown): string | undefined {
  const preview = nonEmptyString(value);
  if (!preview) return undefined;
  try {
    const parsed = JSON.parse(preview.trim().replace(/^input\s+/, ""));
    return nonEmptyString(record(parsed)?.command);
  } catch {
    // A bounded/truncated preview is deliberately not guessed.
    return undefined;
  }
}

/** Normalize direct and forwarded permission-system evidence without trusting it. */
export function normalizePermissionEvidence(
  details: PermissionDetailsLike,
): NormalizedPermissionEvidence {
  const rawIntent = record(details.accessIntent);
  const intentSurface = nonEmptyString(rawIntent?.surface);
  const rawMatchValues = rawIntent?.matchValues;
  const matchValues =
    Array.isArray(rawMatchValues) &&
    rawMatchValues.every((item) => Boolean(nonEmptyString(item)))
      ? rawMatchValues as string[]
      : undefined;
  const accessIntent = intentSurface && matchValues
    ? {
        surface: intentSurface,
        matchValues: Object.freeze([...matchValues]),
        boundaryValue: nonEmptyString(rawIntent?.boundaryValue),
      }
    : undefined;
  const surface =
    accessIntent?.surface ??
    nonEmptyString(details.surface) ??
    (nonEmptyString(details.path) ? "path" : undefined) ??
    nonEmptyString(details.skillName) ??
    (nonEmptyString(details.command) ? "bash" : undefined) ??
    nonEmptyString(details.toolName) ??
    "unknown";
  const value = nonEmptyString(details.value);
  const isBash = surface === "bash" || surface === "bash_escalated";
  const isPath = isPathSurface(surface);
  const command =
    nonEmptyString(details.command) ??
    parsedPreviewCommand(details.toolInputPreview) ??
    (isBash ? value : undefined) ??
    (isBash && accessIntent?.matchValues.length === 1
      ? accessIntent.matchValues[0]
      : undefined);
  const path = nonEmptyString(details.path) ?? (isPath ? value : undefined);
  const destination =
    nonEmptyString(details.target) ?? (!isBash && !isPath ? value : undefined);
  const forwarding = record(details.forwarding);
  const agentName =
    nonEmptyString(details.agentName) ??
    nonEmptyString(forwarding?.requesterAgentName);
  const sessionId = nonEmptyString(forwarding?.requesterSessionId);
  return {
    surface,
    value,
    command,
    path,
    resolvedPath: accessIntent?.boundaryValue,
    destination,
    accessIntent,
    requester:
      agentName || sessionId ? { agentName, sessionId } : undefined,
  };
}

export function effectiveCommand(details: PermissionDetailsLike): string | undefined {
  return normalizePermissionEvidence(details).command;
}

export type HardDeny = {
  rule: string;
  reason: string;
};

/**
 * Keep this list narrow: these checks are terminal and cannot be overridden by
 * the model or the user prompt. Ambiguous or merely high-risk actions belong in
 * the detailed reviewer, which can defer to the human.
 */
export function deterministicHardDeny(
  details: PermissionDetailsLike,
): HardDeny | undefined {
  const command = effectiveCommand(details)?.trim();
  if (!command) return undefined;

  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const isRm = /(?:^|\s)(?:\/[^\s/]+)*\/?rm(?:\s|$)/i.test(segment);
    const recursive =
      /(?:^|\s)--recursive(?:\s|$)/i.test(segment) ||
      /(?:^|\s)-[A-Za-z]*r[A-Za-z]*(?:\s|$)/i.test(segment);
    const forced =
      /(?:^|\s)--force(?:\s|$)/i.test(segment) ||
      /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/i.test(segment);
    const rootOrHomeTarget =
      /(?:^|\s)["']?(?:\/(?:\*)?|~(?:\/(?:\*)?)?|\$HOME(?:\/(?:\*)?)?|\$\{HOME\}(?:\/(?:\*)?)?)["']?(?=\s|$)/i.test(
        segment,
      );
    if (isRm && recursive && forced && rootOrHomeTarget) {
      return {
        rule: "destructive-root-or-home-delete",
        reason:
          "recursive forced deletion of root or the home directory is forbidden",
      };
    }
  }

  if (
    /\bcurl\b[^;\n]*(?:--insecure\b|-[A-Za-z]*k[A-Za-z]*(?:\s|$))/i.test(
      command,
    ) ||
    /\bwget\b[^;\n]*--no-check-certificate\b/i.test(command) ||
    /\bgit\s+config\b[^;\n]*http\.sslverify\s+false\b/i.test(command) ||
    /\bnpm\s+config\s+set\s+strict-ssl\s+false\b/i.test(command) ||
    /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b/i.test(command)
  ) {
    return {
      rule: "transport-security-weakening",
      reason: "disabling TLS or certificate verification is forbidden",
    };
  }

  // Secret path text is only evidence when it occurs as the operand of an
  // operation that reads a file. In particular, a slash-delimited `.env` in
  // a URL or literal request payload is not itself a credential source.
  const envFileName =
    String.raw`\.env(?:\.(?!example\b|sample\b)[A-Za-z0-9_-]*)*`;
  const envFile =
    envFileName + String.raw`(?=[\s"'/@<>=|;&)\`]|$)`;
  const envPath =
    String.raw`(?:[^\s"'@<>=|;&()]+\/)*` + envFile;
  const credentialDirectoryPath =
    String.raw`(?:~\/|\$HOME\/|\$\{HOME\}\/|\/|\.\.?\/)?` +
    String.raw`(?:[^\s"'@<>=|;&()\/]+\/)*` +
    String.raw`(?:\.ssh\/(?:id_[A-Za-z0-9_-]+|authorized_keys)|\.aws\/credentials|\.kube\/config|\.docker\/config\.json|\.npmrc|\.netrc|\.pi\/agent\/auth\.json)`;
  const credentialPath =
    String.raw`(?:` +
    credentialDirectoryPath +
    String.raw`|` + envPath + String.raw`)`;
  const directCredentialUpload = new RegExp(
    String.raw`\b(?:curl|wget)\b[^;\n]*(?:` +
      String.raw`(?:--data(?:-binary|-urlencode)?|-d|--form|-F)(?:=|\s+)[^;\n\s]*@\s*["']?` + credentialPath +
      String.raw`|(?:--upload-file|--post-file)(?:=|\s+)["']?` + credentialPath +
      String.raw`|-T(?:\s*|=)["']?` + credentialPath +
      String.raw`)["']?`,
    "i",
  );
  const redirectedCredentialUpload = new RegExp(
    String.raw`\b(?:` +
      String.raw`(?:curl|wget)\b[^;\n]*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|-T|--post-file|--post-data)[^;\n]*` +
      String.raw`|(?:nc|ncat|socat)\b[^;\n]*` +
      String.raw`)<\s*["']?` +
      credentialPath,
    "i",
  );
  // The pipe matcher covers any content-emitting reader that names a secret
  // file (a bare filename such as `head .env`, `dd if=.env`, or a path like
  // ~/.aws/credentials) and feeds a network sink. The producer set is
  // enumerated rather than derived from directCredentialUpload because a bare
  // filename argument carries no path/@/redirect evidence; keeping the list
  // broad is fail-closed and cheap, since a match also requires a secret-file
  // token before the pipe and a network sink after it. This is best-effort
  // hardening, not a completeness guarantee: readers not on the list still
  // fall through to the contextual matchers below or the dynamic reviewer.
  // The leading lookbehind keeps the producers from
  // matching mid-word (star, code) so the terms stay real tool tokens.
  const credentialPipe = new RegExp(
    String.raw`(?<![A-Za-z0-9_])(?:cat|sed|awk|base64|openssl|head|tail|grep|dd|sort|cut|strings|rev|uniq|fold|od|xxd|hexdump|base32|uuencode|gzip|bzip2|xz|zstd|tar|zip)\b[^|;\n]*(?:\.ssh|\.aws|\.kube|\.docker|\.npmrc|\.netrc|` +
      String.raw`(?:^|[\s"'=/@])` +
      envFile +
      String.raw`|auth\.json)[^|;\n]*\|[^;\n]*\b(?:curl|wget|nc|ncat|socat)\b`,
    "i",
  );
  const credentialReader =
    String.raw`(?<![A-Za-z0-9_])(?:cat|sed|awk|base64|openssl|head|tail|grep|dd|sort|cut|strings|rev|uniq|fold|od|xxd|hexdump|base32|uuencode|gzip|bzip2|xz|zstd|tar|zip)\b[^|;\n]*` +
    credentialPath;
  const credentialShellExpansion =
    String.raw`(?:\$\([^)]*` +
    credentialReader +
    String.raw`[^)]*\)|<\([^)]*` +
    credentialReader +
    String.raw`[^)]*\)|\`[^\`\n]*` +
    credentialReader +
    String.raw`[^\`\n]*\`)`;
  const credentialExpansionUpload = new RegExp(
    String.raw`\b(?:curl|wget)\b[^;\n]*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|-T|--post-file|--post-data)[^;\n]*` +
      credentialShellExpansion,
    "i",
  );
  const redirectedCredentialExpansion = new RegExp(
    String.raw`\b(?:nc|ncat|socat)\b[^;\n]*(?:<<<|<)\s*` +
      credentialShellExpansion,
    "i",
  );
  const stagedCredentialVariableRead = new RegExp(
    String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*` +
      credentialShellExpansion,
    "gi",
  );
  let stagedCredentialVariableUpload = false;
  for (const match of command.matchAll(stagedCredentialVariableRead)) {
    const variable = match[1];
    if (!variable) continue;
    const suffix = command.slice((match.index ?? 0) + match[0].length);
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const variableUpload = new RegExp(
      String.raw`(?:\b(?:curl|wget)\b[^;\n]*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|-T|--post-file|--post-data)[^;\n]*|\b(?:nc|ncat|socat)\b[^;\n]*<<<\s*["']?)` +
        String.raw`(?:\$\{` +
        escapedVariable +
        String.raw`\}|\$` +
        escapedVariable +
        String.raw`(?![A-Za-z0-9_]))`,
      "i",
    );
    if (variableUpload.test(suffix)) {
      stagedCredentialVariableUpload = true;
      break;
    }
  }
  const credentialSubstitution = new RegExp(
    String.raw`\b(?:nc|ncat|socat)\b[^;\n]*\$\([^)]*` +
      credentialReader +
      String.raw`[^)]*\)`,
    "i",
  );
  const stagedCredentialRead = new RegExp(
    credentialReader + String.raw`[^|;\n]*>\s*["']?([^\s"';&|]+)["']?`,
    "gi",
  );
  let stagedCredentialUpload = false;
  for (const match of command.matchAll(stagedCredentialRead)) {
    const target = match[1];
    if (!target) continue;
    const suffix = command.slice((match.index ?? 0) + match[0].length);
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const targetUpload = new RegExp(
      String.raw`\b(?:curl|wget)\b[^;\n]*(?:` +
        String.raw`(?:--data(?:-binary|-urlencode)?|-d|--form|-F)(?:=|\s+)[^;\n\s]*@\s*["']?` + escapedTarget +
        String.raw`|(?:--upload-file|--post-file)(?:=|\s+)["']?` + escapedTarget +
        String.raw`|-T(?:\s*|=)["']?` + escapedTarget +
        String.raw`)(?=[\s"']|$)`,
      "i",
    );
    if (targetUpload.test(suffix)) {
      stagedCredentialUpload = true;
      break;
    }
  }
  if (
    directCredentialUpload.test(command) ||
    redirectedCredentialUpload.test(command) ||
    credentialPipe.test(command) ||
    credentialExpansionUpload.test(command) ||
    redirectedCredentialExpansion.test(command) ||
    credentialSubstitution.test(command) ||
    stagedCredentialVariableUpload ||
    stagedCredentialUpload
  ) {
    return {
      rule: "credential-exfiltration",
      reason:
        "sending credentials or secret configuration to a network sink is forbidden",
    };
  }

  const authorizationPath =
    String.raw`(?:authorized_keys|/etc/sudoers|/etc/sudoers\.d/)`;
  const redirectedAuthorizationWrite = new RegExp(
    String.raw`\b(?:printf|echo|cat)\b[^;\n]*(?:>>?|\|\s*tee\b)[^;\n]*${authorizationPath}`,
    "i",
  );
  const directAuthorizationWrite = new RegExp(
    String.raw`\b(?:tee|cp|mv|install)\b[^;\n]*${authorizationPath}`,
    "i",
  );
  if (
    redirectedAuthorizationWrite.test(command) ||
    directAuthorizationWrite.test(command)
  ) {
    return {
      rule: "access-persistence",
      reason: "adding SSH or sudo authorization persistence is forbidden",
    };
  }

  return undefined;
}

function boundedString(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = "[unserializable]";
    }
  }
  if (rendered.length <= MAX_EVIDENCE_ITEM_CHARACTERS) return rendered;
  const half = Math.floor((MAX_EVIDENCE_ITEM_CHARACTERS - 32) / 2);
  return `${rendered.slice(0, half)}\n…[middle truncated]…\n${rendered.slice(-half)}`;
}

function userText(message: Record<string, unknown>): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part),
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

function toolTexts(
  message: Record<string, unknown>,
): Array<{ id?: string; name: string; text: string }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    if (record.type !== "toolCall" || typeof record.name !== "string") {
      return [];
    }
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.toolCallId === "string"
          ? record.toolCallId
          : undefined;
    return [{
      id,
      name: record.name,
      text: `${record.name} ${boundedString(record.arguments ?? {})}`,
    }];
  });
}

function extractEvidence(entries: readonly unknown[]): Evidence[] {
  const evidence: Evidence[] = [];
  entries.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return;
    }
    const record = message as Record<string, unknown>;
    const user = userText(record);
    if (user) {
      evidence.push({
        id: `${stableEntryId(entry, entryIndex)}:user`,
        index: evidence.length,
        entryIndex,
        kind: "user",
        text: boundedString(user),
        reason: "latest-user",
        secondaryReasons: [],
        sensitivity: "user-intent",
        originalCharacters: user.length,
        preTruncated: boundedString(user).length < user.length,
      });
    }
    for (const tool of toolTexts(record)) {
      evidence.push({
        id: tool.id
          ? `tool-call:${tool.id}`
          : `${stableEntryId(entry, entryIndex)}:tool-${evidence.length}`,
        index: evidence.length,
        entryIndex,
        kind: "tool",
        text: tool.text,
        toolCallId: tool.id,
        reason: "structured-request-match",
        secondaryReasons: [],
        sensitivity: "tool-input",
        originalCharacters: tool.text.length,
        preTruncated: false,
      });
    }
  });
  return evidence;
}

type ToolCallRecord = {
  id?: string;
  name: string;
  arguments: unknown;
  rendered: string;
  entryIndex: number;
  candidateId: string;
};

function messageRecord(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  const message = (entry as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  return message as Record<string, unknown>;
}

function stableEntryId(entry: unknown, index: number): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return `entry:${id}`;
  }
  return `entry-index:${index}`;
}

function redactSensitiveResult(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(authorization\s*:\s*(?:bearer|basic)|bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /(["'])([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))\1\s*:\s*(["'])[^"'\r\n]*\3/g,
      '$1$2$1:$3[REDACTED]$3',
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))\s*[:=]\s*([^\s]+)/g,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]");
}

function escapeEvidenceMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resultText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  const text = message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n")
    .trim();
  return boundedString(redactSensitiveResult(text));
}

function commandArgument(call: ToolCallRecord): string {
  if (
    call.arguments &&
    typeof call.arguments === "object" &&
    !Array.isArray(call.arguments) &&
    typeof (call.arguments as Record<string, unknown>).command === "string"
  ) {
    return String((call.arguments as Record<string, unknown>).command);
  }
  return "";
}

type ProviderBranchQuery = {
  provider: "github" | "gitlab";
  branch: string;
};

function normalizedBranch(value: string): string | undefined {
  let branch = value.replace(/^refs\/heads\//, "");
  try {
    branch = decodeURIComponent(branch);
  } catch {
    return undefined;
  }
  return branch && !/[\s;&|`$<>]/.test(branch) ? branch : undefined;
}

function explicitPushBranch(command: string): string | undefined {
  if (/[\n;&|`<>]|\$\(/.test(command)) return;
  const words = command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  const git = words.findIndex((word) => /(?:^|\/)git$/.test(word));
  if (git < 0 || words[git + 1] !== "push") return;
  const positional = words
    .slice(git + 2)
    .filter((word) => word && !word.startsWith("-"));
  // A single explicit refspec keeps the provider evidence bound to the whole
  // push. Multi-ref pushes deliberately receive only the generic Git context.
  if (positional.length !== 2) return;
  const refspec = positional[positional.length - 1];
  if (!refspec) return;
  const destination = refspec.includes(":")
    ? refspec.slice(refspec.lastIndexOf(":") + 1)
    : refspec;
  return normalizedBranch(destination);
}

function providerBranchQuery(command: string): ProviderBranchQuery | undefined {
  if (/[\n;&|`<>]|\$\(/.test(command)) return;
  const github = command
    .trim()
    .match(
      /^gh\s+api\s+["']?\/?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/branches\/([^\/\s"']+)(?:\/protection)?["']?$/,
    );
  if (github) {
    const branch = normalizedBranch(github[1] ?? "");
    return branch ? { provider: "github", branch } : undefined;
  }
  const gitlab = command
    .trim()
    .match(
      /^glab\s+api\s+["']?\/?projects\/[A-Za-z0-9_.%/-]+\/protected_branches\/([^\/\s"']+)["']?$/,
    );
  if (gitlab) {
    const branch = normalizedBranch(gitlab[1] ?? "");
    return branch ? { provider: "gitlab", branch } : undefined;
  }
  return undefined;
}

function relevanceReason(
  call: ToolCallRecord,
  request: RelevantBoundaryRequest,
):
  | "same-tool"
  | "delete-precheck"
  | "git-push-context"
  | "provider-branch-protection"
  | undefined {
  if (request.toolCallId && call.id === request.toolCallId) return "same-tool";
  const currentCommand = request.command || "";
  const priorCommand = commandArgument(call);
  const pushedBranch = explicitPushBranch(currentCommand);
  const providerQuery = providerBranchQuery(priorCommand);
  const destructive =
    /\b(?:rm|rmdir|unlink|trash|delete)\b/i.test(currentCommand);
  const readOnlyCheck =
    /^\s*(?:stat|ls|find|test|readlink|realpath)\b/i.test(priorCommand);
  const priorWords = /[\n;&|`<>]|\$\(/.test(priorCommand)
    ? []
    : priorCommand
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  const targets = [request.path, request.resolvedPath].filter(
    (value): value is string => Boolean(value),
  );
  if (
    destructive &&
    readOnlyCheck &&
    targets.some((target) => priorWords.includes(target))
  ) {
    return "delete-precheck";
  }
  if (
    /\bgit\b[\s\S]*\bpush\b/i.test(currentCommand) &&
    /^\s*git\s+(?:remote|branch|status|rev-parse|config\s+--get\s+remote)/i.test(
      priorCommand,
    )
  ) {
    return "git-push-context";
  }
  if (
    pushedBranch &&
    providerQuery &&
    providerQuery.branch === pushedBranch
  ) {
    return "provider-branch-protection";
  }
  return undefined;
}

function relevantResultEvidence(
  entries: readonly unknown[],
  request: RelevantBoundaryRequest,
  currentTurnStart: number,
): Array<{
  index: number;
  reason: Exclude<
    EvidenceSelectionReason,
    | "latest-user"
    | "exact-request-reference"
    | "trusted-retry-user-message"
    | "exact-tool-call"
    | "structured-request-match"
    | "security-combination"
    | "sandbox-trap"
  >;
  call: ToolCallRecord;
  resultId: string;
  resultText: string;
  renderedResult: string;
}> {
  const calls = new Map<string, ToolCallRecord>();
  const results: Array<{
    index: number;
    reason: "same-tool" | "delete-precheck" | "git-push-context" | "provider-branch-protection";
    call: ToolCallRecord;
    resultId: string;
    resultText: string;
    renderedResult: string;
  }> = [];
  entries.forEach((entry, index) => {
    const message = messageRecord(entry);
    if (!message) return;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "toolCall" || typeof record.name !== "string") continue;
        const id =
          typeof record.id === "string"
            ? record.id
            : typeof record.toolCallId === "string"
              ? record.toolCallId
              : undefined;
        if (!id) continue;
        calls.set(id, {
          id,
          name: record.name,
          arguments: record.arguments,
          rendered: `${record.name} ${boundedString(record.arguments ?? {})}`,
          entryIndex: index,
          candidateId: `tool-call:${id}`,
        });
      }
      return;
    }
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    ) {
      return;
    }
    const call = calls.get(message.toolCallId);
    if (!call) return;
    const reason = relevanceReason(call, request);
    const text = resultText(message);
    const crossTurnAllowed = reason === "same-tool";
    if (reason && text && (crossTurnAllowed || call.entryIndex >= currentTurnStart)) {
      results.push({
        index,
        reason,
        call,
        resultId: `${stableEntryId(entry, index)}:tool-result:${message.toolCallId}`,
        resultText: text,
        renderedResult: `<tool-result id="${escapeEvidenceMarkup(message.toolCallId)}" reason="${reason}" tool="${escapeEvidenceMarkup(call.name)}">\n${escapeEvidenceMarkup(text)}\n</tool-result>`,
      });
    }
  });
  return results;
}

function sandboxTrapSupplement(
  request: RelevantBoundaryRequest,
): string | undefined {
  if (request.source !== "sandbox-runtime") return;
  const supplement = {
    ...(request.toolName ? { process: request.toolName } : {}),
  };
  if (Object.keys(supplement).length === 0) return;
  return canonicalReviewerJson(supplement);
}

function sandboxTrapEvidence(
  request: RelevantBoundaryRequest,
): string | undefined {
  const supplement = sandboxTrapSupplement(request);
  if (!supplement) return;
  return `<sandbox-trap>
${supplement}
</sandbox-trap>`;
}

function currentTurnStart(entries: readonly unknown[]): number {
  let start = 0;
  entries.forEach((entry, index) => {
    if (messageRecord(entry)?.role === "user") start = index;
  });
  return start;
}

function surfaceProfile(
  request: RelevantBoundaryRequest,
): EvidenceSurfaceProfile {
  if (request.agentName || request.requesterSessionId) return "forwarded";
  if (request.surface === "network" || request.destination) return "network";
  if (/\bgit\b[\s\S]*\bpush\b/i.test(request.command ?? "")) return "git-push";
  if (/\b(?:rm|rmdir|unlink|trash|delete)\b/i.test(request.command ?? "")) {
    return "delete";
  }
  return "generic";
}

function collectToolCalls(entries: readonly unknown[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  entries.forEach((entry, entryIndex) => {
    const message = messageRecord(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const value = part as Record<string, unknown>;
      if (value.type !== "toolCall" || typeof value.name !== "string") continue;
      const id =
        typeof value.id === "string"
          ? value.id
          : typeof value.toolCallId === "string"
            ? value.toolCallId
            : undefined;
      calls.push({
        id,
        name: value.name,
        arguments: value.arguments,
        rendered: `${value.name} ${boundedString(value.arguments ?? {})}`,
        entryIndex,
        candidateId: id
          ? `tool-call:${id}`
          : `${stableEntryId(entry, entryIndex)}:tool-${calls.length}`,
      });
    }
  });
  return calls;
}

function exactStructuredMatch(
  call: ToolCallRecord,
  request: RelevantBoundaryRequest,
): boolean {
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
    return false;
  }
  const args = call.arguments as Record<string, unknown>;
  const pairs: Array<[unknown, unknown]> = [
    [args.command, request.command],
    [args.path, request.path],
    [args.resolvedPath, request.resolvedPath],
    [args.destination, request.destination],
    [args.agentName, request.agentName],
    [args.requesterSessionId, request.requesterSessionId],
    [args.target, request.destination ?? request.path],
    [args.value, request.destination ?? request.path ?? request.command],
  ];
  if (pairs.some(
    ([actual, expected]) =>
      typeof actual === "string" &&
      typeof expected === "string" &&
      actual === expected,
  )) return true;
  const forwarding =
    args.forwarding && typeof args.forwarding === "object" && !Array.isArray(args.forwarding)
      ? args.forwarding as Record<string, unknown>
      : undefined;
  if (
    forwarding &&
    ((typeof forwarding.requesterAgentName === "string" &&
      forwarding.requesterAgentName === request.agentName) ||
      (typeof forwarding.requesterSessionId === "string" &&
        forwarding.requesterSessionId === request.requesterSessionId))
  ) return true;
  const intent =
    args.accessIntent && typeof args.accessIntent === "object" && !Array.isArray(args.accessIntent)
      ? args.accessIntent as Record<string, unknown>
      : undefined;
  return Boolean(
    intent &&
    request.accessIntent &&
    intent.surface === request.accessIntent.surface &&
    Array.isArray(intent.matchValues) &&
    intent.matchValues.length === request.accessIntent.matchValues.length &&
    intent.matchValues.every(
      (value, index) => value === request.accessIntent!.matchValues[index],
    ) &&
    intent.boundaryValue === request.accessIntent.boundaryValue,
  );
}

function sameReviewerField(actual: unknown, expected: unknown): boolean {
  return expected !== undefined &&
    canonicalReviewerJson(actual) === canonicalReviewerJson(expected);
}

function toolArgumentCoveredByRequest(
  key: string,
  actual: unknown,
  request: RelevantBoundaryRequest,
): boolean {
  if (key === "target") {
    return sameReviewerField(actual, request.destination ?? request.path);
  }
  if (key === "value") {
    return [request.command, request.path, request.destination].some(
      (expected) => sameReviewerField(actual, expected),
    );
  }
  if (key === "forwarding") {
    if (!request.agentName && !request.requesterSessionId) return false;
    return sameReviewerField(actual, {
      requesterAgentName: request.agentName,
      requesterSessionId: request.requesterSessionId,
    });
  }
  const expected = ({
    command: request.command,
    path: request.path,
    resolvedPath: request.resolvedPath,
    destination: request.destination,
    destinationHost: request.destinationHost,
    destinationPort: request.destinationPort,
    destinationProtocol: request.destinationProtocol,
    cwd: request.cwd,
    agentName: request.agentName,
    requesterSessionId: request.requesterSessionId,
    accessIntent: request.accessIntent,
  } as Record<string, unknown>)[key];
  return sameReviewerField(actual, expected);
}

function exactToolCallReviewerRepresentation(
  call: ToolCallRecord,
  request: RelevantBoundaryRequest,
  reason: EvidenceSelectionReason,
): string | undefined {
  if (
    !call.id ||
    call.id !== request.toolCallId ||
    !call.arguments ||
    typeof call.arguments !== "object" ||
    Array.isArray(call.arguments)
  ) {
    return;
  }
  const args = call.arguments as Record<string, unknown>;
  const serializedArgs = canonicalReviewerJson(args);
  const previewCoversAll =
    request.toolInputPreview === serializedArgs ||
    request.toolInputPreview === `input ${serializedArgs}`;
  const supplement = previewCoversAll
    ? {}
    : Object.fromEntries(
        Object.entries(args).filter(
          ([key, actual]) =>
            !toolArgumentCoveredByRequest(key, actual, request),
        ),
      );
  return canonicalReviewerJson({
    id: call.id,
    name: call.name,
    reason,
    ...(Object.keys(supplement).length > 0 ? { supplement } : {}),
  });
}

function securityEvidenceCategory(
  call: ToolCallRecord,
):
  | "credential"
  | "permission"
  | "authorization"
  | "transport"
  | "audit"
  | "security-control"
  | undefined {
  const command = commandArgument(call);
  if (!command) return;
  if (
    /\b(?:cat|sed|awk|base64|openssl|head|tail|grep|dd|xxd|tar|zip)\b[\s\S]*(?:\.env|\.ssh|\.aws\/credentials|\.kube\/config|\.npmrc|auth\.json)/i.test(
      command,
    )
  ) return "credential";
  if (/\b(?:chmod|chown|chgrp|setfacl)\b/i.test(command)) return "permission";
  if (/(?:authorized_keys|\/etc\/sudoers|access[_-]?grant)/i.test(command)) {
    return "authorization";
  }
  if (
    /(?:--insecure|--no-check-certificate|sslverify\s+false|strict-ssl\s+false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|https?_proxy)/i.test(
      command,
    )
  ) return "transport";
  if (/\b(?:disable|truncate|delete|rm)\b[\s\S]*\b(?:audit|log)/i.test(command)) {
    return "audit";
  }
  if (/(?:pi-auto-review|pi-sandbox|permission-system|permissions\.json|sandbox\.json)/i.test(command)) {
    return "security-control";
  }
  return undefined;
}

function selectRequestAwareTools(
  entries: readonly unknown[],
  evidence: Evidence[],
  request: RelevantBoundaryRequest,
  relevant: ReturnType<typeof relevantResultEvidence>,
  turnStart: number,
): { selected: Evidence[]; criticalEvidenceOverflow: boolean } {
  const calls = collectToolCalls(entries);
  const reasons = new Map<string, EvidenceSelectionReason[]>();
  const addReason = (call: ToolCallRecord, reason: EvidenceSelectionReason) => {
    const current = reasons.get(call.candidateId) ?? [];
    if (!current.includes(reason)) current.push(reason);
    reasons.set(call.candidateId, current);
  };

  const exact = request.toolCallId
    ? calls.find((call) => call.id === request.toolCallId)
    : undefined;
  if (exact) addReason(exact, "exact-tool-call");
  for (const unit of relevant) addReason(unit.call, unit.reason);
  for (const call of calls) {
    if (call.entryIndex < turnStart || call === exact) continue;
    if (exactStructuredMatch(call, request)) {
      addReason(call, "structured-request-match");
    }
  }
  const profile = surfaceProfile(request);
  const securityCalls = calls.filter(
    (call) =>
      call.entryIndex >= turnStart &&
      securityEvidenceCategory(call) !== undefined &&
      ["network", "git-push", "forwarded"].includes(profile),
  );
  for (const call of securityCalls.slice(-4)) {
    addReason(call, "security-combination");
  }

  const priority: EvidenceSelectionReason[] = [
    "exact-tool-call",
    "same-tool",
    "delete-precheck",
    "git-push-context",
    "provider-branch-protection",
    "security-combination",
    "structured-request-match",
  ];
  const selected = evidence
    .filter((item) => item.kind === "tool" && reasons.has(item.id))
    .map((item) => {
      const matched = reasons.get(item.id)!;
      const ordered = [...matched].sort(
        (left, right) => priority.indexOf(left) - priority.indexOf(right),
      );
      const call = calls.find((candidate) => candidate.candidateId === item.id)!;
      // Invariant: reasons entries are only created via addReason, which
      // always pushes at least one reason, and this item passed the
      // reasons.has(item.id) filter above — so ordered[0] is defined.
      const primaryReason = ordered[0]!;
      const linkage = exactToolCallReviewerRepresentation(
        call,
        request,
        primaryReason,
      );
      return {
        ...item,
        ...(linkage
          ? { text: linkage, representationCharacters: linkage.length }
          : {}),
        reason: primaryReason,
        secondaryReasons: ordered.slice(1),
        sensitivity:
          ordered.includes("security-combination")
            ? ({
                credential: "credential",
                permission: "permission-control",
                authorization: "authorization-persistence",
                transport: "transport-weakening",
                audit: "audit-control",
                "security-control": "security-control",
              } as const)[
                securityEvidenceCategory(
                  calls.find((call) => call.candidateId === item.id)!,
                )!
              ]
            : item.sensitivity,
      };
    });
  return {
    selected,
    criticalEvidenceOverflow: securityCalls.length > 4,
  };
}

function capRelevantUnits(
  units: ReturnType<typeof relevantResultEvidence>,
  profile: EvidenceSurfaceProfile,
): ReturnType<typeof relevantResultEvidence> {
  const newest = [...units].sort((left, right) => right.index - left.index);
  const selected: typeof units = [];
  const take = (
    reason: (typeof units)[number]["reason"],
    limit: number,
    predicate: (unit: (typeof units)[number]) => boolean = () => true,
  ) => {
    for (const unit of newest) {
      if (
        selected.length >= units.length ||
        selected.includes(unit) ||
        unit.reason !== reason ||
        !predicate(unit) ||
        selected.filter(
          (candidate) => candidate.reason === reason && predicate(candidate),
        ).length >= limit
      ) {
        continue;
      }
      selected.push(unit);
    }
  };
  take("same-tool", 1);
  if (profile === "delete") take("delete-precheck", 2);
  if (profile === "git-push") {
    take("git-push-context", 1, (unit) =>
      /^\s*git\s+(?:remote|config\s+--get\s+remote)/i.test(
        commandArgument(unit.call),
      ),
    );
    take("git-push-context", 1, (unit) =>
      /^\s*git\s+(?:branch|status|rev-parse)/i.test(
        commandArgument(unit.call),
      ),
    );
    take("provider-branch-protection", 1);
  }
  if (profile === "generic") {
    for (const unit of newest) {
      if (!selected.includes(unit) && selected.length < 4) selected.push(unit);
    }
  }
  return selected.sort((left, right) => left.index - right.index);
}

function selectedMetadata(
  item: Evidence,
  original: Evidence,
  profile: EvidenceSurfaceProfile,
): EvidenceCandidateMetadata {
  return {
    id: item.id,
    entryIndex: item.entryIndex,
    kind: item.kind === "user" ? "user" : "tool-call",
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    reason: item.reason,
    secondaryReasons: [...item.secondaryReasons],
    surfaceProfile: profile,
    originalCharacters: original.originalCharacters,
    selectedCharacters: item.text.length,
    estimatedTokens: Buffer.byteLength(item.text, "utf8"),
    truncated:
      original.preTruncated ||
      item.text.length <
        (item.representationCharacters ?? original.originalCharacters),
    sensitivity: item.sensitivity,
  };
}

type UserSelection = {
  selected: Evidence[];
  truncated: boolean;
  authorizationCeiling: TranscriptResult["userAuthorizationCeiling"];
  constraint: TranscriptResult["userConstraint"];
  compactionState: TranscriptResult["compactionState"];
};

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  const characters = [...value];
  let result = "";
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    if (!character) continue;
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result = character + result;
    bytes += size;
  }
  return result;
}

function headTail(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const marker = "\n…[middle truncated]…\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limit <= markerBytes) return utf8Prefix(marker, limit);
  const available = limit - markerBytes;
  const head = Math.ceil(available / 2);
  return `${utf8Prefix(value, head)}${marker}${utf8Suffix(value, available - head)}`;
}

function summaryEntryIndices(entries: readonly unknown[]): number[] {
  const indices: number[] = [];
  entries.forEach((entry, index) => {
    const role = messageRecord(entry)?.role;
    if (role === "compactionSummary" || role === "branchSummary") {
      indices.push(index);
    }
  });
  return indices;
}

function containsExactIdentifier(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`).test(
    text,
  );
}

function exactUserReference(
  text: string,
  request: RelevantBoundaryRequest,
): boolean {
  return [
    request.id,
    request.toolCallId,
    request.requesterSessionId,
    request.agentName,
  ].some((value) => {
    if (typeof value !== "string" || value.length === 0) return false;
    return containsExactIdentifier(text, value);
  });
}


function selectUserEvidence(
  entries: readonly unknown[],
  evidence: Evidence[],
  request: RelevantBoundaryRequest,
  budgetTokens: number,
): UserSelection {
  const users = evidence.filter((item) => item.kind === "user");
  const summaries = summaryEntryIndices(entries);
  const lastSummary = summaries.at(-1) ?? -1;
  const rawAfterSummary = users.filter((item) => item.entryIndex > lastSummary);
  const eligibleUsers = lastSummary >= 0 ? rawAfterSummary : users;
  const latest = eligibleUsers.at(-1);
  const compactionState: TranscriptResult["compactionState"] =
    summaries.length === 0
      ? "none"
      : latest
        ? "summary-present"
        : "authorization-unavailable";
  if (!latest || budgetTokens <= 0) {
    return {
      selected: [],
      truncated: users.length > 0,
      authorizationCeiling: request.trustedRetryOriginalRequestId
        ? "high"
        : "unknown",
      constraint: "none",
      compactionState,
    };
  }

  let remaining = budgetTokens;
  const latestText = headTail(latest.text, remaining);
  const latestTrustedRetry = Boolean(
    request.trustedRetryOriginalRequestId &&
      latest.text.includes("I approved one reviewer retry") &&
      containsExactIdentifier(
        latest.text,
        request.trustedRetryOriginalRequestId,
      ),
  );
  const latestExactReference = exactUserReference(latest.text, request);
  const selected: Evidence[] = [{
    ...latest,
    text: latestText,
    reason: "latest-user",
    secondaryReasons: [
      ...(latestTrustedRetry ? ["trusted-retry-user-message" as const] : []),
      ...(latestExactReference ? ["exact-request-reference" as const] : []),
    ],
  }];
  remaining -= Buffer.byteLength(latestText, "utf8");

  const older = eligibleUsers.slice(0, -1).reverse();
  for (const candidate of older) {
    if (remaining <= 0) break;
    const trustedRetry = Boolean(
      request.trustedRetryOriginalRequestId &&
        candidate.text.includes("I approved one reviewer retry") &&
        containsExactIdentifier(
          candidate.text,
          request.trustedRetryOriginalRequestId,
        ),
    );
    const exactReference = exactUserReference(candidate.text, request);
    if (!trustedRetry && !exactReference) continue;
    const reason: EvidenceSelectionReason = trustedRetry
      ? "trusted-retry-user-message"
      : "exact-request-reference";
    const text = headTail(candidate.text, remaining);
    if (!text) continue;
    selected.push({
      ...candidate,
      text,
      reason,
      secondaryReasons: [
        ...(trustedRetry && exactReference
          ? ["exact-request-reference" as const]
          : []),
      ],
    });
    remaining -= Buffer.byteLength(text, "utf8");
  }
  selected.sort((left, right) => left.entryIndex - right.entryIndex);
  const latestTruncated =
    latestText.length < latest.originalCharacters || latest.preTruncated;
  return {
    selected,
    truncated:
      latestTruncated ||
      selected.some((item) => item.text.length < item.originalCharacters),
    authorizationCeiling: "high",
    constraint: "none",
    compactionState,
  };
}

function selectEvidence(
  evidence: Evidence[],
  kind: Evidence["kind"],
  budgetTokens: number,
): { selected: Evidence[]; truncated: boolean } {
  const candidates = evidence.filter((item) => item.kind === kind);
  if (candidates.length === 0 || budgetTokens <= 0) {
    return { selected: [], truncated: candidates.length > 0 };
  }

  const selected = new Map<number, Evidence>();
  let remaining = budgetTokens;
  const add = (item: Evidence, limit = remaining): void => {
    if (selected.has(item.index) || remaining <= 0) return;
    const text = utf8Prefix(item.text, Math.min(remaining, limit));
    if (!text) return;
    selected.set(item.index, { ...item, text });
    remaining -= Buffer.byteLength(text, "utf8");
  };

  // Keep the original user intent as an anchor, then fill from newest to oldest.
  if (kind === "user") {
    const firstBudget =
      candidates.length > 1
        ? Math.max(1, Math.floor(budgetTokens / 2))
        : budgetTokens;
    const first = candidates[0];
    if (first) add(first, firstBudget);
    const last = candidates[candidates.length - 1];
    if (candidates.length > 1 && last) add(last);
  }
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (candidate) add(candidate);
  }
  return {
    selected: [...selected.values()],
    truncated:
      selected.size < candidates.length ||
      [...selected.values()].some(
        (item) =>
          item.text.length <
          (candidates.find((candidate) => candidate.index === item.index)?.text
            .length || 0),
      ),
  };
}

export function buildClassifierTranscript(
  entries: readonly unknown[],
  config: TranscriptConfig,
  request: RelevantBoundaryRequest = {},
): TranscriptResult {
  const evidence = extractEvidence(entries);
  const profile = surfaceProfile(request);
  const turnStart = currentTurnStart(entries);
  const relevantUnits = capRelevantUnits(
    relevantResultEvidence(entries, request, turnStart),
    profile,
  );
  const users = selectUserEvidence(
    entries,
    evidence,
    request,
    config.maxUserTranscriptTokens,
  );
  const requestAwareTools = selectRequestAwareTools(
    entries,
    evidence,
    request,
    relevantUnits,
    turnStart,
  );
  const tools = selectEvidence(
    requestAwareTools.selected,
    "tool",
    config.maxToolTranscriptTokens,
  );
  const relevantBudget =
    config.maxRelevantResultTokens ?? config.maxToolTranscriptTokens;
  const sandboxSupplement = sandboxTrapSupplement(request);
  const sandboxEvidence = sandboxTrapEvidence(request);
  const relevantCandidates = [
    ...(sandboxEvidence && sandboxSupplement
      ? [{
          index: Number.MAX_SAFE_INTEGER - 1,
          id: `sandbox-trap:${request.id ?? "request"}`,
          reason: "sandbox-trap" as const,
          toolCallId: undefined,
          text: sandboxEvidence,
          content: sandboxSupplement,
          rawCharacters: sandboxEvidence.length,
          sensitivity: "boundary" as const,
        }]
      : []),
    ...relevantUnits
      .filter((unit) =>
        tools.selected.some((tool) => tool.id === unit.call.candidateId),
      )
      .map((unit) => ({
        index: unit.index,
        id: unit.resultId,
        reason: unit.reason,
        toolCallId: unit.call.id,
        text: unit.renderedResult,
        content: unit.resultText,
        rawCharacters: unit.renderedResult.length,
        sensitivity: "tool-output" as const,
      })),
  ];
  let relevantRemaining = relevantBudget;
  let requiredProfileOverflow = false;
  const relevantSelected: Array<
    (typeof relevantCandidates)[number] & { selectedText: string }
  > = [];
  const relevantSelectionOrder = [
    ...relevantCandidates.filter((candidate) => candidate.reason === "sandbox-trap"),
    ...relevantCandidates
      .filter((candidate) => candidate.reason !== "sandbox-trap")
      .sort((left, right) => right.index - left.index),
  ];
  for (const candidate of relevantSelectionOrder) {
    if (relevantRemaining <= 0) break;
    if (
      candidate.reason === "sandbox-trap" &&
      Buffer.byteLength(candidate.text, "utf8") > relevantRemaining
    ) {
      requiredProfileOverflow = true;
      break;
    }
    const text = utf8Prefix(candidate.text, relevantRemaining);
    if (text) {
      relevantSelected.push({ ...candidate, selectedText: text });
      relevantRemaining -= Buffer.byteLength(text, "utf8");
    }
  }
  relevantSelected.sort((left, right) => left.index - right.index);
  const pairedToolCallIds = new Set(
    relevantSelected
      .map((candidate) => candidate.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  const resultReasons = new Set<EvidenceSelectionReason>([
    "same-tool",
    "delete-precheck",
    "git-push-context",
    "provider-branch-protection",
  ]);
  const finalTools = tools.selected.filter((tool) => {
    if (!resultReasons.has(tool.reason)) return true;
    if (tool.toolCallId && pairedToolCallIds.has(tool.toolCallId)) return true;
    return tool.secondaryReasons.some((reason) => !resultReasons.has(reason));
  });
  const selected = [...users.selected, ...finalTools].sort(
    (left, right) => left.index - right.index,
  );
  const baseRendered = selected
    .map((item) => {
      const attributes = item.kind === "tool"
        ? ` id="${escapeEvidenceMarkup(item.toolCallId ?? item.id)}" reason="${item.reason}"`
        : ` reason="${item.reason}"`;
      return `<${item.kind}${attributes}>\n${escapeEvidenceMarkup(item.text)}\n</${item.kind}>`;
    })
    .join("\n\n");
  const authorizationNotice =
    users.compactionState === "authorization-unavailable"
      ? "[Original user authorization is unavailable after compaction. Agent-generated summaries are not authorization.]"
      : users.compactionState === "summary-present"
        ? "[A compaction/branch summary exists but is not user authorization.]"
        : "";
  const rendered = [
    authorizationNotice,
    baseRendered,
    ...relevantSelected.map((candidate) => candidate.selectedText),
  ]
    .filter(Boolean)
    .join("\n\n");
  const relevantTruncated =
    relevantSelected.length < relevantCandidates.length ||
    relevantSelected.reduce(
      (total, value) => total + value.selectedText.length,
      0,
    ) <
      relevantCandidates.reduce((total, value) => total + value.text.length, 0);
  const truncated =
    users.truncated ||
    tools.truncated ||
    finalTools.length < tools.selected.length ||
    relevantTruncated;
  const text = truncated
    ? `[Some transcript evidence was omitted or truncated.]\n\n${rendered}`
    : rendered;
  return {
    text: text || "(no eligible transcript evidence)",
    surfaceProfile: profile,
    reviewerEvidence: {
      userMessages: users.selected.map((item) => ({
        id: item.id,
        reason: item.reason,
        secondaryReasons: [...item.secondaryReasons],
        content: item.text,
      })),
      toolCalls: finalTools.map((item) => ({
        id: item.id,
        reason: item.reason,
        secondaryReasons: [...item.secondaryReasons],
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
        content: item.text,
      })),
      relevantResults: relevantSelected.map((item) => ({
        id: item.id,
        reason: item.reason,
        secondaryReasons: [],
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
        content: item.selectedText === item.text
          ? item.content
          : item.selectedText,
      })),
    },
    budgetRemovals: [],
    userCharacters: users.selected.reduce(
      (total, item) => total + item.text.length,
      0,
    ),
    toolCharacters: finalTools.reduce(
      (total, item) => total + item.text.length,
      0,
    ),
    relevantResultCharacters: relevantSelected.reduce(
      (total, item) =>
        total +
        (item.selectedText === item.text
          ? item.content.length
          : item.selectedText.length),
      0,
    ),
    truncated,
    selectedCandidates: [
      ...users.selected.map((item) =>
        selectedMetadata(
          item,
          evidence.find((candidate) => candidate.id === item.id)!,
          profile,
        ),
      ),
      ...finalTools.map((item) =>
        selectedMetadata(
          item,
          evidence.find((candidate) => candidate.id === item.id)!,
          profile,
        ),
      ),
      ...relevantSelected.map((item) => ({
        id: item.id,
        entryIndex: item.index,
        kind: item.sensitivity === "boundary" ? "sandbox-trap" as const : "tool-result" as const,
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
        reason: item.reason,
        secondaryReasons: [],
        surfaceProfile: profile,
        originalCharacters: item.rawCharacters,
        selectedCharacters: item.selectedText.length,
        estimatedTokens: Buffer.byteLength(item.selectedText, "utf8"),
        truncated: item.selectedText.length < item.rawCharacters,
        sensitivity: item.sensitivity,
      })),
    ].sort((left, right) => left.entryIndex - right.entryIndex),
    ...(requestAwareTools.criticalEvidenceOverflow
      ? { failureCode: "critical_evidence_overflow" as const }
      : requiredProfileOverflow
        ? { failureCode: "required_profile_overflow" as const }
        : {}),
    userAuthorizationCeiling: users.authorizationCeiling,
    userConstraint: users.constraint,
    compactionState: users.compactionState,
  };
}
