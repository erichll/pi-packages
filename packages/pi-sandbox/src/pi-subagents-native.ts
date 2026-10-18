import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import * as hostPiTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";

/**
 * Tested on pi-subagents 0.79.0 / Pi 1.3.0. Accept newer 0.x minors only
 * after validating the ceiling API, discovery, config, ownership and runtime
 * paths exports below. The ownership seam includes same-process session
 * succession; ownership alone is never proof that a worker was protected.
 * See docs/compat-notes.md for the compatibility and acceptance history.
 */
export const PI_SUBAGENTS_COMPAT_RANGE = ">=0.79.0";
export const NATIVE_CHILD_TOOLS = ["bash", "read", "grep", "find", "ls"] as const;
export const PI_SANDBOX_ACKNOWLEDGEMENT = "@erichll:pi-sandbox";

const HOST_PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** Host peer that pi-subagents' internal modules import but that is not installed next to it. */
const HOST_PI_TUI_PACKAGE = "@earendil-works/pi-tui";

/**
 * Module extension of the installed pi-subagents layout. Source checkouts (and
 * the 0.66.0-0.69.0 npm line) ship `.ts` modules that need a TypeScript loader;
 * the 0.70.0+ npm package ships compiled `.js` plus `.d.ts` declarations. Both
 * layouts keep the same package-relative module paths.
 */
export type PiSubagentsModuleExtension = ".ts" | ".js";

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

type RunOwnershipModule = {
  ownsRun(sessionId: string, ownerSessionId: string | undefined): boolean;
};

type RuntimePathsModule = { DIRS: { async: string } };

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
  /** Inspect runtime files, not model text; assumes their directory is trusted. */
  steeringTargetBlockReason(
    sessionId: string,
    runId: string,
    allowedAgents: readonly string[],
  ): Promise<string | undefined>;
};

function requiredFunction(
  value: unknown,
  name: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`pi-subagents compatibility failure: missing ${name}`);
  }
}

/**
 * Accept stable 0.x releases at or above the tested peer floor without
 * pulling in a semver runtime. Prereleases require explicit revalidation.
 */
export function isCompatiblePiSubagentsVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) >= 79;
}

function capabilityCeilingExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["default", "import", "require", "types"]) {
    const candidate = conditions[condition];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/**
 * Resolve the installed module extension from the `./capability-ceiling`
 * export, which every supported line publishes: a bare `.ts`/`.js` path before
 * 0.70.0, a `{ types, default }` condition map from 0.70.0 on. Only the known
 * `./src/api/capability-ceiling.<ext>` target is accepted; anything else fails
 * closed instead of guessing a layout.
 */
export function resolvePiSubagentsModuleExtension(
  exportsField: Record<string, unknown> | undefined,
): PiSubagentsModuleExtension {
  const target = capabilityCeilingExportTarget(exportsField?.["./capability-ceiling"]);
  const match = typeof target === "string"
    ? /^\.\/src\/api\/capability-ceiling(?:\.d)?\.(ts|js)$/u.exec(target)
    : null;
  if (!match) {
    throw new Error(
      "pi-subagents compatibility failure: capability-ceiling export changed",
    );
  }
  return match[1] === "js" ? ".js" : ".ts";
}

/**
 * Resolve a package-relative internal module path for the installed layout,
 * for example `src/agents/agents` on the compiled 0.70.0 line.
 */
export function piSubagentsInternalModulePath(
  relativePath: string,
  extension: PiSubagentsModuleExtension,
): string {
  return `${relativePath.replace(/\.(?:ts|js)$/u, "")}${extension}`;
}

async function readPackageName(dir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as { name?: unknown };
    return typeof manifest?.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from a Pi entry script (or a Pi package directory) to the running
 * `@earendil-works/pi-coding-agent` root. Returns undefined for launchers whose
 * entry is not a real file (compiled binaries, embedded SDK hosts).
 */
export async function findPiPackageRootFromEntry(
  entryPath: string,
): Promise<string | undefined> {
  let dir = entryPath;
  for (;;) {
    if ((await readPackageName(dir)) === HOST_PI_PACKAGE) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveFrom(base: string, specifier: string): string | undefined {
  try {
    return createRequire(base).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Alias map for the jiti instance that loads pi-subagents internals.
 *
 * pi-subagents imports `@earendil-works/pi-tui` from its internal modules but,
 * as a peer dependency, does not ship it. Pi's own extension loader aliases that
 * specifier to the copy inside the running Pi package (`getAliases()` in the
 * host loader), so extensions loaded by Pi resolve it; our jiti instance is a
 * separate resolver and would otherwise fall back to plain Node resolution,
 * which fails for installs where pi-tui is neither hoisted next to the
 * extension nor installed beside `@earendil-works/pi-subagents`.
 *
 * The alias is computed host-first so the loaded modules share the host's
 * pi-tui instance, and degrades to an empty map when no copy is reachable: the
 * hard failure then stays the explicit compatibility error raised on load.
 */
export async function resolvePiSubagentsHostAliases(
  options: { entry?: string; moduleUrl?: string; env?: Record<string, string | undefined> } = {},
): Promise<Record<string, string>> {
  const bases: string[] = [];
  const entry = options.entry ?? process.argv[1];
  if (entry) {
    const realEntry = await realpath(entry).catch(() => undefined);
    const root = realEntry
      ? await findPiPackageRootFromEntry(realEntry)
      : undefined;
    if (root) bases.push(join(root, "package.json"));
  }
  const packageDir = (options.env ?? process.env).PI_PACKAGE_DIR?.trim();
  if (packageDir && (await readPackageName(packageDir)) === HOST_PI_PACKAGE) {
    bases.push(join(packageDir, "package.json"));
  }
  // Extension-local resolution: the development checkout and installs that
  // provide pi-tui beside the extension or beside pi-subagents.
  bases.push(options.moduleUrl ?? import.meta.url);

  const seen = new Set<string>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    const resolved = resolveFrom(base, HOST_PI_TUI_PACKAGE);
    if (!resolved) continue;
    const target = await realpath(resolved).catch(() => resolved);
    return { [HOST_PI_TUI_PACKAGE]: target };
  }
  return {};
}

/** Load the public ceiling API and the discovery/config internals.
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
  if (!isCompatiblePiSubagentsVersion(packageJson.version)) {
    throw new Error(
      `pi-subagents protected mode requires ${PI_SUBAGENTS_COMPAT_RANGE}; found ${String(packageJson.version)}`,
    );
  }
  const extension = resolvePiSubagentsModuleExtension(packageJson.exports);

  // Pi's outer extension loader supplies these host modules, including embedded
  // copies in compiled Bun builds. Static imports above keep host resolution in
  // that outer loader even under plain `bun cli.js`. Filesystem aliases cannot
  // locate modules that only exist inside Pi.
  const resolutionOptions = process.versions.bun
    ? {
        tryNative: false,
        virtualModules: {
          [HOST_PI_TUI_PACKAGE]: hostPiTui,
          typebox: hostTypebox,
        },
      }
    : { alias: await resolvePiSubagentsHostAliases() };
  const jiti = createJiti(import.meta.url, {
    interopDefault: false,
    fsCache: false,
    ...resolutionOptions,
  });
  const internal = (relative: string): string =>
    pathToFileURL(join(root, piSubagentsInternalModulePath(relative, extension))).href;
  const [ceiling, discovery, config, ownership, paths] = await Promise.all([
    jiti.import(internal("src/api/capability-ceiling")) as Promise<CeilingModule>,
    jiti.import(internal("src/agents/agents")) as Promise<DiscoveryModule>,
    jiti.import(internal("src/extension/config")) as Promise<ConfigModule>,
    jiti.import(internal("src/runs/shared/run-ownership")) as Promise<RunOwnershipModule>,
    jiti.import(internal("src/shared/types")) as Promise<RuntimePathsModule>,
  ]).catch((error) => {
    throw new Error(
      `pi-subagents compatibility failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (ceiling.SUBAGENT_CAPABILITY_CEILING_VERSION !== 1) {
    throw new Error("pi-subagents compatibility failure: unsupported capability ceiling version");
  }
  requiredFunction(ceiling.registerSubagentCapabilityCeiling, "registerSubagentCapabilityCeiling");
  requiredFunction(discovery.discoverAgents, "discoverAgents");
  requiredFunction(discovery.resolveAgentName, "resolveAgentName");
  requiredFunction(config.loadConfig, "loadConfig");
  requiredFunction(ownership.ownsRun, "ownsRun");
  if (typeof paths.DIRS?.async !== "string" || !paths.DIRS.async) {
    throw new Error("pi-subagents compatibility failure: missing async runtime root");
  }

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
    async steeringTargetBlockReason(sessionId, runId, allowedAgents) {
      try {
        // A complete id only: never accept prefixes, caller-selected directories,
        // symlinks, or a path outside the upstream runtime's async root.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) {
          return "protected steering requires a complete native run id";
        }
        const root = await realpath(paths.DIRS.async);
        const runDir = join(root, runId);
        if (!(await lstat(runDir)).isDirectory() || await realpath(runDir) !== runDir) {
          return "protected steering rejects a linked or invalid run directory";
        }
        const statusPath = join(runDir, "status.json");
        if (!(await lstat(statusPath)).isFile()) {
          return "protected steering rejects a linked or invalid status file";
        }
        const status: unknown = JSON.parse(await readFile(statusPath, "utf8"));
        return nativeSteeringStatusBlockReason(status, runId, allowedAgents, (owner) =>
          ownership.ownsRun(sessionId, owner),
        );
      } catch {
        return "protected steering cannot verify the target's sandbox runtime proof; inspect or stop it instead";
      }
    },
  };
}

export function nativeSubagentCallBlockReason(
  input: Record<string, unknown>,
): string | undefined {
  if (input.action !== undefined && typeof input.action !== "string") {
    return "protected mode requires a string action";
  }
  const action = typeof input.action === "string" ? input.action.trim() : undefined;
  if (action?.startsWith("schedule.")) {
    return "scheduled subagent operations are disabled in protected mode";
  }
  if (action === "resume") {
    return "subagent resume may launch a child and is disabled in protected mode";
  }
  if (action !== undefined) {
    // New upstream actions must be reviewed explicitly, not admitted by default.
    const allowedActions = new Set([
      "list", "get", "status", "debug.run", "models", "guide", "validate",
      "stop", "interrupt", "dismiss", "steer",
    ]);
    if (!allowedActions.has(action)) {
      return `subagent management action '${action}' is disabled in protected mode`;
    }
    if (action === "steer") {
      const options = input.options;
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
        return "protected steering requires an options object";
      }
      const nested = (options ?? {}) as Record<string, unknown>;
      if ((input.steeringRecovery ?? nested.steeringRecovery) !== false ||
          input.steeringRecovery === true || nested.steeringRecovery === true) {
        return "protected steering requires steeringRecovery: false; implicit resume is disabled";
      }
      if (input.dir !== undefined || nested.dir !== undefined) {
        return "protected steering requires a complete run id, not dir";
      }
      if (input.id !== undefined && input.runId !== undefined && input.id !== input.runId) {
        return "protected steering rejects conflicting id and runId";
      }
      const id = input.id ?? input.runId;
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
        return "protected steering requires a complete native run id";
      }
      if ((input.index !== undefined && input.index !== 0) ||
          (nested.index !== undefined && nested.index !== 0)) {
        return "protected steering supports only the direct run's single child";
      }
    }
    return undefined;
  }
  if (input.workflow !== undefined) {
    return "extension-owned named workflows are disabled in protected mode";
  }
  const isDirect = typeof input.agent === "string" && input.agent.trim() !== "";
  if (input.workflowScript !== undefined || input.workflowScriptPath !== undefined) {
    return "workflowScript and workflowScriptPath are disabled because pi-subagents disables ambient extensions for their native children";
  }
  if (!isDirect) {
    return "protected mode supports only direct agent launches";
  }
  if (input.async !== true) {
    return "protected mode requires every child launch to set async: true explicitly";
  }
  return undefined;
}

/**
 * Cross-check current/inherited run metadata. This is best-effort evidence,
 * not attestation against host-side writers that can forge the status file.
 */
export function nativeSteeringStatusBlockReason(
  value: unknown,
  runId: string,
  allowedAgents: readonly string[],
  ownsRun: (ownerSessionId: string) => boolean,
): string | undefined {
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : undefined;
  const status = record(value);
  if (!status || status.runId !== runId || typeof status.sessionId !== "string" ||
      !ownsRun(status.sessionId)) {
    return "protected steering target is not owned by this session or its in-process predecessors";
  }
  if (status.mode !== "single" || status.state !== "running" ||
      !Array.isArray(status.steps) || status.steps.length !== 1) {
    return "protected steering requires a running direct single-child run";
  }
  const step = record(status.steps[0]);
  if (!step || step.status !== "running" || typeof step.agent !== "string" ||
      !allowedAgents.includes(step.agent)) {
    return "protected steering target is not a currently allowed running native agent";
  }
  const ceiling = record(status.capabilityCeiling);
  const acknowledgement = record(step.runtimeAcknowledgedExtensions);
  if (!ceiling || ceiling.version !== 1 || ceiling.denyExtensions !== false ||
      !Array.isArray(ceiling.sources) || !ceiling.sources.includes(PI_SANDBOX_ACKNOWLEDGEMENT) ||
      !Array.isArray(ceiling.allowedTools) || ceiling.allowedTools.length === 0 ||
      !ceiling.allowedTools.every((tool) => (NATIVE_CHILD_TOOLS as readonly unknown[]).includes(tool)) ||
      !Array.isArray(ceiling.allowedAgents) || !ceiling.allowedAgents.includes(step.agent) ||
      !acknowledgement || acknowledgement.version !== 1 ||
      acknowledgement.source !== "child-runtime" || !Array.isArray(acknowledgement.ids) ||
      !acknowledgement.ids.includes(PI_SANDBOX_ACKNOWLEDGEMENT)) {
    return "protected steering target lacks its own sandbox ceiling and runtime acknowledgement; inspect or stop it instead";
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
