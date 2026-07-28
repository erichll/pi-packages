export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ModelDecision = {
  outcome: "allow" | "deny" | "defer";
  risk_level: RiskLevel;
  user_authorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
};

export type PermissionDetailsLike = {
  surface?: string | null;
  toolName?: string;
  command?: string;
  path?: string;
  target?: string;
  toolInputPreview?: string;
};

export type TranscriptConfig = {
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  maxRelevantResultTokens?: number;
};

export type TranscriptResult = {
  text: string;
  userCharacters: number;
  toolCharacters: number;
  relevantResultCharacters: number;
  truncated: boolean;
};

type Evidence = {
  index: number;
  kind: "user" | "tool";
  text: string;
};

export type RelevantBoundaryRequest = {
  id?: string;
  source?: string;
  surface?: string;
  operation?: string;
  command?: string;
  path?: string;
  resolvedPath?: string;
  destination?: string;
  toolCallId?: string;
  toolName?: string;
};

const MAX_EVIDENCE_ITEM_CHARACTERS = 4_000;

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

export function parseDecision(text: string): ModelDecision {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
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

function surfaceOf(details: PermissionDetailsLike): string {
  if (typeof details.surface === "string" && details.surface) {
    return details.surface;
  }
  if (details.path) return "path";
  if (details.command) return "bash";
  return details.toolName || "unknown";
}

export function effectiveCommand(
  details: PermissionDetailsLike,
): string | undefined {
  if (details.command?.trim()) return details.command;
  if (
    surfaceOf(details) !== "bash_escalated" ||
    !details.toolInputPreview?.trim()
  ) {
    return undefined;
  }
  const preview = details.toolInputPreview.trim().replace(/^input\s+/, "");
  try {
    const value = JSON.parse(preview) as unknown;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).command === "string"
    ) {
      return String((value as Record<string, unknown>).command);
    }
  } catch {
    // A bounded/truncated preview is deliberately not guessed.
  }
  return undefined;
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

  const credentialSource =
    /(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)(?:\.ssh\/(?:id_[A-Za-z0-9_-]+|authorized_keys)|\.aws\/credentials|\.kube\/config|\.docker\/config\.json|\.npmrc|\.netrc|\.pi\/agent\/auth\.json)|(?:^|[\/@\s])\.env(?:\s|$)/i;
  const networkUpload =
    /\b(?:curl\b[^;\n]*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|-T)|wget\b[^;\n]*(?:--post-file|--post-data)|(?:nc|ncat|socat)\b)/i;
  const credentialPipe =
    /(?:cat|sed|awk|base64|openssl)\b[^|;\n]*(?:\.ssh|\.aws|\.kube|\.docker|\.npmrc|\.netrc|\.env|auth\.json)[^|;\n]*\|[^;\n]*\b(?:curl|wget|nc|ncat|socat)\b/i;
  if (
    (credentialSource.test(command) && networkUpload.test(command)) ||
    credentialPipe.test(command)
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

function toolTexts(message: Record<string, unknown>): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    if (record.type !== "toolCall" || typeof record.name !== "string") {
      return [];
    }
    return [`${record.name} ${boundedString(record.arguments ?? {})}`];
  });
}

function extractEvidence(entries: readonly unknown[]): Evidence[] {
  const evidence: Evidence[] = [];
  entries.forEach((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return;
    }
    const record = message as Record<string, unknown>;
    const user = userText(record);
    if (user) {
      evidence.push({
        index: evidence.length,
        kind: "user",
        text: boundedString(user),
      });
    }
    for (const tool of toolTexts(record)) {
      evidence.push({ index: evidence.length, kind: "tool", text: tool });
    }
  });
  return evidence;
}

type ToolCallRecord = {
  id?: string;
  name: string;
  arguments: unknown;
  rendered: string;
};

function messageRecord(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  const message = (entry as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  return message as Record<string, unknown>;
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
    const branch = normalizedBranch(github[1]);
    return branch ? { provider: "github", branch } : undefined;
  }
  const gitlab = command
    .trim()
    .match(
      /^glab\s+api\s+["']?\/?projects\/[A-Za-z0-9_.%/-]+\/protected_branches\/([^\/\s"']+)["']?$/,
    );
  if (gitlab) {
    const branch = normalizedBranch(gitlab[1]);
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
  const callText = call.rendered.toLowerCase();
  const needles = [
    request.path,
    request.resolvedPath,
    request.destination,
    request.command,
  ]
    .filter((value): value is string => Boolean(value && value.length >= 3))
    .map((value) => value.toLowerCase());
  const namesMatch =
    Boolean(request.toolName) &&
    (call.name === request.toolName ||
      call.name.endsWith(`/${request.toolName}`) ||
      request.toolName?.endsWith(`/${call.name}`));
  const currentCommand = request.command || "";
  const priorCommand = commandArgument(call);
  const pushedBranch = explicitPushBranch(currentCommand);
  const providerQuery = providerBranchQuery(priorCommand);
  const destructive =
    /\b(?:rm|rmdir|unlink|trash|delete)\b/i.test(currentCommand);
  const readOnlyCheck =
    /^\s*(?:stat|ls|find|test|readlink|realpath)\b/i.test(priorCommand);
  const targets = [request.path, request.resolvedPath]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (
    destructive &&
    readOnlyCheck &&
    targets.some((target) => priorCommand.toLowerCase().includes(target))
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
  if (
    (namesMatch || needles.length > 0) &&
    needles.some((value) => callText.includes(value))
  ) {
    return "same-tool";
  }
  return undefined;
}

function relevantResultEvidence(
  entries: readonly unknown[],
  request: RelevantBoundaryRequest,
): Array<{ index: number; text: string }> {
  const calls = new Map<string, ToolCallRecord>();
  const results: Array<{ index: number; text: string }> = [];
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
    if (reason && text) {
      results.push({
        index,
        text: `<tool-result reason="${reason}" tool="${escapeEvidenceMarkup(call.name)}">\n${escapeEvidenceMarkup(text)}\n</tool-result>`,
      });
    }
  });
  return results;
}

function sandboxTrapEvidence(
  request: RelevantBoundaryRequest,
): string | undefined {
  if (request.source !== "sandbox-runtime") return;
  return `<sandbox-trap>
${boundedString({
    surface: request.surface,
    operation: request.operation,
    path: request.path,
    resolvedPath: request.resolvedPath,
    destination: request.destination,
    process: request.toolName,
  })}
</sandbox-trap>`;
}

function selectEvidence(
  evidence: Evidence[],
  kind: Evidence["kind"],
  budgetCharacters: number,
): { selected: Evidence[]; truncated: boolean } {
  const candidates = evidence.filter((item) => item.kind === kind);
  if (candidates.length === 0 || budgetCharacters <= 0) {
    return { selected: [], truncated: candidates.length > 0 };
  }

  const selected = new Map<number, Evidence>();
  let remaining = budgetCharacters;
  const add = (item: Evidence, limit = remaining): void => {
    if (selected.has(item.index) || remaining <= 0) return;
    const text = item.text.slice(0, Math.min(remaining, limit));
    if (!text) return;
    selected.set(item.index, { ...item, text });
    remaining -= text.length;
  };

  // Keep the original user intent as an anchor, then fill from newest to oldest.
  if (kind === "user") {
    const firstBudget =
      candidates.length > 1
        ? Math.max(1, Math.floor(budgetCharacters / 2))
        : budgetCharacters;
    add(candidates[0], firstBudget);
    if (candidates.length > 1) add(candidates[candidates.length - 1]);
  }
  for (let index = candidates.length - 1; index >= 0; index--) {
    add(candidates[index]);
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
  const users = selectEvidence(
    evidence,
    "user",
    config.maxUserTranscriptTokens * 4,
  );
  const tools = selectEvidence(
    evidence,
    "tool",
    config.maxToolTranscriptTokens * 4,
  );
  const selected = [...users.selected, ...tools.selected].sort(
    (left, right) => left.index - right.index,
  );
  const baseRendered = selected
    .map(
      (item) =>
        `<${item.kind}>\n${escapeEvidenceMarkup(item.text)}\n</${item.kind}>`,
    )
    .join("\n\n");
  const relevantBudget =
    (config.maxRelevantResultTokens ?? config.maxToolTranscriptTokens) * 4;
  const relevantCandidates = [
    ...(sandboxTrapEvidence(request)
      ? [{ index: Number.MAX_SAFE_INTEGER - 1, text: sandboxTrapEvidence(request)! }]
      : []),
    ...relevantResultEvidence(entries, request),
  ];
  let relevantRemaining = relevantBudget;
  const relevantSelected: string[] = [];
  for (let index = relevantCandidates.length - 1; index >= 0; index--) {
    if (relevantRemaining <= 0) break;
    const text = relevantCandidates[index].text.slice(0, relevantRemaining);
    if (text) {
      relevantSelected.unshift(text);
      relevantRemaining -= text.length;
    }
  }
  const rendered = [baseRendered, ...relevantSelected]
    .filter(Boolean)
    .join("\n\n");
  const relevantTruncated =
    relevantSelected.length < relevantCandidates.length ||
    relevantSelected.reduce((total, value) => total + value.length, 0) <
      relevantCandidates.reduce((total, value) => total + value.text.length, 0);
  const truncated = users.truncated || tools.truncated || relevantTruncated;
  const text = truncated
    ? `[Some transcript evidence was omitted or truncated.]\n\n${rendered}`
    : rendered;
  return {
    text: text || "(no eligible transcript evidence)",
    userCharacters: users.selected.reduce(
      (total, item) => total + item.text.length,
      0,
    ),
    toolCharacters: tools.selected.reduce(
      (total, item) => total + item.text.length,
      0,
    ),
    relevantResultCharacters: relevantSelected.reduce(
      (total, item) => total + item.length,
      0,
    ),
    truncated,
  };
}
