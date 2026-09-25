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
    protection?: "native-background-tools";
    allowedNativeAgents?: readonly string[];
  };
  filesystem: {
    additionalAllowRead: readonly string[];
  };
  network: NetworkConfig;
  hostIPC: HostIPCConfig;
};

export type LoadPiSandboxConfigOptions = {
  path?: string;
  /** Override home directory when resolving default trusted paths. */
  home?: string;
  /** Override workspace directory when resolving project-level config path. */
  cwd?: string;
};

export const DEFAULT_PI_SANDBOX_CONFIG: Readonly<PiSandboxConfig> = Object.freeze(
  {
    subagents: Object.freeze({
      provider: "builtin",
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

export const PROJECT_PI_SANDBOX_CONFIG_PATH = join(
  ".pi",
  "extensions",
  "pi-sandbox",
  "config.json",
);

export function getProjectPiSandboxConfigPath(cwd = process.cwd()): string {
  return join(cwd, PROJECT_PI_SANDBOX_CONFIG_PATH);
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

export type PartialPiSandboxConfig = {
  subagents?: {
    provider?: SubagentProvider;
    protection?: "native-background-tools";
    allowedNativeAgents?: readonly string[];
  };
  filesystem?: {
    additionalAllowRead?: readonly string[];
  };
  network?: Partial<NetworkConfig>;
  hostIPC?: Partial<HostIPCConfig>;
};

export function parsePiSandboxConfigRaw(value: unknown): PartialPiSandboxConfig {
  if (!isRecord(value)) {
    throw new Error("invalid pi-sandbox configuration: root must be an object");
  }
  rejectUnknownKeys(
    value,
    ["subagents", "filesystem", "network", "hostIPC"],
    "root",
  );

  let parsedSubagents: PartialPiSandboxConfig["subagents"] | undefined;
  if (value.subagents !== undefined) {
    if (!isRecord(value.subagents)) {
      throw new Error(
        "invalid pi-sandbox configuration: subagents must be an object",
      );
    }
    rejectUnknownKeys(
      value.subagents,
      ["provider", "protection", "allowedNativeAgents"],
      "subagents",
    );
    const provider = value.subagents.provider;
    if (
      provider !== undefined &&
      (typeof provider !== "string" ||
        !SUBAGENT_PROVIDERS.includes(provider as SubagentProvider))
    ) {
      throw new Error(
        `invalid pi-sandbox configuration: subagents.provider must be one of ${SUBAGENT_PROVIDERS.join(", ")}`,
      );
    }
    const protection = value.subagents.protection;
    const allowedNativeAgents = value.subagents.allowedNativeAgents;
    if (provider === "pi-subagents" && protection !== "native-background-tools") {
      throw new Error(
        "invalid pi-sandbox configuration: provider 'pi-subagents' requires subagents.protection 'native-background-tools'; migrate legacy configurations explicitly",
      );
    }
    if (provider !== undefined && provider !== "pi-subagents" && (protection !== undefined || allowedNativeAgents !== undefined)) {
      throw new Error(
        "invalid pi-sandbox configuration: subagents.protection and allowedNativeAgents are only valid with provider 'pi-subagents'",
      );
    }
    if (provider === "pi-subagents") {
      if (!Array.isArray(allowedNativeAgents) || allowedNativeAgents.length === 0) {
        throw new Error(
          "invalid pi-sandbox configuration: subagents.allowedNativeAgents must be a non-empty array of canonical agent names",
        );
      }
      if (allowedNativeAgents.some((name) =>
        typeof name !== "string" ||
        name !== name.trim() ||
        !/^[A-Za-z0-9_.:-]+$/u.test(name)
      )) {
        throw new Error(
          "invalid pi-sandbox configuration: subagents.allowedNativeAgents must contain only canonical agent names",
        );
      }
      if (new Set(allowedNativeAgents).size !== allowedNativeAgents.length) {
        throw new Error(
          "invalid pi-sandbox configuration: subagents.allowedNativeAgents must not contain duplicates",
        );
      }
    }
    parsedSubagents = {
      ...(provider !== undefined ? { provider: provider as SubagentProvider } : {}),
      ...(provider === "pi-subagents"
        ? {
            protection: "native-background-tools" as const,
            allowedNativeAgents: [...(allowedNativeAgents as string[])],
          }
        : {}),
    };
  }

  let parsedFilesystem: PartialPiSandboxConfig["filesystem"] | undefined;
  if (value.filesystem !== undefined) {
    if (!isRecord(value.filesystem)) {
      throw new Error(
        "invalid pi-sandbox configuration: filesystem must be an object",
      );
    }
    rejectUnknownKeys(
      value.filesystem,
      ["additionalAllowRead"],
      "filesystem",
    );
    const additionalAllowRead = value.filesystem.additionalAllowRead;
    if (additionalAllowRead !== undefined) {
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
      parsedFilesystem = {
        additionalAllowRead: [...new Set(additionalAllowRead)],
      };
    } else {
      parsedFilesystem = {};
    }
  }

  let parsedNetwork: PartialPiSandboxConfig["network"] | undefined;
  if (value.network !== undefined) {
    if (!isRecord(value.network)) {
      throw new Error(
        "invalid pi-sandbox configuration: network must be an object",
      );
    }
    rejectUnknownKeys(
      value.network,
      ["allowedDomains", "deniedDomains"],
      "network",
    );
    const normalizeDomainList = (
      key: "allowedDomains" | "deniedDomains",
    ): string[] | undefined => {
      const configured = (value.network as Record<string, unknown>)[key];
      if (configured === undefined) return undefined;
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
    const allowed = normalizeDomainList("allowedDomains");
    const denied = normalizeDomainList("deniedDomains");
    parsedNetwork = {
      ...(allowed !== undefined ? { allowedDomains: allowed } : {}),
      ...(denied !== undefined ? { deniedDomains: denied } : {}),
    };
  }

  let parsedHostIPC: PartialPiSandboxConfig["hostIPC"] | undefined;
  if (value.hostIPC !== undefined) {
    if (!isRecord(value.hostIPC)) {
      throw new Error(
        "invalid pi-sandbox configuration: hostIPC must be an object",
      );
    }
    rejectUnknownKeys(
      value.hostIPC,
      ["mode", "preflightCommandPrefixes", "retryOnUnixSocketError"],
      "hostIPC",
    );
    const mode = value.hostIPC.mode;
    if (
      mode !== undefined &&
      (typeof mode !== "string" ||
        !HOST_IPC_MODES.includes(mode as HostIPCMode))
    ) {
      throw new Error(
        `invalid pi-sandbox configuration: hostIPC.mode must be one of ${HOST_IPC_MODES.join(", ")}`,
      );
    }
    const preflight = value.hostIPC.preflightCommandPrefixes;
    if (preflight !== undefined) {
      if (
        !Array.isArray(preflight) ||
        preflight.some(
          (prefix) => typeof prefix !== "string" || prefix.trim() === "",
        )
      ) {
        throw new Error(
          "invalid pi-sandbox configuration: hostIPC.preflightCommandPrefixes must be an array of non-empty strings",
        );
      }
    }
    const retry = value.hostIPC.retryOnUnixSocketError;
    if (retry !== undefined && typeof retry !== "boolean") {
      throw new Error(
        "invalid pi-sandbox configuration: hostIPC.retryOnUnixSocketError must be a boolean",
      );
    }
    parsedHostIPC = {
      ...(mode !== undefined ? { mode: mode as HostIPCMode } : {}),
      ...(preflight !== undefined
        ? {
            preflightCommandPrefixes: [
              ...new Set(preflight.map((prefix) => prefix.trim())),
            ],
          }
        : {}),
      ...(retry !== undefined ? { retryOnUnixSocketError: retry } : {}),
    };
  }

  return {
    ...(parsedSubagents !== undefined ? { subagents: parsedSubagents } : {}),
    ...(parsedFilesystem !== undefined ? { filesystem: parsedFilesystem } : {}),
    ...(parsedNetwork !== undefined ? { network: parsedNetwork } : {}),
    ...(parsedHostIPC !== undefined ? { hostIPC: parsedHostIPC } : {}),
  };
}

export function parsePiSandboxConfig(value: unknown): PiSandboxConfig {
  const raw = parsePiSandboxConfigRaw(value);
  const provider =
    raw.subagents?.provider ?? DEFAULT_PI_SANDBOX_CONFIG.subagents.provider;
  const isPiSubagents = provider === "pi-subagents";

  return {
    subagents: {
      provider,
      ...(isPiSubagents
        ? {
            protection: "native-background-tools" as const,
            allowedNativeAgents: [
              ...(raw.subagents?.allowedNativeAgents ?? []),
            ],
          }
        : {}),
    },
    filesystem: {
      additionalAllowRead: [
        ...(raw.filesystem?.additionalAllowRead ??
          DEFAULT_PI_SANDBOX_CONFIG.filesystem.additionalAllowRead),
      ],
    },
    network: {
      allowedDomains: [
        ...(raw.network?.allowedDomains ??
          DEFAULT_PI_SANDBOX_CONFIG.network.allowedDomains),
      ],
      deniedDomains: [
        ...(raw.network?.deniedDomains ??
          DEFAULT_PI_SANDBOX_CONFIG.network.deniedDomains),
      ],
    },
    hostIPC: {
      mode: raw.hostIPC?.mode ?? DEFAULT_PI_SANDBOX_CONFIG.hostIPC.mode,
      preflightCommandPrefixes: [
        ...(raw.hostIPC?.preflightCommandPrefixes ??
          DEFAULT_PI_SANDBOX_CONFIG.hostIPC.preflightCommandPrefixes),
      ],
      retryOnUnixSocketError:
        raw.hostIPC?.retryOnUnixSocketError ??
        DEFAULT_PI_SANDBOX_CONFIG.hostIPC.retryOnUnixSocketError,
    },
  };
}

function defaultPiSandboxConfig(): PiSandboxConfig {
  return {
    subagents: {
      provider: DEFAULT_PI_SANDBOX_CONFIG.subagents.provider,
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

function parsePiSandboxConfigFileRaw(path: string, source: string): PartialPiSandboxConfig {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in pi-sandbox configuration at ${path}`, {
      cause: error,
    });
  }
  return parsePiSandboxConfigRaw(value);
}

export function mergePiSandboxConfigs(
  trusted: PiSandboxConfig,
  project: PartialPiSandboxConfig,
): PiSandboxConfig {
  const provider = project.subagents?.provider ?? trusted.subagents.provider;
  const isPiSubagents = provider === "pi-subagents";

  let allowedNativeAgents: string[] | undefined;
  if (isPiSubagents) {
    const trustedAgents = trusted.subagents.allowedNativeAgents ?? [];
    const projectAgents = project.subagents?.allowedNativeAgents ?? [];
    allowedNativeAgents = [...new Set([...trustedAgents, ...projectAgents])];
  }

  return {
    subagents: {
      provider,
      ...(isPiSubagents
        ? {
            protection: "native-background-tools" as const,
            allowedNativeAgents,
          }
        : {}),
    },
    filesystem: {
      additionalAllowRead: [
        ...new Set([
          ...trusted.filesystem.additionalAllowRead,
          ...(project.filesystem?.additionalAllowRead ?? []),
        ]),
      ],
    },
    network: {
      allowedDomains: [
        ...new Set([
          ...trusted.network.allowedDomains,
          ...(project.network?.allowedDomains ?? []),
        ]),
      ],
      deniedDomains: [
        ...new Set([
          ...trusted.network.deniedDomains,
          ...(project.network?.deniedDomains ?? []),
        ]),
      ],
    },
    hostIPC: {
      mode: project.hostIPC?.mode ?? trusted.hostIPC.mode,
      preflightCommandPrefixes: [
        ...new Set([
          ...trusted.hostIPC.preflightCommandPrefixes,
          ...(project.hostIPC?.preflightCommandPrefixes ?? []),
        ]),
      ],
      retryOnUnixSocketError:
        project.hostIPC?.retryOnUnixSocketError ??
        trusted.hostIPC.retryOnUnixSocketError,
    },
  };
}

export function loadPiSandboxConfig(
  options: LoadPiSandboxConfigOptions = {},
): PiSandboxConfig {
  if (options.path !== undefined) {
    const path = options.path;
    try {
      return parsePiSandboxConfigFile(path, readPiSandboxConfigFile(path));
    } catch (error) {
      if (isNotFoundError(error)) {
        return defaultPiSandboxConfig();
      }
      throw error;
    }
  }

  const globalPath = getPiSandboxConfigPath(options.home);
  let globalConfig: PiSandboxConfig | undefined;
  try {
    globalConfig = parsePiSandboxConfigFile(
      globalPath,
      readPiSandboxConfigFile(globalPath),
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const projectPath = getProjectPiSandboxConfigPath(options.cwd);
  let projectRaw: PartialPiSandboxConfig | undefined;
  try {
    projectRaw = parsePiSandboxConfigFileRaw(
      projectPath,
      readPiSandboxConfigFile(projectPath),
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const base = globalConfig ?? defaultPiSandboxConfig();
  if (projectRaw) {
    return mergePiSandboxConfigs(base, projectRaw);
  }
  return base;
}
