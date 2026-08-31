import type { PolicyAuditAggregateRow, PolicyAuditQueryResult } from "./store.ts";

export const POLICY_AUDIT_REPORT_VERSION = 2 as const;

export type PolicyAuditReportItem = { name: string; count: number; denied: number; denialRate: number };
export type SuggestedAllowRule = {
  surface: string; pattern?: string; action: "allow"; safetyClass: string;
  successfulEvidence: number; denied: 0; rationale: string;
};
export type PolicyRecommendationItem = {
  surface: string; pattern?: string; successfulEvidence: number; denied: number; reason: string;
};

export type PolicyAuditReport = {
  version: typeof POLICY_AUDIT_REPORT_VERSION;
  scope: "current" | "all";
  days: number;
  collectingSince: string;
  recommendationsSince: string;
  fromDay: string;
  throughDay: string;
  total: number;
  allowed: number;
  denied: number;
  denialRate: number;
  configTarget: string;
  configFragment: string;
  suggestedAllowRules: SuggestedAllowRule[];
  keepAskRules: PolicyRecommendationItem[];
  insufficientEvidence: PolicyRecommendationItem[];
  surfaces: PolicyAuditReportItem[];
  tools: PolicyAuditReportItem[];
  bashCategories: PolicyAuditReportItem[];
  approvalSources: PolicyAuditReportItem[];
  lowRiskReviewCandidates: PolicyAuditReportItem[];
  keepAskRecommendations: PolicyAuditReportItem[];
  ruleFingerprints: Array<{ fingerprint: string; count: number }>;
  warnings: string[];
};

export type PolicyAuditReportOptions = {
  scope: "current" | "all"; days: number; top: number; minCount: number;
};

// Suggestion evidence must stay strictly human/session-based. Since
// permission-system v28, decisions made by a registered authorizer chain link
// (including pi-auto-review's own model review) resolve to `authorizer_allowed`
// instead of `user_approved`. Counting those here would create a feedback loop:
// machine review allows → evidence → suggested auto-allow rule → review bypassed.
const SUCCESS_RESOLUTIONS = new Set([
  "user_approved", "user_approved_for_session", "session_approved", "auto_approved",
]);
const FAILURE_RESOLUTIONS = new Set(["confirmation_unavailable", "gate_error"]);

function rate(denied: number, total: number): number {
  return total === 0 ? 0 : Math.round((denied / total) * 10_000) / 100;
}

function rank(
  rows: readonly PolicyAuditAggregateRow[], key: (row: PolicyAuditAggregateRow) => string,
  top: number, minCount: number,
): PolicyAuditReportItem[] {
  const grouped = new Map<string, { count: number; denied: number }>();
  for (const row of rows) {
    const name = key(row);
    const current = grouped.get(name) ?? { count: 0, denied: 0 };
    current.count += row.count;
    if (row.result === "deny") current.denied += row.count;
    grouped.set(name, current);
  }
  return [...grouped]
    .map(([name, value]) => ({ name, ...value, denialRate: rate(value.denied, value.count) }))
    .filter((item) => item.count >= minCount)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top);
}

// "Reviewed" marks ask-path rows that some reviewer resolved — human clicks and,
// since permission-system v28, named authorizer links alike — so low-risk
// candidates stay visible even when only the machine authorizer decides them.
// Display-only: SUCCESS_RESOLUTIONS still gates suggestion evidence.
function reviewed(row: PolicyAuditAggregateRow): boolean {
  return [
    "user_approved", "user_approved_for_session", "user_denied", "auto_approved",
    "authorizer_allowed", "authorizer_denied",
  ].includes(row.resolution);
}

type CandidateGroup = {
  surface: string; pattern?: string; safetyClass: string; successfulEvidence: number;
  denied: number; blockers: Set<string>;
};

function recommendationGroups(rows: readonly PolicyAuditAggregateRow[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const row of rows) {
    if (!row.candidateSurface) continue;
    // Forwarded evidence is reported separately: it cannot prove either the
    // current project's cwd or a safe global scope, and must not poison local
    // evidence for the same observed candidate.
    const key = `${row.candidateSurface}\0${row.candidatePattern}\0${row.forwarded ? "forwarded" : "local"}`;
    const group = groups.get(key) ?? {
      surface: row.candidateSurface,
      ...(row.candidatePattern ? { pattern: row.candidatePattern } : {}),
      safetyClass: row.candidateSafetyClass,
      successfulEvidence: 0,
      denied: 0,
      blockers: new Set<string>(),
    };
    if (row.result === "allow" && SUCCESS_RESOLUTIONS.has(row.resolution)) group.successfulEvidence += row.count;
    if (row.result === "deny") group.denied += row.count;
    if (row.forwarded) group.blockers.add("forwarded requests lack the requesting cwd");
    if (!row.candidateEligible) group.blockers.add(row.candidateBlocker || "unsafe or unparseable variant observed");
    if (FAILURE_RESOLUTIONS.has(row.resolution)) group.blockers.add(`authorization failure: ${row.resolution}`);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    b.successfulEvidence - a.successfulEvidence || a.surface.localeCompare(b.surface) ||
      (a.pattern ?? "").localeCompare(b.pattern ?? "")
  );
}

function displayRule(item: { surface: string; pattern?: string }): string {
  return item.pattern ? `${item.surface}[${JSON.stringify(item.pattern)}]` : item.surface;
}

function buildConfigFragment(rules: readonly SuggestedAllowRule[]): string {
  const bash: Record<string, "allow"> = {};
  const permission: Record<string, "allow" | Record<string, "allow">> = {};
  for (const rule of rules) {
    if (rule.surface === "bash" && rule.pattern) bash[rule.pattern] = "allow";
  }
  if (Object.keys(bash).length > 0) permission.bash = bash;
  for (const rule of rules) {
    if (rule.surface !== "bash") permission[rule.surface] = "allow";
  }
  return JSON.stringify({ permission }, null, 2);
}

function genericKeepAskRules(
  rows: readonly PolicyAuditAggregateRow[], minCount: number, top: number,
): PolicyRecommendationItem[] {
  const grouped = new Map<string, { surface: string; risk: string; total: number; successful: number; denied: number }>();
  for (const row of rows) {
    if (row.candidateSurface) continue;
    const surface = row.surface === "custom_tool" ? row.signature : `${row.surface}:${row.signature}`;
    const key = `${surface}\0${row.risk}`;
    const group = grouped.get(key) ?? { surface, risk: row.risk, total: 0, successful: 0, denied: 0 };
    group.total += row.count;
    if (row.result === "allow" && SUCCESS_RESOLUTIONS.has(row.resolution)) group.successful += row.count;
    if (row.result === "deny") group.denied += row.count;
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .filter((group) => group.total >= minCount)
    .sort((a, b) => b.total - a.total || a.surface.localeCompare(b.surface))
    .slice(0, top)
    .map((group) => ({
      surface: group.surface,
      successfulEvidence: group.successful,
      denied: group.denied,
      reason: `${group.total} observed but no valid copyable permission rule could be derived (${group.risk})`,
    }));
}

export function buildPolicyAuditReport(
  result: PolicyAuditQueryResult, options: PolicyAuditReportOptions,
): PolicyAuditReport {
  const total = result.rows.reduce((sum, row) => sum + row.count, 0);
  const denied = result.rows.filter((row) => row.result === "deny").reduce((sum, row) => sum + row.count, 0);
  const lowRisk = result.rows.filter((row) => row.risk === "read_only" && reviewed(row));
  const keepAsk = result.rows.filter((row) => !row.candidateSurface);
  const groups = recommendationGroups(result.rows);
  const suggestedAllowRules: SuggestedAllowRule[] = groups
    .filter((group) => group.successfulEvidence >= options.minCount && group.denied === 0 && group.blockers.size === 0)
    .slice(0, options.top)
    .map((group) => ({
      surface: group.surface,
      ...(group.pattern ? { pattern: group.pattern } : {}),
      action: "allow",
      safetyClass: group.safetyClass,
      successfulEvidence: group.successfulEvidence,
      denied: 0,
      rationale: group.safetyClass === "observed_bash_template"
        ? "observed Bash template; zero denials, failures, and structurally unsafe variants"
        : "observed permission surface; zero denials and authorization failures",
    }));
  const candidateKeepAskRules: PolicyRecommendationItem[] = groups
    .filter((group) => group.denied > 0 || group.blockers.size > 0)
    .map((group) => ({
      surface: group.surface,
      ...(group.pattern ? { pattern: group.pattern } : {}),
      successfulEvidence: group.successfulEvidence,
      denied: group.denied,
      reason: [group.denied ? `${group.denied} denied` : "", ...group.blockers].filter(Boolean).join("; "),
    }));
  const keepAskRules = [
    ...candidateKeepAskRules,
    ...genericKeepAskRules(keepAsk, options.minCount, options.top),
  ].slice(0, options.top);
  const insufficientEvidence: PolicyRecommendationItem[] = groups
    .filter((group) => group.successfulEvidence > 0 && group.successfulEvidence < options.minCount && group.denied === 0 && group.blockers.size === 0)
    .slice(0, options.top)
    .map((group) => ({
      surface: group.surface,
      ...(group.pattern ? { pattern: group.pattern } : {}),
      successfulEvidence: group.successfulEvidence,
      denied: 0,
      reason: `needs ${options.minCount - group.successfulEvidence} more successful ask-path sample(s)`,
    }));
  const fingerprintCounts = new Map<string, number>();
  for (const row of result.rows) {
    if (row.ruleFingerprint === "none") continue;
    fingerprintCounts.set(row.ruleFingerprint, (fingerprintCounts.get(row.ruleFingerprint) ?? 0) + row.count);
  }
  const warnings = [
    "Counts begin at first successful enablement; no historical logs are imported.",
    "Suggestions are evidence-based decision aids and never modify permission configuration.",
    "Migrated pre-v2 counts remain in statistics but cannot contribute recommendation evidence.",
    "Rule fingerprints are anonymous hit indicators, not proof that unlisted rules are unused.",
    "A suggestion reflects repeated approval history, not an independent proof that the capability is safe.",
  ];
  if (total === 0) warnings.unshift("No matching permission decisions were collected for this window and scope.");
  return {
    version: POLICY_AUDIT_REPORT_VERSION,
    scope: options.scope,
    days: options.days,
    collectingSince: result.collectingSince,
    recommendationsSince: result.recommendationsSince,
    fromDay: result.fromDay,
    throughDay: result.throughDay,
    total,
    allowed: total - denied,
    denied,
    denialRate: rate(denied, total),
    configTarget: options.scope === "current"
      ? ".pi/extensions/pi-permission-system/config.json"
      : "~/.pi/agent/extensions/pi-permission-system/config.json",
    configFragment: buildConfigFragment(suggestedAllowRules),
    suggestedAllowRules,
    keepAskRules,
    insufficientEvidence,
    surfaces: rank(result.rows, (row) => row.surface, options.top, options.minCount),
    tools: rank(result.rows, (row) => row.signature, options.top, options.minCount),
    bashCategories: rank(result.rows.filter((row) => row.bashCategory !== "not_bash"), (row) => row.bashCategory, options.top, options.minCount),
    approvalSources: rank(result.rows, (row) => `${row.resolution}/${row.origin}${row.forwarded ? "/forwarded" : ""}`, options.top, options.minCount),
    lowRiskReviewCandidates: rank(lowRisk, (row) => `${row.surface}:${row.signature}`, options.top, options.minCount),
    keepAskRecommendations: rank(keepAsk, (row) => `${row.risk}:${row.surface}:${row.signature}`, options.top, options.minCount),
    ruleFingerprints: [...fingerprintCounts]
      .map(([fingerprint, count]) => ({ fingerprint, count }))
      .filter((item) => item.count >= options.minCount)
      .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint))
      .slice(0, options.top),
    warnings,
  };
}

// Shared renderer helpers — kept terse so the TUI can fit one full report
// on a typical screen without scrolling past statistics.
type Row = { label: string; count: number; denied: number; denialRate: number };

function itemLines(items: readonly Row[]): string[] {
  return items.length === 0
    ? ["- None above the minimum count."]
    : items.map((item) => `- ${item.label}: ${item.count} (${item.denied} denied, ${item.denialRate}% denial)`);
}

function recommendationLines(items: readonly PolicyRecommendationItem[]): string[] {
  return items.length === 0
    ? ["- None."]
    : items.map((item) => `- ${displayRule(item)}: ${item.successfulEvidence} successful, ${item.denied} denied — ${item.reason}`);
}

// Compress the five "hotspot" rankings (surface / signature / bash category /
// approval source / low-risk) into one table-like section. Each row keeps the
// original three fields (count, denied, denial rate); zero-denied rows drop
// the redundant denial-rate field so the eye can scan allowed-only traffic.
function hotspotRow(item: PolicyAuditReportItem): string {
  const denied = `${item.denied} denied`;
  const rate = item.denied === 0 ? "" : `, ${item.denialRate}% denial`;
  return `- ${item.name}: ${item.count} (${denied}${rate})`;
}

function renderHotspotSections(report: PolicyAuditReport): string[] {
  // Approval sources already encodes the same count as surfaces via a
  // different key, so skip it when nothing was denied — it is allowed-only
  // noise in that case. Low-risk review candidates overlap with the generic
  // keep-ask section and are dropped entirely; the keep-ask section is the
  // authoritative place for "what still asks".
  const groups: Array<{ title: string; items: PolicyAuditReportItem[] }> = [
    { title: "Surface hotspots", items: report.surfaces },
    { title: "Tool and command signatures", items: report.tools },
    { title: "Bash semantic categories", items: report.bashCategories },
  ];
  if (report.approvalSources.some((item) => item.denied > 0)) {
    groups.push({ title: "Approval sources with denials", items: report.approvalSources });
  }
  if (report.ruleFingerprints.length > 0) {
    groups.push({ title: "Anonymous rule-hit fingerprints",
      items: report.ruleFingerprints.map((f) => ({ name: f.fingerprint, count: f.count, denied: 0, denialRate: 0 })) });
  }
  return groups.flatMap((group) => ["", `## ${group.title}`, "", ...group.items.map(hotspotRow)]);
}

export function renderPolicyAuditMarkdown(report: PolicyAuditReport): string {
  const suggested = report.suggestedAllowRules.length === 0
    ? ["- None."]
    : report.suggestedAllowRules.map((item) =>
      `- ${displayRule(item)} = allow: ${item.successfulEvidence} successful ask-path samples, zero denials — ${item.rationale}`
    );
  // The candidate keep-ask list (denied / blocked candidates) is the
  // actionable one; the generic keep-ask and the ranked recommendations
  // overlap heavily and are kept only as a single fallback line so the
  // user sees they exist without a wall of duplicates.
  const candidateKeepAsk = report.keepAskRules.filter((item) => item.denied > 0 ||
    /denied|forwarded|unsafe|unparseable|authorization failure|parse_failed/i.test(item.reason));
  const genericKeepAsk = report.keepAskRules.filter((item) => !candidateKeepAsk.includes(item));
  const keepAskFallback = genericKeepAsk.length > 0
    ? [`- ${genericKeepAsk.length} more surface(s) remain ask-by-default with no copyable rule; see full report for details.`]
    : [];
  return [
    "# Permission policy audit", "",
    `Scope: **${report.scope}** · Window: **${report.fromDay}–${report.throughDay}** · Collecting since: **${report.collectingSince}**`,
    `Decisions: **${report.total}** · Allowed: **${report.allowed}** · Denied: **${report.denied}** · Denial rate: **${report.denialRate}%**`, "",
    "## Suggested allow rules", "", ...suggested, "",
    "## Copyable permission config", "", `Target: \`${report.configTarget}\``,
    "Place narrow allow entries after broader matching ask entries (last-match-wins).", "",
    "```json", report.configFragment, "```", "",
    "## Keep ask",
    "Denied candidates, authorization failures, unsafe Bash variants, and forwarded requests remain ask-by-default.",
    ...recommendationLines(candidateKeepAsk), ...keepAskFallback, "",
    "## Insufficient evidence", "", ...recommendationLines(report.insufficientEvidence),
    ...renderHotspotSections(report), "",
    "## Warnings", "",
    "- Suggestions are evidence-based decision aids and never modify permission configuration. See the package README for the full list of caveats.",
  ].join("\n");
}
