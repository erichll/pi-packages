import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDED_SURFACES,
  EXTENSION_NAME,
  USER_CONFIG_RELATIVE_PATH,
} from "./consts.ts";
import type {
  BoundedSurface,
  Config,
} from "./types.ts";
import type { PolicyAuditConfig } from "../policy-audit/index.ts";

export const DEFAULT_CONFIG: Config = {
  model: "codex-auto-review",
  reasoning: "low",
  timeoutMs: 90_000,
  maxTokens: 256,
  retries: 2,
  maxUserTranscriptTokens: 1_200,
  maxToolTranscriptTokens: 1_200,
  maxRelevantResultTokens: 800,
  maxReviewerInputTokens: 8_192,
  breakGlassEnabled: true,
  failureMode: "deny",
  grantTtlMs: 60_000,
  autoConfirmBoundedAllows: Object.freeze(["external_directory", "path"]),
  policyAudit: Object.freeze({ enabled: true, retentionDays: 180 }),
};


export function validateConfig(value: unknown, source: string): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${EXTENSION_NAME}: ${source} must be an object`);
  }
  const raw = value as Partial<Config> & Record<string, unknown>;
  const allowedKeys = new Set([
    "model",
    "reasoning",
    "timeoutMs",
    "maxTokens",
    "retries",
    "maxUserTranscriptTokens",
    "maxToolTranscriptTokens",
    "maxRelevantResultTokens",
    "maxReviewerInputTokens",
    "breakGlassEnabled",
    "failureMode",
    "grantTtlMs",
    "autoConfirmBoundedAllows",
    "policyAudit",
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${EXTENSION_NAME}: unknown config keys in ${source}: ${unknownKeys.join(", ")}`,
    );
  }
  const config = { ...DEFAULT_CONFIG, ...raw };
  config.policyAudit = {
    ...DEFAULT_CONFIG.policyAudit,
    ...(raw.policyAudit as Partial<PolicyAuditConfig> | undefined),
  };
  if (
    typeof config.model !== "string" ||
    !config.model.trim() ||
    /\s/.test(config.model) ||
    config.model.split("/").some((segment) => !segment.trim())
  ) {
    throw new Error(
      `${EXTENSION_NAME}: model must be a model id or provider/model`,
    );
  }
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      config.reasoning,
    )
  ) {
    throw new Error(`${EXTENSION_NAME}: invalid reasoning level`);
  }
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1_000 ||
    config.timeoutMs > 120_000
  ) {
    throw new Error(`${EXTENSION_NAME}: timeoutMs must be 1000..120000`);
  }
  if (
    !Number.isInteger(config.maxTokens) ||
    config.maxTokens < 256 ||
    config.maxTokens > 4_096
  ) {
    throw new Error(`${EXTENSION_NAME}: maxTokens must be 256..4096`);
  }
  if (
    !Number.isInteger(config.retries) ||
    config.retries < 0 ||
    config.retries > 2
  ) {
    throw new Error(`${EXTENSION_NAME}: retries must be 0..2`);
  }
  if (!["deny", "defer"].includes(config.failureMode)) {
    throw new Error(`${EXTENSION_NAME}: failureMode must be deny or defer`);
  }
  if (typeof config.breakGlassEnabled !== "boolean") {
    throw new Error(`${EXTENSION_NAME}: breakGlassEnabled must be boolean`);
  }
  if (
    !Number.isInteger(config.grantTtlMs) ||
    config.grantTtlMs < 1_000 ||
    config.grantTtlMs > 300_000
  ) {
    throw new Error(`${EXTENSION_NAME}: grantTtlMs must be 1000..300000`);
  }
  if (
    !Array.isArray(config.autoConfirmBoundedAllows) ||
    config.autoConfirmBoundedAllows.some(
      (surface) => !BOUNDED_SURFACES.has(surface),
    ) ||
    new Set(config.autoConfirmBoundedAllows).size !==
      config.autoConfirmBoundedAllows.length
  ) {
    throw new Error(
      `${EXTENSION_NAME}: autoConfirmBoundedAllows must contain unique external_directory/path entries`,
    );
  }
  for (const [name, entry] of [
    ["maxUserTranscriptTokens", config.maxUserTranscriptTokens],
    ["maxToolTranscriptTokens", config.maxToolTranscriptTokens],
    ["maxRelevantResultTokens", config.maxRelevantResultTokens],
  ] as const) {
    if (!Number.isInteger(entry) || entry < 32 || entry > 8_000) {
      throw new Error(`${EXTENSION_NAME}: ${name} must be 32..8000`);
    }
  }
  if (
    !Number.isInteger(config.maxReviewerInputTokens) ||
    config.maxReviewerInputTokens < 2_048 ||
    config.maxReviewerInputTokens > 32_768
  ) {
    throw new Error(
      `${EXTENSION_NAME}: maxReviewerInputTokens must be 2048..32768`,
    );
  }
  if (raw.policyAudit !== undefined &&
      (!raw.policyAudit || typeof raw.policyAudit !== "object" || Array.isArray(raw.policyAudit))) {
    throw new Error(`${EXTENSION_NAME}: policyAudit must be an object`);
  }
  const policyAuditKeys = Object.keys((raw.policyAudit ?? {}) as Record<string, unknown>);
  if (policyAuditKeys.some((key) => key !== "enabled" && key !== "retentionDays")) {
    throw new Error(`${EXTENSION_NAME}: policyAudit only accepts enabled and retentionDays`);
  }
  if (typeof config.policyAudit.enabled !== "boolean" ||
      !Number.isInteger(config.policyAudit.retentionDays) ||
      config.policyAudit.retentionDays < 1 || config.policyAudit.retentionDays > 3_650) {
    throw new Error(`${EXTENSION_NAME}: policyAudit requires enabled boolean and retentionDays 1..3650`);
  }
  return {
    ...config,
    autoConfirmBoundedAllows: Object.freeze([
      ...config.autoConfirmBoundedAllows,
    ]),
    policyAudit: Object.freeze({ ...config.policyAudit }),
  };
}

export function packageConfigPath(): string {
  // src/review/config.ts → src/config.json (one level up).
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "config.json");
}

export function userConfigPath(home = homedir()): string {
  return join(home, USER_CONFIG_RELATIVE_PATH);
}

function readJsonConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${EXTENSION_NAME}: cannot load ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Package-shipped defaults from `src/config.json`. */
export function loadConfig(): Config {
  const path = packageConfigPath();
  return validateConfig(readJsonConfig(path), path);
}

/**
 * User-global trusted overlay at
 * `~/.pi/agent/extensions/pi-auto-review/config.json`.
 * May set any legal config key, including model and autoConfirmBoundedAllows.
 */
export function applyUserConfig(
  packageConfig: Config,
  value: unknown,
  source = "user config",
): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${EXTENSION_NAME}: ${source} must be an object`);
  }
  const overlay = value as Record<string, unknown>;
  if (overlay.policyAudit !== undefined &&
      (!overlay.policyAudit || typeof overlay.policyAudit !== "object" || Array.isArray(overlay.policyAudit))) {
    throw new Error(`${EXTENSION_NAME}: ${source} policyAudit must be an object`);
  }
  return validateConfig(
    {
      ...packageConfig,
      autoConfirmBoundedAllows: [...packageConfig.autoConfirmBoundedAllows],
      ...overlay,
      policyAudit: {
        ...packageConfig.policyAudit,
        ...(overlay.policyAudit as object | undefined),
      },
    },
    source,
  );
}

export type LoadTrustedConfigOptions = {
  packageConfig?: Config;
  userConfigPath?: string;
};

/**
 * Trusted config = package defaults, optionally fully overlaid by the user
 * global file. Project config is applied later and may only tighten.
 */
export function loadTrustedConfig(
  options: LoadTrustedConfigOptions = {},
): Config {
  const packageConfig = options.packageConfig ?? loadConfig();
  const path = options.userConfigPath ?? userConfigPath();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return packageConfig;
    }
    throw new Error(
      `${EXTENSION_NAME}: cannot load ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return applyUserConfig(packageConfig, value, path);
}

const TIGHTENABLE_NUMBER_KEYS = [
  "timeoutMs",
  "maxTokens",
  "retries",
  "maxUserTranscriptTokens",
  "maxToolTranscriptTokens",
  "maxRelevantResultTokens",
  "maxReviewerInputTokens",
  "grantTtlMs",
] as const;

export function applyProjectConfig(
  trusted: Config,
  value: unknown,
): Readonly<Config> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${EXTENSION_NAME}: project config must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set<string>([
    ...TIGHTENABLE_NUMBER_KEYS,
    "breakGlassEnabled",
    "failureMode",
    "autoConfirmBoundedAllows",
    "policyAudit",
  ]);
  const forbidden = Object.keys(raw).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) {
    throw new Error(
      `${EXTENSION_NAME}: project config cannot set: ${forbidden.join(", ")}`,
    );
  }
  const merged: Config = { ...trusted };
  for (const key of TIGHTENABLE_NUMBER_KEYS) {
    if (raw[key] === undefined) continue;
    if (
      typeof raw[key] !== "number" ||
      !Number.isFinite(raw[key]) ||
      raw[key] > trusted[key]
    ) {
      throw new Error(
        `${EXTENSION_NAME}: project ${key} may only lower the trusted value`,
      );
    }
    (merged[key] as number) = raw[key];
  }
  if (raw.failureMode !== undefined) {
    if (raw.failureMode !== "deny") {
      throw new Error(
        `${EXTENSION_NAME}: project failureMode may only be deny`,
      );
    }
    merged.failureMode = "deny";
  }
  if (raw.breakGlassEnabled !== undefined) {
    if (raw.breakGlassEnabled !== false) {
      throw new Error(
        `${EXTENSION_NAME}: project breakGlassEnabled may only be false`,
      );
    }
    merged.breakGlassEnabled = false;
  }
  if (raw.autoConfirmBoundedAllows !== undefined) {
    if (
      !Array.isArray(raw.autoConfirmBoundedAllows) ||
      raw.autoConfirmBoundedAllows.some(
        (surface) =>
          typeof surface !== "string" ||
          !trusted.autoConfirmBoundedAllows.includes(
            surface as BoundedSurface,
          ),
      )
    ) {
      throw new Error(
        `${EXTENSION_NAME}: project autoConfirmBoundedAllows may only remove trusted surfaces`,
      );
    }
    merged.autoConfirmBoundedAllows = [
      ...new Set(raw.autoConfirmBoundedAllows as BoundedSurface[]),
    ];
  }
  if (raw.policyAudit !== undefined) {
    if (!raw.policyAudit || typeof raw.policyAudit !== "object" || Array.isArray(raw.policyAudit)) {
      throw new Error(`${EXTENSION_NAME}: project policyAudit must be an object`);
    }
    const audit = raw.policyAudit as Record<string, unknown>;
    const forbiddenAuditKeys = Object.keys(audit).filter((key) => key !== "enabled" && key !== "retentionDays");
    if (forbiddenAuditKeys.length > 0) {
      throw new Error(`${EXTENSION_NAME}: project policyAudit cannot set: ${forbiddenAuditKeys.join(", ")}`);
    }
    if (audit.enabled !== undefined && audit.enabled !== false) {
      throw new Error(`${EXTENSION_NAME}: project policyAudit may only disable collection`);
    }
    if (audit.retentionDays !== undefined &&
        (!Number.isInteger(audit.retentionDays) || Number(audit.retentionDays) < 1 || Number(audit.retentionDays) > trusted.policyAudit.retentionDays)) {
      throw new Error(`${EXTENSION_NAME}: project policyAudit.retentionDays may only shorten retention`);
    }
    merged.policyAudit = {
      enabled: audit.enabled === false ? false : trusted.policyAudit.enabled,
      retentionDays: audit.retentionDays === undefined ? trusted.policyAudit.retentionDays : Number(audit.retentionDays),
    };
  }
  return Object.freeze(validateConfig(merged, "effective project config"));
}
