import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ClassifiedPermission } from "./classifier.ts";

export const POLICY_AUDIT_SCHEMA_VERSION = 1;
export const POLICY_AUDIT_DATABASE_NAME = "policy-audit.sqlite";
export const POLICY_AUDIT_KEY_NAME = "policy-audit.key";

type RunResult = { changes: number | bigint };
type Statement = {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};
type SqliteModule = { DatabaseSync: new (path: string, options?: Record<string, unknown>) => Database };

export type SanitizedPermissionDecision = ClassifiedPermission & {
  requestId: string;
  result: "allow" | "deny";
  resolution: string;
  origin: string;
  forwarded: boolean;
  matchedPattern?: string;
};

export type PolicyAuditStoreOptions = {
  directory: string;
  retentionDays: number;
  now?: () => Date;
  sqliteLoader?: () => Promise<SqliteModule>;
};

export type PolicyAuditQuery = {
  days: number;
  top: number;
  minCount: number;
  scope: "current" | "all";
  projectPath: string;
};

export type PolicyAuditAggregateRow = {
  surface: string;
  signature: string;
  bashCategory: string;
  risk: string;
  pathClass: string;
  result: string;
  resolution: string;
  origin: string;
  forwarded: boolean;
  features: string;
  ruleFingerprint: string;
  count: number;
};

export type PolicyAuditQueryResult = {
  collectingSince: string;
  fromDay: string;
  throughDay: string;
  rows: PolicyAuditAggregateRow[];
};

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, delta: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + delta);
  return copy;
}

function loadOrCreateKey(directory: string): Buffer {
  const keyPath = join(directory, POLICY_AUDIT_KEY_NAME);
  try {
    const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, randomBytes(32));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("policy audit key has an invalid length");
  return key;
}

function normalizeOrigin(value: string): string {
  const lowered = value.toLowerCase();
  if (lowered.includes("project")) return "project";
  if (lowered.includes("user") || lowered.includes("global")) return "user";
  if (lowered.includes("default") || lowered.includes("package")) return "default";
  return value === "none" ? "none" : "other";
}

export class PolicyAuditStore {
  static async open(options: PolicyAuditStoreOptions): Promise<PolicyAuditStore> {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    chmodSync(options.directory, 0o700);
    const key = loadOrCreateKey(options.directory);
    const sqlite = await (options.sqliteLoader ?? (() => import("node:sqlite") as Promise<SqliteModule>))();
    const databasePath = join(options.directory, POLICY_AUDIT_DATABASE_NAME);
    const db = new sqlite.DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    const store = new PolicyAuditStore(db, key, databasePath, options.retentionDays, options.now ?? (() => new Date()));
    try {
      store.initialize();
      return store;
    } catch (error) {
      try { db.close(); } catch { /* preserve initialization error */ }
      throw error;
    }
  }

  private constructor(
    private readonly db: Database,
    private readonly key: Buffer,
    private readonly databasePath: string,
    private readonly retentionDays: number,
    private readonly now: () => Date,
    private closed = false,
  ) {}

  private initialize(): void {
    this.db.exec("PRAGMA busy_timeout=75; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS seen_requests (
        request_hash TEXT PRIMARY KEY,
        seen_day TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS daily_permission_stats (
        day TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        surface TEXT NOT NULL,
        signature TEXT NOT NULL,
        bash_category TEXT NOT NULL,
        risk TEXT NOT NULL,
        path_class TEXT NOT NULL,
        result TEXT NOT NULL,
        resolution TEXT NOT NULL,
        origin TEXT NOT NULL,
        forwarded INTEGER NOT NULL,
        features TEXT NOT NULL,
        rule_fingerprint TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (day, project_hash, surface, signature, bash_category, risk, path_class, result, resolution, origin, forwarded, features, rule_fingerprint)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS daily_permission_stats_project_day ON daily_permission_stats(project_hash, day);
    `);
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
    if (version !== undefined && version !== String(POLICY_AUDIT_SCHEMA_VERSION)) {
      throw new Error("unsupported policy audit schema version");
    }
    const now = this.now().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version',?)").run(String(POLICY_AUDIT_SCHEMA_VERSION));
    this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('collecting_since',?)").run(now);
    this.secureSidecars();
  }

  private hash(kind: string, value: string): string {
    return createHmac("sha256", this.key).update(`${kind}\0${value}`).digest("hex");
  }

  projectHash(projectPath: string): string {
    return this.hash("project", resolve(projectPath));
  }

  ruleFingerprint(pattern: string | undefined): string {
    return pattern ? this.hash("rule", pattern).slice(0, 16) : "none";
  }

  private retry<T>(operation: () => T): T {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return operation();
      } catch (error) {
        last = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/busy|locked/i.test(message) || attempt === 2) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
    throw last;
  }

  record(projectPath: string, event: SanitizedPermissionDecision): boolean {
    return this.retry(() => {
      const day = dayString(this.now());
      this.pruneIfNeeded(day);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const requestHash = this.hash("request", event.requestId);
        const inserted = this.db.prepare("INSERT OR IGNORE INTO seen_requests(request_hash,seen_day) VALUES(?,?)").run(requestHash, day);
        if (Number(inserted.changes) === 0) {
          this.db.exec("COMMIT");
          return false;
        }
        this.db.prepare(`
          INSERT INTO daily_permission_stats(
            day,project_hash,surface,signature,bash_category,risk,path_class,result,resolution,origin,forwarded,features,rule_fingerprint,count
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)
          ON CONFLICT DO UPDATE SET count=count+1
        `).run(
          day,
          this.projectHash(projectPath),
          event.surface,
          event.signature,
          event.bashCategory,
          event.risk,
          event.pathClass,
          event.result,
          event.resolution,
          normalizeOrigin(event.origin),
          event.forwarded ? 1 : 0,
          event.features.join(","),
          this.ruleFingerprint(event.matchedPattern),
        );
        this.db.exec("COMMIT");
        this.secureSidecars();
        return true;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
    });
  }

  private pruneIfNeeded(today: string): void {
    const last = this.db.prepare("SELECT value FROM meta WHERE key='last_cleanup_day'").get()?.value;
    if (last === today) return;
    const cutoff = dayString(addDays(this.now(), -this.retentionDays + 1));
    this.db.prepare("DELETE FROM daily_permission_stats WHERE day < ?").run(cutoff);
    this.db.prepare("DELETE FROM seen_requests WHERE seen_day < ?").run(cutoff);
    this.db.prepare("INSERT INTO meta(key,value) VALUES('last_cleanup_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(today);
  }

  query(input: PolicyAuditQuery): PolicyAuditQueryResult {
    return this.retry(() => {
      const throughDay = dayString(this.now());
      const fromDay = dayString(addDays(this.now(), -input.days + 1));
      const projectClause = input.scope === "current" ? "AND project_hash = ?" : "";
      const params: unknown[] = [fromDay];
      if (input.scope === "current") params.push(this.projectHash(input.projectPath));
      const rows = this.db.prepare(`
        SELECT surface,signature,bash_category,risk,path_class,result,resolution,origin,forwarded,features,rule_fingerprint,SUM(count) AS count
        FROM daily_permission_stats
        WHERE day >= ? ${projectClause}
        GROUP BY surface,signature,bash_category,risk,path_class,result,resolution,origin,forwarded,features,rule_fingerprint
      `).all(...params).map((row) => ({
        surface: String(row.surface), signature: String(row.signature), bashCategory: String(row.bash_category),
        risk: String(row.risk), pathClass: String(row.path_class), result: String(row.result),
        resolution: String(row.resolution), origin: String(row.origin), forwarded: Number(row.forwarded) === 1,
        features: String(row.features), ruleFingerprint: String(row.rule_fingerprint), count: Number(row.count),
      }));
      const collectingSince = String(this.db.prepare("SELECT value FROM meta WHERE key='collecting_since'").get()?.value ?? "unknown");
      return { collectingSince, fromDay, throughDay, rows };
    });
  }

  private secureSidecars(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  close(): void {
    // Concurrent session_shutdown handlers must not reject a second close.
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function defaultPolicyAuditDirectory(home: string): string {
  return join(home, ".pi", "agent", "extensions", "pi-auto-review");
}
