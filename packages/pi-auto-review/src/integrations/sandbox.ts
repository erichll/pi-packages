import type { BoundaryRequest } from "../broker/types.ts";

export type SandboxFilesystemTrap = {
  kind: "filesystem";
  operation: "read" | "write";
  path: string;
  requested_path?: string;
  reason?: string;
  query_id?: string;
  process?: {
    pid?: number;
    exe?: string | null;
    cwd?: string | null;
  };
};

export type SandboxNetworkTrap = {
  kind: "network";
  operation: "connect" | "bind";
  target: string;
  query_id?: string;
  process?: {
    pid?: number;
    exe?: string | null;
    cwd?: string | null;
  };
};

export type SandboxBoundaryTrap =
  | SandboxFilesystemTrap
  | SandboxNetworkTrap;

export type SandboxRequestContext = {
  command?: string;
  cwd: string;
  agentName?: string;
};

export function parseHostPort(target: string | undefined): {
  host: string;
  port: number | undefined;
} | undefined {
  if (!target) return undefined;
  const lastColon = target.lastIndexOf(":");
  if (lastColon <= 0) return { host: target, port: undefined };
  const portStr = target.slice(lastColon + 1);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { host: target, port: undefined };
  }
  return { host: target.slice(0, lastColon), port };
}

export function sandboxTrapToBoundaryRequest(
  trap: SandboxBoundaryTrap,
  context: SandboxRequestContext,
): BoundaryRequest {
  const processSuffix =
    trap.process?.pid === undefined ? "" : `:${trap.process.pid}`;
  const id = trap.query_id
    ? `sandbox-runtime:${trap.query_id}`
    : `sandbox-runtime:${trap.kind}:${trap.operation}${processSuffix}`;
  if (trap.kind === "filesystem") {
    return {
      id,
      source: "sandbox-runtime",
      surface:
        trap.operation === "read"
          ? "filesystem-read"
          : "filesystem-write",
      operation: trap.operation,
      cwd: trap.process?.cwd || context.cwd,
      command: context.command,
      path: trap.requested_path || trap.path,
      resolvedPath: trap.path,
      toolName: trap.process?.exe || undefined,
      agentName: context.agentName,
      matchedPolicy: {
        decision: "ask",
        rule: trap.reason,
      },
    };
  }
  const parsed = parseHostPort(trap.target);
  return {
    id,
    source: "sandbox-runtime",
    surface: "network",
    operation: trap.operation,
    cwd: trap.process?.cwd || context.cwd,
    command: context.command,
    destination: trap.target,
    destinationHost: parsed?.host,
    destinationPort: parsed?.port,
    toolName: trap.process?.exe || undefined,
    agentName: context.agentName,
    matchedPolicy: { decision: "ask" },
  };
}
