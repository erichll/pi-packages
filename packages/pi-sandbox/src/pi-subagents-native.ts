import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

export const PI_SUBAGENTS_VERSION = "0.65.0";
export const NATIVE_CHILD_TOOLS = ["bash", "read", "grep", "find", "ls"] as const;
export const PI_SANDBOX_ACKNOWLEDGEMENT = "@erichll:pi-sandbox";

type Agent = {
  name: string;
  localName?: string;
  runner?: { type?: unknown };
  disabled?: boolean;
  extensions?: string[];
  extensionsFromDefault?: boolean;
  allowNestedSubagents?: boolean;
};

type DiscoveryModule = {
  discoverAgents(cwd: string, scope: "both", preferredProvider?: string): {
    agents: Agent[];
  };
  resolveAgentName(name: string, agents: Agent[]): {
    agent?: Agent;
    error?: string;
  };
};

type ConfigModule = {
  loadConfig(): { scheduledRuns?: { enabled?: boolean } };
};

export type CapabilityCeilingHandle = { dispose(): void };
type CeilingModule = {
  SUBAGENT_CAPABILITY_CEILING_VERSION: unknown;
  registerSubagentCapabilityCeiling(options: {
    sessionId: string;
    source: string;
    ceiling: {
      allowedAgents: readonly string[];
      allowedTools: readonly string[];
    };
  }): CapabilityCeilingHandle;
};

export type PiSubagentsNativeRuntime = {
  validateAllowedAgents(
    cwd: string,
    preferredProvider?: string,
  ): string[];
  registerCeiling(sessionId: string, allowedAgents: readonly string[]): CapabilityCeilingHandle;
};

function requiredFunction(
  value: unknown,
  name: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`pi-subagents 0.65.0 compatibility failure: missing ${name}`);
  }
}

/**
 * Load the public ceiling API and the exact 0.65.0 discovery/config internals.
 * This intentionally fails closed on package version, export, or layout drift.
 */
export async function loadPiSubagentsNativeRuntime(
  configuredAgents: readonly string[],
): Promise<PiSubagentsNativeRuntime> {
  const entry = fileURLToPath(import.meta.resolve("pi-subagents"));
  const root = dirname(entry);
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { version?: unknown; exports?: Record<string, unknown> };
  if (packageJson.version !== PI_SUBAGENTS_VERSION) {
    throw new Error(
      `pi-subagents protected mode requires exactly ${PI_SUBAGENTS_VERSION}; found ${String(packageJson.version)}`,
    );
  }
  if (packageJson.exports?.["./capability-ceiling"] !== "./src/api/capability-ceiling.ts") {
    throw new Error(
      "pi-subagents 0.65.0 compatibility failure: capability-ceiling export changed",
    );
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: false,
    fsCache: false,
  });
  const [ceiling, discovery, config] = await Promise.all([
    jiti.import(pathToFileURL(join(root, "src/api/capability-ceiling.ts")).href) as Promise<CeilingModule>,
    jiti.import(pathToFileURL(join(root, "src/agents/agents.ts")).href) as Promise<DiscoveryModule>,
    jiti.import(pathToFileURL(join(root, "src/extension/config.ts")).href) as Promise<ConfigModule>,
  ]).catch((error) => {
    throw new Error(
      `pi-subagents 0.65.0 compatibility failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (ceiling.SUBAGENT_CAPABILITY_CEILING_VERSION !== 1) {
    throw new Error("pi-subagents 0.65.0 compatibility failure: unsupported capability ceiling version");
  }
  requiredFunction(ceiling.registerSubagentCapabilityCeiling, "registerSubagentCapabilityCeiling");
  requiredFunction(discovery.discoverAgents, "discoverAgents");
  requiredFunction(discovery.resolveAgentName, "resolveAgentName");
  requiredFunction(config.loadConfig, "loadConfig");

  const validateAllowedAgents = (
    cwd: string,
    preferredProvider?: string,
  ): string[] => {
    const upstreamConfig = config.loadConfig();
    if (upstreamConfig.scheduledRuns?.enabled !== false) {
      throw new Error(
        "pi-subagents protected mode requires scheduledRuns.enabled=false in the pi-subagents config",
      );
    }
    const discovered = discovery.discoverAgents(cwd, "both", preferredProvider);
    const canonical: string[] = [];
    for (const requested of configuredAgents) {
      const resolved = discovery.resolveAgentName(requested, discovered.agents);
      if (resolved.error) throw new Error(resolved.error);
      if (!resolved.agent) {
        throw new Error(`pi-subagents protected mode cannot resolve allowed agent '${requested}'`);
      }
      const agent = resolved.agent;
      if (agent.name !== requested) {
        throw new Error(
          `pi-subagents protected mode requires canonical agent names; '${requested}' resolves to '${agent.name}'`,
        );
      }
      if (agent.disabled === true) {
        throw new Error(`pi-subagents protected mode rejects disabled agent '${requested}'`);
      }
      if (agent.runner !== undefined && agent.runner.type !== "pi") {
        throw new Error(
          `pi-subagents protected mode rejects runner '${String(agent.runner.type)}' for agent '${requested}'`,
        );
      }
      if (agent.extensions !== undefined && agent.extensionsFromDefault !== true) {
        throw new Error(
          `pi-subagents protected mode requires ambient extensions for agent '${requested}'; remove its explicit extensions override`,
        );
      }
      if (agent.allowNestedSubagents === true) {
        throw new Error(
          `pi-subagents protected mode rejects allowNestedSubagents for agent '${requested}'`,
        );
      }
      canonical.push(agent.name);
    }
    return canonical;
  };

  // Validate once while constructing the adapter as an internal-structure gate.
  if (configuredAgents.length === 0) {
    throw new Error("pi-subagents protected mode requires at least one allowed agent");
  }
  return {
    validateAllowedAgents,
    registerCeiling(sessionId, allowedAgents) {
      return ceiling.registerSubagentCapabilityCeiling({
        sessionId,
        source: PI_SANDBOX_ACKNOWLEDGEMENT,
        ceiling: { allowedAgents, allowedTools: NATIVE_CHILD_TOOLS },
      });
    },
  };
}

export function nativeSubagentCallBlockReason(
  input: Record<string, unknown>,
): string | undefined {
  const action = typeof input.action === "string" ? input.action.trim() : undefined;
  if (action?.startsWith("schedule.")) {
    return "scheduled subagent operations are disabled in protected mode";
  }
  const forbiddenActions = new Set([
    "create", "update", "delete", "eject", "enable", "disable", "reset",
    "refine", "refine.rollback", "watchdog.configure", "grant-spawn-budget",
    "mission.create", "mission.update", "mission.resolve-decision",
    "mission.attach-run", "mission.close", "inspector.open", "inspector.close",
    "project.open", "project.close", "worktree.discard", "worktree.cleanup",
    "lane.recordMerge", "lane.recordSupersession",
  ]);
  if (action && forbiddenActions.has(action)) {
    return `subagent management action '${action}' is disabled in protected mode`;
  }
  if (action === "resume") {
    return "subagent resume may launch a child and is disabled in protected mode";
  }
  if (action !== undefined) return undefined;
  if (input.workflow !== undefined) {
    return "extension-owned named workflows are disabled in protected mode";
  }
  const isDirect = typeof input.agent === "string" && input.agent.trim() !== "";
  if (input.workflowScript !== undefined || input.workflowScriptPath !== undefined) {
    return "workflowScript and workflowScriptPath are disabled because pi-subagents 0.65.0 disables ambient extensions for their native children";
  }
  if (!isDirect) {
    return "protected mode supports only direct agent launches";
  }
  if (input.async !== true) {
    return "protected mode requires every child launch to set async: true explicitly";
  }
  return undefined;
}

export function hasSandboxAcknowledgement(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const acknowledgement = record.runtimeAcknowledgedExtensions;
  if (
    acknowledgement && typeof acknowledgement === "object" &&
    Array.isArray((acknowledgement as { ids?: unknown }).ids) &&
    (acknowledgement as { ids: unknown[] }).ids.includes(PI_SANDBOX_ACKNOWLEDGEMENT)
  ) return true;
  return Object.values(record).some((child) =>
    Array.isArray(child)
      ? child.some(hasSandboxAcknowledgement)
      : hasSandboxAcknowledgement(child)
  );
}

export function terminalChildrenHaveSandboxAcknowledgement(value: unknown): boolean {
  let foundTerminalChild = false;
  let missing = false;
  const visit = (candidate: unknown): void => {
    if (missing || !candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    const state = record.state ?? record.status;
    if (
      typeof record.agent === "string" &&
      ["completed", "failed", "stopped", "timed_out", "interrupted"].includes(String(state))
    ) {
      foundTerminalChild = true;
      if (!hasSandboxAcknowledgement({
        runtimeAcknowledgedExtensions: record.runtimeAcknowledgedExtensions,
      })) missing = true;
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return !foundTerminalChild || !missing;
}
