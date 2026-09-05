import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { classifyPermission } from "./classifier.ts";
import { buildPolicyAuditReport, renderPolicyAuditMarkdown, type PolicyAuditReport } from "./report.ts";
import { defaultPolicyAuditDirectory, PolicyAuditStore, type PolicyAuditStoreOptions } from "./store.ts";

export * from "./classifier.ts";
export * from "./report.ts";
export * from "./store.ts";

export type PolicyAuditConfig = { enabled: boolean; retentionDays: number };

export type PermissionDecisionLike = {
  requestId?: unknown;
  surface?: unknown;
  value?: unknown;
  result?: unknown;
  resolution?: unknown;
  origin?: unknown;
  matchedPattern?: unknown;
  forwarding?: unknown;
};

export type PolicyAuditArguments = { days: number; top: number; minCount: number; scope: "current" | "all" };

const PERMISSION_RESOLUTIONS = new Set([
  "policy_allow",
  "policy_deny",
  "session_approved",
  "infrastructure_auto_allowed",
  "user_approved",
  "user_approved_for_session",
  "user_denied",
  "auto_approved",
  "authorizer_allowed",
  "authorizer_denied",
  "confirmation_unavailable",
  "gate_error",
]);

export function parsePolicyAuditArguments(raw: string, retentionDays: number): PolicyAuditArguments {
  const result: PolicyAuditArguments = { days: Math.min(30, retentionDays), top: 20, minCount: 5, scope: "current" };
  const tokens = raw.trim() ? raw.trim().split(/\s+/u) : [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    const [flag, inline] = token.split("=", 2);
    const value = inline ?? tokens[++index];
    if (!flag || !value) throw new Error(`missing value for ${flag}`);
    if (flag === "--scope") {
      if (value !== "current" && value !== "all") throw new Error("--scope must be current or all");
      result.scope = value;
      continue;
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) throw new Error(`${flag} must be an integer`);
    if (flag === "--days" && numeric >= 1 && numeric <= retentionDays) result.days = numeric;
    else if (flag === "--top" && numeric >= 1 && numeric <= 50) result.top = numeric;
    else if (flag === "--min-count" && numeric >= 1) result.minCount = numeric;
    else if (!["--days", "--top", "--min-count"].includes(flag)) throw new Error(`unknown option ${flag}`);
    else throw new Error(`${flag} is outside its allowed range`);
  }
  return result;
}

export type PolicyAuditControllerOptions = {
  config: () => Readonly<PolicyAuditConfig>;
  cwd: () => string | undefined;
  directory?: string;
  warn: (message: string) => void;
  storeOptions?: Omit<PolicyAuditStoreOptions, "directory" | "retentionDays">;
};

export class PolicyAuditController {
  private storePromise?: Promise<PolicyAuditStore>;
  private disabled = false;
  private warned = false;
  private queue = Promise.resolve();

  constructor(private readonly options: PolicyAuditControllerOptions) {}

  warmup(): void {
    if (this.options.config().enabled) void this.getStore().catch(() => undefined);
  }

  private failure(error: unknown): never {
    this.disabled = true;
    const message = `pi-auto-review: policy audit disabled: ${error instanceof Error ? error.message : String(error)}`;
    if (!this.warned) {
      this.warned = true;
      this.options.warn(message);
    }
    throw error;
  }

  private async getStore(): Promise<PolicyAuditStore> {
    if (this.disabled) throw new Error("policy audit is unavailable");
    if (!this.storePromise) {
      const config = this.options.config();
      this.storePromise = PolicyAuditStore.open({
        directory: this.options.directory ?? defaultPolicyAuditDirectory(homedir()),
        retentionDays: config.retentionDays,
        ...this.options.storeOptions,
      }).catch((error) => this.failure(error));
    }
    return this.storePromise;
  }

  record(event: PermissionDecisionLike): void {
    const config = this.options.config();
    const cwd = this.options.cwd();
    if (!config.enabled || this.disabled || !cwd) return;
    if (typeof event.requestId !== "string" ||
        (event.result !== "allow" && event.result !== "deny") ||
        typeof event.resolution !== "string") return;
    const result: "allow" | "deny" = event.result;
    // The raw value is classified synchronously and is never captured by the
    // asynchronous queue or handed to SQLite.
    const classified = classifyPermission(event.surface, event.value, cwd);
    const digest = (kind: string, value: string) =>
      createHash("sha256").update(`${kind}\0${value}`).digest("hex");
    const rawOrigin = typeof event.origin === "string" ? event.origin.toLowerCase() : "";
    const origin = rawOrigin.includes("project")
      ? "project"
      : rawOrigin.includes("user") || rawOrigin.includes("global")
        ? "user"
        : rawOrigin.includes("default") || rawOrigin.includes("package")
          ? "default"
          : rawOrigin ? "other" : "none";
    const sanitized = {
      ...classified,
      requestId: digest("request", event.requestId),
      result,
      resolution: PERMISSION_RESOLUTIONS.has(event.resolution) ? event.resolution : "unknown",
      origin,
      forwarded: event.forwarding !== null && event.forwarding !== undefined,
      matchedPattern: typeof event.matchedPattern === "string"
        ? digest("rule", event.matchedPattern)
        : undefined,
    };
    this.queue = this.queue
      .then(async () => (await this.getStore()).record(cwd, sanitized))
      .then(() => undefined)
      .catch((error) => {
        try { this.failure(error); } catch { /* observational failure is contained */ }
      });
  }

  async report(args: PolicyAuditArguments): Promise<{ report: PolicyAuditReport; markdown: string }> {
    const config = this.options.config();
    if (!config.enabled && !this.storePromise) throw new Error("policy audit collection is disabled by configuration");
    if (args.days > config.retentionDays) throw new Error(`days must be 1..${config.retentionDays}`);
    await this.queue;
    const cwd = this.options.cwd();
    if (!cwd) throw new Error("policy audit has no active project context");
    const store = await this.getStore();
    let result;
    try {
      result = store.query({ ...args, projectPath: cwd });
    } catch (error) {
      return this.failure(error);
    }
    const report = buildPolicyAuditReport(result, args);
    return { report, markdown: renderPolicyAuditMarkdown(report) };
  }

  async close(): Promise<void> {
    await this.queue;
    // Detach before awaiting so concurrent shutdowns cannot double-close.
    const storePromise = this.storePromise;
    this.storePromise = undefined;
    const store = await storePromise?.catch(() => undefined);
    store?.close();
  }
}
