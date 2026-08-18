import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime";

export const SUBAGENT_PROVIDERS = [
  "builtin",
  "pi-subagents",
  "off",
] as const;

export type SubagentProvider = (typeof SUBAGENT_PROVIDERS)[number];

export const HOST_IPC_MODES = ["off", "ask"] as const;
export type HostIPCMode = (typeof HOST_IPC_MODES)[number];

export type HostIPCConfig = {
  mode: HostIPCMode;
  preflightCommandPrefixes: readonly string[];
  retryOnUnixSocketError: boolean;
};

export type NetworkConfig = {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
};

export type PiSandboxConfig = {
  subagents: {
    provider: SubagentProvider;
    externalWorkerIsolation: "off" | "enforce";
  };
  filesystem: {
    additionalAllowRead: readonly string[];
  };
  network: NetworkConfig;
  hostIPC: HostIPCConfig;
};

export type LoadPiSandboxConfigOptions = {
  path?: string;
  /** Override home directory when resolving default/legacy trusted paths. */
  home?: string;
};

export const DEFAULT_PI_SANDBOX_CONFIG: Readonly<PiSandboxConfig> = Object.freeze(
  {
    subagents: Object.freeze({
      provider: "builtin",
      externalWorkerIsolation: "off",
    }),
    filesystem: Object.freeze({
      additionalAllowRead: Object.freeze([]),
    }),
    network: Object.freeze({
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze([]),
    }),
    hostIPC: Object.freeze({
      mode: "off",
      preflightCommandPrefixes: Object.freeze([]),
      retryOnUnixSocketError: false,
    }),
  },
);

export function getPiSandboxConfigPath(home = homedir()): string {
  return join(
    home,
    ".pi",
    "agent",
    "extensions",
    "pi-sandbox",
    "config.json",
  );
}

/** Legacy trusted path used before the extension-local config layout. */
export function getLegacyPiSandboxConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "pi-sandbox.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `invalid pi-sandbox configuration: unknown ${location} ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`,
    );
  }
}

function hasValidDomainLabels(
  pattern: string,
  allowDenyAll: boolean,
): boolean {
  const portMatch = pattern.match(/:([1-9][0-9]{0,4})$/);
  const hostPattern = portMatch
    ? pattern.slice(0, -portMatch[0].length)
    : pattern;
  if (portMatch && Number(portMatch[1]) > 65_535) return false;
  if (hostPattern === "*") return allowDenyAll;
  const hostname = hostPattern.startsWith("*.")
    ? hostPattern.slice(2)
    : hostPattern;
  return (
    hostname.length <= 253 &&
    hostname.includes(".") &&
    hostname.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  );
}

export function parsePiSandboxConfig(value: unknown): PiSandboxConfig {
  if (!isRecord(value)) {
    throw new Error("invalid pi-sandbox configuration: root must be an object");
  }
  rejectUnknownKeys(
    value,
    ["subagents", "filesystem", "network", "hostIPC"],
    "root",
  );

  if (value.subagents !== undefined && !isRecord(value.subagents)) {
    throw new Error(
      "invalid pi-sandbox configuration: subagents must be an object",
    );
  }
  const subagents = value.subagents ?? {};
  rejectUnknownKeys(
    subagents,
    ["provider", "externalWorkerIsolation"],
    "subagents",
  );

  const provider =
    subagents.provider ?? DEFAULT_PI_SANDBOX_CONFIG.subagents.provider;
  if (
    typeof provider !== "string" ||
    !SUBAGENT_PROVIDERS.includes(provider as SubagentProvider)
  ) {
    throw new Error(
      `invalid pi-sandbox configuration: subagents.provider must be one of ${SUBAGENT_PROVIDERS.join(", ")}`,
    );
  }
  const externalWorkerIsolation =
    subagents.externalWorkerIsolation ??
    DEFAULT_PI_SANDBOX_CONFIG.subagents.externalWorkerIsolation;
  if (
    externalWorkerIsolation !== "off" &&
    externalWorkerIsolation !== "enforce"
  ) {
    throw new Error(
      "invalid pi-sandbox configuration: subagents.externalWorkerIsolation must be off or enforce",
    );
  }

  if (value.filesystem !== undefined && !isRecord(value.filesystem)) {
    throw new Error(
      "invalid pi-sandbox configuration: filesystem must be an object",
    );
  }
  const filesystem = value.filesystem ?? {};
  rejectUnknownKeys(
    filesystem,
    ["additionalAllowRead"],
    "filesystem",
  );
  const additionalAllowRead =
    filesystem.additionalAllowRead ??
    DEFAULT_PI_SANDBOX_CONFIG.filesystem.additionalAllowRead;
  if (
    !Array.isArray(additionalAllowRead) ||
    additionalAllowRead.some(
      (path) =>
        typeof path !== "string" ||
        path.trim() === "" ||
        !isAbsolute(path),
    )
  ) {
    throw new Error(
      "invalid pi-sandbox configuration: filesystem.additionalAllowRead must be an array of absolute paths",
    );
  }

  if (value.network !== undefined && !isRecord(value.network)) {
    throw new Error(
      "invalid pi-sandbox configuration: network must be an object",
    );
  }
  const network = value.network ?? {};
  rejectUnknownKeys(
    network,
    ["allowedDomains", "deniedDomains"],
    "network",
  );
  const normalizeDomainList = (
    key: "allowedDomains" | "deniedDomains",
  ): string[] => {
    const configured = network[key] ?? DEFAULT_PI_SANDBOX_CONFIG.network[key];
    if (
      !Array.isArray(configured) ||
      configured.some(
        (pattern) => typeof pattern !== "string" || pattern.trim() === "",
      )
    ) {
      throw new Error(
        `invalid pi-sandbox configuration: network.${key} must be an array of non-empty strings`,
      );
    }
    const normalized = [
      ...new Set(configured.map((pattern) => pattern.trim())),
    ];
    const invalidIndex = normalized.findIndex(
      (pattern) => !hasValidDomainLabels(pattern, key === "deniedDomains"),
    );
    if (invalidIndex >= 0) {
      throw new Error(
        `invalid pi-sandbox configuration: network.${key}[${invalidIndex}] contains an invalid domain pattern`,
      );
    }
    const candidate = {
      allowedDomains: key === "allowedDomains" ? normalized : [],
      deniedDomains: key === "deniedDomains" ? normalized : [],
    };
    const result = NetworkConfigSchema.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(
        `invalid pi-sandbox configuration: network.${key}${typeof issue?.path[1] === "number" ? `[${issue.path[1]}]` : ""} ${issue?.message ?? "contains an invalid domain pattern"}`,
      );
    }
    return normalized;
  };
  const allowedDomains = normalizeDomainList("allowedDomains");
  const deniedDomains = normalizeDomainList("deniedDomains");

  if (value.hostIPC !== undefined && !isRecord(value.hostIPC)) {
    throw new Error(
      "invalid pi-sandbox configuration: hostIPC must be an object",
    );
  }
  const hostIPC = value.hostIPC ?? {};
  rejectUnknownKeys(
    hostIPC,
    ["mode", "preflightCommandPrefixes", "retryOnUnixSocketError"],
    "hostIPC",
  );
  const hostIPCMode = hostIPC.mode ?? DEFAULT_PI_SANDBOX_CONFIG.hostIPC.mode;
  if (
    typeof hostIPCMode !== "string" ||
    !HOST_IPC_MODES.includes(hostIPCMode as HostIPCMode)
  ) {
    throw new Error(
      `invalid pi-sandbox configuration: hostIPC.mode must be one of ${HOST_IPC_MODES.join(", ")}`,
    );
  }
  const preflightCommandPrefixes =
    hostIPC.preflightCommandPrefixes ??
    DEFAULT_PI_SANDBOX_CONFIG.hostIPC.preflightCommandPrefixes;
  if (
    !Array.isArray(preflightCommandPrefixes) ||
    preflightCommandPrefixes.some(
      (prefix) => typeof prefix !== "string" || prefix.trim() === "",
    )
  ) {
    throw new Error(
      "invalid pi-sandbox configuration: hostIPC.preflightCommandPrefixes must be an array of non-empty strings",
    );
  }
  const retryOnUnixSocketError =
    hostIPC.retryOnUnixSocketError ??
    DEFAULT_PI_SANDBOX_CONFIG.hostIPC.retryOnUnixSocketError;
  if (typeof retryOnUnixSocketError !== "boolean") {
    throw new Error(
      "invalid pi-sandbox configuration: hostIPC.retryOnUnixSocketError must be a boolean",
    );
  }

  return {
    subagents: {
      provider: provider as SubagentProvider,
      externalWorkerIsolation,
    },
    filesystem: {
      additionalAllowRead: [...new Set(additionalAllowRead)],
    },
    network: {
      allowedDomains: [...allowedDomains],
      deniedDomains: [...deniedDomains],
    },
    hostIPC: {
      mode: hostIPCMode as HostIPCMode,
      preflightCommandPrefixes: [
        ...new Set(preflightCommandPrefixes.map((prefix) => prefix.trim())),
      ],
      retryOnUnixSocketError,
    },
  };
}

function defaultPiSandboxConfig(): PiSandboxConfig {
  return {
    subagents: {
      provider: DEFAULT_PI_SANDBOX_CONFIG.subagents.provider,
      externalWorkerIsolation:
        DEFAULT_PI_SANDBOX_CONFIG.subagents.externalWorkerIsolation,
    },
    filesystem: {
      additionalAllowRead: [
        ...DEFAULT_PI_SANDBOX_CONFIG.filesystem.additionalAllowRead,
      ],
    },
    network: {
      allowedDomains: [...DEFAULT_PI_SANDBOX_CONFIG.network.allowedDomains],
      deniedDomains: [...DEFAULT_PI_SANDBOX_CONFIG.network.deniedDomains],
    },
    hostIPC: {
      mode: DEFAULT_PI_SANDBOX_CONFIG.hostIPC.mode,
      preflightCommandPrefixes: [
        ...DEFAULT_PI_SANDBOX_CONFIG.hostIPC.preflightCommandPrefixes,
      ],
      retryOnUnixSocketError:
        DEFAULT_PI_SANDBOX_CONFIG.hostIPC.retryOnUnixSocketError,
    },
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function readPiSandboxConfigFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw error;
    }
    throw new Error(`failed to read pi-sandbox configuration at ${path}`, {
      cause: error,
    });
  }
}

function parsePiSandboxConfigFile(path: string, source: string): PiSandboxConfig {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in pi-sandbox configuration at ${path}`, {
      cause: error,
    });
  }
  return parsePiSandboxConfig(value);
}

export function loadPiSandboxConfig(
  options: LoadPiSandboxConfigOptions = {},
): PiSandboxConfig {
  const path = options.path ?? getPiSandboxConfigPath(options.home);
  try {
    return parsePiSandboxConfigFile(path, readPiSandboxConfigFile(path));
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  // Only fall back to the legacy path when loading the default trusted location.
  if (options.path === undefined) {
    const legacyPath = getLegacyPiSandboxConfigPath(options.home);
    try {
      return parsePiSandboxConfigFile(
        legacyPath,
        readPiSandboxConfigFile(legacyPath),
      );
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  return defaultPiSandboxConfig();
}
