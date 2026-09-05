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
  | "redirection"
  | "relative_executable";

export type PolicyConfigCandidate = {
  surface: string;
  pattern?: string;
  action: "allow";
  safetyClass: "observed_bash_template" | "observed_surface";
  eligible: boolean;
  blocker?: string;
};

export type ClassifiedPermission = {
  surface: string;
  signature: string;
  bashCategory: string;
  risk: PolicyAuditRisk;
  pathClass: PolicyAuditPathClass;
  features: readonly PolicyAuditCommandFeature[];
  candidate?: PolicyConfigCandidate;
};

const SAFE_SURFACE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_COMMAND_WORD = /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,63}$/;
const SENSITIVE_PATH = /(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.npmrc|\.netrc|\.env(?:\.[^/\\]+)?|auth\.json|credentials?)(?:[/\\]|$)/i;

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
  if (!raw.startsWith("/") && !raw.startsWith("~") && !raw.startsWith(".")) return "unknown";
  const expanded = raw === "~" || raw.startsWith("~/") ? resolve(home, raw.slice(2)) : resolve(cwd, raw);
  if (within(expanded, resolve(cwd))) return "workspace";
  if (within(expanded, resolve(temp))) return "temp";
  if (within(expanded, resolve(home))) return "home";
  return "external";
}

function shellTokens(command: string): string[] {
  return command.trim().split(/\s+/u);
}

function normalizedPathToken(token: string): string {
  let value = token.replace(/^@/, "").replace(/[;)]+$/u, "");
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function firstExplicitPathToken(tokens: readonly string[]): string | undefined {
  return tokens
    .map(normalizedPathToken)
    .find((token) =>
      token.startsWith("/") ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      token.startsWith("~/")
    );
}

/**
 * Recover the path-bearing statement operands added to permission-system 31.
 * This remains deliberately conservative rather than pretending to be a shell
 * parser: case-arm patterns are excluded, while the actual path gate's
 * separate decision event still records paths found in arm/body commands.
 */
function statementOperandPathToken(
  tokens: readonly string[],
  index: number,
): { handled: boolean; token?: string } {
  const statement = tokens[index]?.replace(/^["']|["']$/gu, "");
  if (statement !== "for" && statement !== "select" && statement !== "case") {
    return { handled: false };
  }
  const inIndex = tokens.findIndex((token, tokenIndex) =>
    tokenIndex > index && token === "in"
  );
  if (inIndex < 0) return { handled: true };
  if (statement === "case") {
    return {
      handled: true,
      token: firstExplicitPathToken(tokens.slice(index + 1, inIndex)),
    };
  }
  const operands: string[] = [];
  for (const token of tokens.slice(inIndex + 1)) {
    if (token === "do") break;
    operands.push(token);
    if (/[;]$/u.test(token)) break;
  }
  return { handled: true, token: firstExplicitPathToken(operands) };
}

function executableIndex(tokens: readonly string[]): number {
  let index = 0;
  if (tokens[index] === "env") index++;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index] ?? "")) index++;
  return index;
}

function safeExecutable(token: string | undefined): string | undefined {
  if (!token || token.includes("/") || token.startsWith(".")) return undefined;
  const unquoted = token.replace(/^["']|["']$/g, "");
  return SAFE_COMMAND_WORD.test(unquoted) ? unquoted : undefined;
}

function reliableShellText(command: string): boolean {
  let quote = "";
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "'" || character === '"') {
      quote = character;
    }
  }
  return !quote && !escaped;
}

function sanitizedTemplateToken(token: string, followsOption: boolean): string {
  if (!token || /^['"]/.test(token) || /[/\\@]/.test(token) || /:\/\//.test(token)) return "*";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return "*";
  if (token.startsWith("--") && token.includes("=")) {
    const name = token.slice(0, token.indexOf("="));
    return /^--[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ? `${name}=*` : "*";
  }
  if (/^--?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(token)) return token;
  if (followsOption) return "*";
  return SAFE_COMMAND_WORD.test(token) ? token : "*";
}

function observedBashTemplate(tokens: readonly string[], index: number): string | undefined {
  const executable = safeExecutable(tokens[index]);
  if (!executable) return undefined;
  const template = [executable];
  let followsOption = false;
  for (const rawToken of tokens.slice(index + 1)) {
    const token = sanitizedTemplateToken(rawToken, followsOption);
    if (template.at(-1) !== "*" || token !== "*") template.push(token);
    followsOption = /^--?[A-Za-z0-9]/.test(rawToken) && !rawToken.includes("=");
  }
  return template.join(" ");
}

export function classifyBash(command: unknown, cwd: string): ClassifiedPermission {
  if (typeof command !== "string" || !command.trim()) {
    return { surface: "bash", signature: "<command>", bashCategory: "unknown", risk: "unknown", pathClass: "unknown", features: [] };
  }
  const tokens = shellTokens(command);
  const index = executableIndex(tokens);
  const features: PolicyAuditCommandFeature[] = [];
  if (index > 0) features.push("env_prefix");
  if (/&&|\|\||;|\n|`|\$\(/.test(command)) features.push("compound");
  if (/(^|[^|])\|([^|]|$)/.test(command)) features.push("pipeline");
  if (/[<>]/.test(command)) features.push("redirection");
  if (tokens[index]?.includes("/") || tokens[index]?.startsWith(".")) features.push("relative_executable");
  const uniqueFeatures = [...new Set(features)].sort();
  const structuralBoundary = command.search(/&&|\|\||[;|<>\n]|`|\$\(/);
  const templateTokens = shellTokens(structuralBoundary >= 0 ? command.slice(0, structuralBoundary) : command);
  const template = observedBashTemplate(templateTokens, executableIndex(templateTokens));
  let blocker: string | undefined;
  if (!reliableShellText(command) || !template) blocker = "command could not be templated reliably";
  else if (uniqueFeatures.length > 0) blocker = `unsafe command feature: ${uniqueFeatures.join(", ")}`;
  const candidate: PolicyConfigCandidate | undefined = template ? {
    surface: "bash",
    pattern: template,
    action: "allow",
    safetyClass: "observed_bash_template",
    eligible: blocker === undefined,
    ...(blocker ? { blocker } : {}),
  } : undefined;
  const statementOperand = statementOperandPathToken(tokens, index);
  const pathToken = statementOperand.handled
    ? statementOperand.token
    : firstExplicitPathToken(tokens.slice(index + 1));
  return {
    surface: "bash",
    signature: template ?? "<command>",
    bashCategory: uniqueFeatures.length === 0 ? "simple" : "structured",
    risk: uniqueFeatures.includes("compound") || uniqueFeatures.includes("pipeline")
      ? "arbitrary_shell"
      : uniqueFeatures.includes("redirection") ? "workspace_mutation" : "unknown",
    pathClass: classifyPath(pathToken, cwd),
    features: uniqueFeatures,
    ...(candidate ? { candidate } : {}),
  };
}

export function classifyPermission(surfaceValue: unknown, value: unknown, cwd: string): ClassifiedPermission {
  const suppliedSurface = typeof surfaceValue === "string" ? surfaceValue.trim() : "";
  const normalizedSurface = suppliedSurface.toLowerCase();
  if (normalizedSurface === "bash" || normalizedSurface === "bash_escalated") {
    const classified = classifyBash(value, cwd);
    if (normalizedSurface === "bash_escalated") {
      const { candidate: _candidate, ...statisticsOnly } = classified;
      return { ...statisticsOnly, surface: normalizedSurface };
    }
    return classified;
  }

  const validSurface = SAFE_SURFACE.test(suppliedSurface) ? suppliedSurface : undefined;
  const pathSurface = pathSurfaceInfo(normalizedSurface);
  const pathLike = pathSurface !== undefined || normalizedSurface === "read" || normalizedSurface === "write" || normalizedSurface === "edit";
  const pathClass = pathLike ? classifyPath(value, cwd) : "unknown";
  const risk = pathSurface?.effect === "read" || normalizedSurface === "read"
    ? "read_only"
    : pathSurface?.effect === "write" || normalizedSurface === "write" || normalizedSurface === "edit"
      ? "workspace_mutation"
      : "unknown";
  const candidate: PolicyConfigCandidate | undefined = validSurface ? {
    surface: validSurface,
    action: "allow",
    safetyClass: "observed_surface",
    eligible: true,
  } : undefined;
  return {
    surface: validSurface ?? "custom_tool",
    signature: validSurface ?? "<custom-tool>",
    bashCategory: "not_bash",
    risk,
    pathClass,
    features: [],
    ...(candidate ? { candidate } : {}),
  };
}
