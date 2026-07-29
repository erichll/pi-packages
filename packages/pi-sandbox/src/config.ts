import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SUBAGENT_PROVIDERS = [
  "builtin",
  "pi-subagents",
  "off",
] as const;

export type SubagentProvider = (typeof SUBAGENT_PROVIDERS)[number];

export type PiSandboxConfig = {
  subagents: {
    provider: SubagentProvider;
  };
  filesystem: {
    additionalAllowRead: readonly string[];
  };
};

export type LoadPiSandboxConfigOptions = {
  path?: string;
};

export const DEFAULT_PI_SANDBOX_CONFIG: Readonly<PiSandboxConfig> = Object.freeze(
  {
    subagents: Object.freeze({
      provider: "builtin",
    }),
    filesystem: Object.freeze({
      additionalAllowRead: Object.freeze([]),
    }),
  },
);

export function getPiSandboxConfigPath(home = homedir()): string {
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

export function parsePiSandboxConfig(value: unknown): PiSandboxConfig {
  if (!isRecord(value)) {
    throw new Error("invalid pi-sandbox configuration: root must be an object");
  }
  rejectUnknownKeys(value, ["subagents", "filesystem"], "root");

  if (value.subagents !== undefined && !isRecord(value.subagents)) {
    throw new Error(
      "invalid pi-sandbox configuration: subagents must be an object",
    );
  }
  const subagents = value.subagents ?? {};
  rejectUnknownKeys(subagents, ["provider"], "subagents");

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

  return {
    subagents: {
      provider: provider as SubagentProvider,
    },
    filesystem: {
      additionalAllowRead: [...new Set(additionalAllowRead)],
    },
  };
}

export function loadPiSandboxConfig(
  options: LoadPiSandboxConfigOptions = {},
): PiSandboxConfig {
  const path = options.path ?? getPiSandboxConfigPath();
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        subagents: { provider: DEFAULT_PI_SANDBOX_CONFIG.subagents.provider },
        filesystem: {
          additionalAllowRead: [
            ...DEFAULT_PI_SANDBOX_CONFIG.filesystem.additionalAllowRead,
          ],
        },
      };
    }
    throw new Error(`failed to read pi-sandbox configuration at ${path}`, {
      cause: error,
    });
  }

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
