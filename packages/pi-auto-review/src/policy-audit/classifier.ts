import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathSurfaceInfo } from "../path-surfaces.ts";

export type PolicyAuditRisk =
  | "read_only"
  | "workspace_mutation"
  | "project_code_execution"
  | "network"
  | "network_mutation"
  | "arbitrary_shell"
  | "unknown";

export type PolicyAuditPathClass =
  | "workspace"
  | "temp"
  | "home"
  | "external"
  | "sensitive"
  | "unknown";

export type PolicyAuditCommandFeature =
  | "env_prefix"
  | "compound"
  | "pipeline"
  | "relative_executable";

export type ClassifiedPermission = {
  surface: string;
  signature: string;
  bashCategory: string;
  risk: PolicyAuditRisk;
  pathClass: PolicyAuditPathClass;
  features: readonly PolicyAuditCommandFeature[];
};

const KNOWN_SURFACES = new Set([
  "bash",
  "bash_escalated",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "path",
  "external_directory",
  "path_read",
  "path_write",
  "external_directory_read",
  "external_directory_write",
  "skill",
  "mcp",
  "network",
]);

const SENSITIVE_PATH = /(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.npmrc|\.netrc|\.env(?:\.[^/\\]+)?|auth\.json|credentials?)(?:[/\\]|$)/i;
const READ_ONLY_COMMANDS = new Set([
  "cat", "find", "grep", "head", "ls", "pwd", "rg", "sed", "sort",
  "stat", "tail", "wc", "which",
]);
const MUTATING_COMMANDS = new Set([
  "chmod", "chown", "cp", "install", "ln", "mkdir", "mv", "rm", "rmdir",
  "touch", "truncate",
]);
const NETWORK_COMMANDS = new Set(["curl", "dig", "host", "nc", "ping", "ssh", "wget"]);
const SHELL_COMMANDS = new Set(["bash", "dash", "fish", "sh", "zsh"]);
const GIT_ACTIONS = new Set([
  "add", "branch", "checkout", "clean", "clone", "commit", "diff", "fetch",
  "log", "merge", "pull", "push", "rebase", "remote", "reset", "restore",
  "send-pack", "show", "status", "switch", "tag",
]);
const RTK_ACTIONS = new Set(["diff", "find", "grep", "ls", "read", "rg", "smart", "wc"]);
const PACKAGE_ACTIONS = new Set([
  "add", "build", "check", "coverage", "dev", "format", "install", "lint",
  "publish", "start", "test", "typecheck", "uninstall", "update", "upgrade",
]);

function within(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function classifyPath(
  value: unknown,
  cwd: string,
  home = homedir(),
  temp = tmpdir(),
): PolicyAuditPathClass {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const raw = value.trim();
  if (SENSITIVE_PATH.test(raw)) return "sensitive";
  if (!raw.startsWith("/") && !raw.startsWith("~") && !raw.startsWith(".")) {
    return "unknown";
  }
  const expanded = raw === "~" || raw.startsWith("~/")
    ? resolve(home, raw.slice(2))
    : resolve(cwd, raw);
  if (within(expanded, resolve(cwd))) return "workspace";
  if (within(expanded, resolve(temp))) return "temp";
  if (within(expanded, resolve(home))) return "home";
  return "external";
}

function shellTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

function executableIndex(tokens: readonly string[]): number {
  let index = 0;
  if (tokens[index] === "env") index++;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index++;
  }
  return index;
}

function safeCommandName(token: string | undefined): string {
  if (!token) return "unknown";
  const name = token.split(/[\\/]/).at(-1)?.toLowerCase() || "unknown";
  return /^[a-z0-9][a-z0-9+._-]{0,31}$/.test(name) ? name : "unknown";
}

function knownSignature(tokens: readonly string[], index: number): string {
  const executable = safeCommandName(tokens[index]);
  const sub = safeCommandName(tokens[index + 1]);
  const third = safeCommandName(tokens[index + 2]);
  if (executable === "rtk") {
    if (sub === "git") return `rtk:git:${GIT_ACTIONS.has(third) ? third : "other"}`;
    return `rtk:${RTK_ACTIONS.has(sub) ? sub : "other"}`;
  }
  if (executable === "git") return `git:${GIT_ACTIONS.has(sub) ? sub : "other"}`;
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const action = sub === "run" ? third : sub;
    return `${executable}:${PACKAGE_ACTIONS.has(action) ? action : "custom-script"}`;
  }
  if (READ_ONLY_COMMANDS.has(executable) || MUTATING_COMMANDS.has(executable) ||
      NETWORK_COMMANDS.has(executable) || SHELL_COMMANDS.has(executable)) {
    return executable;
  }
  if (tokens[index]?.includes("/") || tokens[index]?.startsWith(".")) {
    return "<path-command>";
  }
  return "<other-command>";
}

function commandRisk(signature: string, executable: string, command: string): PolicyAuditRisk {
  if (/&&|\|\||;|\n|`|\$\(|(^|[^|])\|([^|]|$)/.test(command)) return "arbitrary_shell";
  if (["git:push", "git:send-pack", "rtk:git:push", "rtk:git:send-pack"].includes(signature)) return "network_mutation";
  if (/^(?:npm|pnpm|yarn|bun):(install|publish|add|upgrade|update)$/.test(signature)) {
    return signature.endsWith(":publish") ? "network_mutation" : "project_code_execution";
  }
  if (/^(?:npm|pnpm|yarn|bun):/.test(signature)) return "project_code_execution";
  if (NETWORK_COMMANDS.has(executable)) {
    return /(?:^|\s)(?:--upload-file|-T|-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d)(?:\s|=|$)/i.test(command)
      ? "network_mutation"
      : "network";
  }
  if (MUTATING_COMMANDS.has(executable) || ["git:add", "git:commit", "git:reset", "git:clean", "git:checkout", "git:restore", "git:rebase", "rtk:git:add", "rtk:git:commit"].includes(signature)) {
    return "workspace_mutation";
  }
  if (READ_ONLY_COMMANDS.has(executable) || /^(?:rtk:)?git:(?:status|diff|log|show|branch)$/.test(signature)) {
    return "read_only";
  }
  if (SHELL_COMMANDS.has(executable) || signature === "<path-command>") {
    return "arbitrary_shell";
  }
  return "unknown";
}

export function classifyBash(command: unknown, cwd: string): ClassifiedPermission {
  if (typeof command !== "string" || !command.trim()) {
    return { surface: "bash", signature: "<other-command>", bashCategory: "unknown", risk: "unknown", pathClass: "unknown", features: [] };
  }
  const tokens = shellTokens(command);
  const index = executableIndex(tokens);
  const executable = safeCommandName(tokens[index]);
  const signature = knownSignature(tokens, index);
  const features: PolicyAuditCommandFeature[] = [];
  if (index > 0) features.push("env_prefix");
  if (/&&|\|\||;|\n|`|\$\(/.test(command)) features.push("compound");
  if (/(^|[^|])\|([^|]|$)/.test(command)) features.push("pipeline");
  if (tokens[index]?.includes("/") || tokens[index]?.startsWith(".")) features.push("relative_executable");
  const bashCategory = /^(?:rtk:)?git:/.test(signature)
    ? "version_control"
    : /^(?:npm|pnpm|yarn|bun):/.test(signature)
      ? "package_script"
      : NETWORK_COMMANDS.has(executable)
        ? "network"
        : READ_ONLY_COMMANDS.has(executable) || MUTATING_COMMANDS.has(executable)
          ? "filesystem"
          : "shell";
  const pathToken = tokens.slice(index + 1)
    .map((token) => token.includes("=") ? token.slice(token.indexOf("=") + 1) : token.replace(/^@/, ""))
    .find((token) => token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/"));
  return {
    surface: "bash",
    signature,
    bashCategory,
    risk: commandRisk(signature, executable, command),
    pathClass: classifyPath(pathToken, cwd),
    features: [...new Set(features)].sort(),
  };
}

export function classifyPermission(surfaceValue: unknown, value: unknown, cwd: string): ClassifiedPermission {
  const rawSurface = typeof surfaceValue === "string" ? surfaceValue.trim().toLowerCase() : "";
  if (rawSurface === "bash" || rawSurface === "bash_escalated") {
    const classified = classifyBash(value, cwd);
    return { ...classified, surface: rawSurface || "bash" };
  }
  const surface = KNOWN_SURFACES.has(rawSurface) ? rawSurface : "custom_tool";
  const pathSurface = pathSurfaceInfo(surface);
  if (pathSurface || ["read", "write", "edit"].includes(surface)) {
    const pathClass = classifyPath(value, cwd);
    const risk = pathSurface?.effect === "read" || surface === "read"
      ? "read_only"
      : pathSurface?.effect === "write" || surface === "write" || surface === "edit"
        ? "workspace_mutation"
        : "unknown";
    return { surface, signature: `<${surface}>`, bashCategory: "not_bash", risk, pathClass, features: [] };
  }
  if (["grep", "find", "ls"].includes(surface)) {
    return { surface, signature: `<${surface}>`, bashCategory: "not_bash", risk: "read_only", pathClass: "unknown", features: [] };
  }
  if (surface === "network") {
    return { surface, signature: "<network>", bashCategory: "not_bash", risk: "network", pathClass: "unknown", features: [] };
  }
  return {
    surface,
    signature: surface === "custom_tool" ? "<custom-tool>" : `<${surface}>`,
    bashCategory: "not_bash",
    risk: "unknown",
    pathClass: "unknown",
    features: [],
  };
}
