import type { PolicyAuditAggregateRow, PolicyAuditQueryResult } from "./store.ts";

export const POLICY_AUDIT_REPORT_VERSION = 1 as const;

export type PolicyAuditReportItem = { name: string; count: number; denied: number; denialRate: number };

export type PolicyAuditReport = {
  version: typeof POLICY_AUDIT_REPORT_VERSION;
  scope: "current" | "all";
  days: number;
  collectingSince: string;
  fromDay: string;
  throughDay: string;
  total: number;
  allowed: number;
  denied: number;
  denialRate: number;
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
  scope: "current" | "all";
  days: number;
  top: number;
  minCount: number;
};

function rate(denied: number, total: number): number {
  return total === 0 ? 0 : Math.round((denied / total) * 10_000) / 100;
}

function rank(
  rows: readonly PolicyAuditAggregateRow[],
  key: (row: PolicyAuditAggregateRow) => string,
  top: number,
  minCount: number,
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

function reviewed(row: PolicyAuditAggregateRow): boolean {
  return ["user_approved", "user_approved_for_session", "user_denied", "auto_approved"].includes(row.resolution);
}

export function buildPolicyAuditReport(
  result: PolicyAuditQueryResult,
  options: PolicyAuditReportOptions,
): PolicyAuditReport {
  const total = result.rows.reduce((sum, row) => sum + row.count, 0);
  const denied = result.rows.filter((row) => row.result === "deny").reduce((sum, row) => sum + row.count, 0);
  const lowRisk = result.rows.filter((row) => row.risk === "read_only" && reviewed(row));
  const keepAsk = result.rows.filter((row) =>
    ["workspace_mutation", "project_code_execution", "network", "network_mutation", "arbitrary_shell", "unknown"].includes(row.risk)
  );
  const fingerprintCounts = new Map<string, number>();
  for (const row of result.rows) {
    if (row.ruleFingerprint === "none") continue;
    fingerprintCounts.set(row.ruleFingerprint, (fingerprintCounts.get(row.ruleFingerprint) ?? 0) + row.count);
  }
  const warnings = [
    "Counts begin at first successful enablement; no historical logs are imported.",
    "Rule fingerprints are anonymous hit indicators, not proof that unlisted rules are unused.",
    "High frequency alone must not be used to relax mutation, network, arbitrary-shell, unknown, or custom-tool policy.",
  ];
  if (total === 0) warnings.unshift("No matching permission decisions were collected for this window and scope.");
  return {
    version: POLICY_AUDIT_REPORT_VERSION,
    scope: options.scope,
    days: options.days,
    collectingSince: result.collectingSince,
    fromDay: result.fromDay,
    throughDay: result.throughDay,
    total,
    allowed: total - denied,
    denied,
    denialRate: rate(denied, total),
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

function itemLines(items: readonly PolicyAuditReportItem[]): string[] {
  return items.length === 0
    ? ["- None above the minimum count."]
    : items.map((item) => `- ${item.name}: ${item.count} (${item.denied} denied, ${item.denialRate}% denial)`);
}

export function renderPolicyAuditMarkdown(report: PolicyAuditReport): string {
  const fingerprints = report.ruleFingerprints.length === 0
    ? ["- None above the minimum count."]
    : report.ruleFingerprints.map((item) => `- ${item.fingerprint}: ${item.count}`);
  return [
    "# Permission policy audit",
    "",
    `Scope: **${report.scope}** · Window: **${report.fromDay}–${report.throughDay}** · Collecting since: **${report.collectingSince}**`,
    `Decisions: **${report.total}** · Allowed: **${report.allowed}** · Denied: **${report.denied}** · Denial rate: **${report.denialRate}%**`,
    "",
    "## Surface hotspots", "", ...itemLines(report.surfaces), "",
    "## Tool and command signatures", "", ...itemLines(report.tools), "",
    "## Bash semantic categories", "", ...itemLines(report.bashCategories), "",
    "## Approval sources", "", ...itemLines(report.approvalSources), "",
    "## Low-risk review candidates", "",
    "These read-only requests were still reviewed; inspect them before considering a narrower allow rule.",
    ...itemLines(report.lowRiskReviewCandidates), "",
    "## Keep-ask recommendations", "",
    "These mutation, execution, network, shell, or unknown requests should remain ask-by-default.",
    ...itemLines(report.keepAskRecommendations), "",
    "## Anonymous rule-hit fingerprints", "", ...fingerprints, "",
    "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}
