import type { HostIPCConfig } from "./config.ts";
import type { TrapApprovalResult } from "./approval.ts";

const MAX_STDERR_BYTES = 64 * 1024;
const SUBAGENT_DEPTH_ENV = "PI_SANDBOX_SUBAGENT_DEPTH";

export type HostIPCTrigger =
  | {
      reason: "preflight-prefix";
      rule: string;
    }
  | {
      reason: "unix-socket-eperm";
      rule: "unix-socket-eperm";
    };

type CommandResult = { exitCode: number | null };

export type HostIPCCommandOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  onData(data: Buffer): void;
  config: HostIPCConfig;
  approve(trigger: HostIPCTrigger): Promise<TrapApprovalResult>;
  runSandbox(onStderr: (data: Buffer) => void): Promise<CommandResult>;
  runHost(timeout: number | undefined): Promise<CommandResult>;
  now?: () => number;
};

export function matchingPreflightPrefix(
  command: string,
  prefixes: readonly string[],
): string | undefined {
  const trimmed = command.trim();
  return prefixes.find(
    (prefix) =>
      trimmed.startsWith(prefix) &&
      (trimmed.length === prefix.length ||
        /\s/.test(trimmed.charAt(prefix.length))),
  );
}

export function isUnixSocketPermissionError(stderr: Buffer | string): boolean {
  const text = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  return (
    /operation not permitted/i.test(text) &&
    /socket|connect(?:ing)?|ipc/i.test(text)
  );
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= MAX_STDERR_BYTES) {
    return chunk.subarray(chunk.length - MAX_STDERR_BYTES);
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= MAX_STDERR_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_STDERR_BYTES);
}

function isBuiltinSubagent(env: NodeJS.ProcessEnv | undefined): boolean {
  return Number(env?.[SUBAGENT_DEPTH_ENV] ?? process.env[SUBAGENT_DEPTH_ENV]) > 0;
}

function remainingTimeout(
  timeout: number | undefined,
  startedAt: number,
  now: () => number,
): number | undefined {
  if (timeout === undefined) return undefined;
  const remaining = timeout - (now() - startedAt) / 1_000;
  if (remaining <= 0) throw new Error(`timeout:${timeout}`);
  return remaining;
}

function refusal(options: HostIPCCommandOptions, reason?: string): CommandResult {
  options.onData(
    Buffer.from(
      `pi-sandbox: host-IPC execution denied${reason ? `: ${reason}` : ""}\n`,
      "utf8",
    ),
  );
  return { exitCode: 1 };
}

export async function runCommandWithHostIPC(
  options: HostIPCCommandOptions,
): Promise<CommandResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const enabled = options.config.mode === "ask";
  const prefix = enabled
    ? matchingPreflightPrefix(
        options.command,
        options.config.preflightCommandPrefixes,
      )
    : undefined;

  if (prefix !== undefined) {
    if (isBuiltinSubagent(options.env)) {
      return refusal(
        options,
        "builtin subagents do not support host forwarding",
      );
    }
    const approval = await options.approve({
      reason: "preflight-prefix",
      rule: prefix,
    });
    if (approval.action === "deny") {
      return refusal(options, approval.reason);
    }
    return options.runHost(
      remainingTimeout(options.timeout, startedAt, now),
    );
  }

  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const sandboxResult = await options.runSandbox((data) => {
    stderr = appendBounded(stderr, data);
  });
  if (
    !enabled ||
    !options.config.retryOnUnixSocketError ||
    sandboxResult.exitCode === 0 ||
    sandboxResult.exitCode === null ||
    options.signal?.aborted ||
    !isUnixSocketPermissionError(stderr)
  ) {
    return sandboxResult;
  }
  if (isBuiltinSubagent(options.env)) {
    options.onData(
      Buffer.from(
        "pi-sandbox: host-IPC retry refused: builtin subagents do not support host forwarding\n",
        "utf8",
      ),
    );
    return sandboxResult;
  }

  const approval = await options.approve({
    reason: "unix-socket-eperm",
    rule: "unix-socket-eperm",
  });
  if (approval.action === "deny") return sandboxResult;

  options.onData(
    Buffer.from(
      "\n--- pi-sandbox: approved host-IPC retry (outside OS sandbox) ---\n",
      "utf8",
    ),
  );
  return options.runHost(
    remainingTimeout(options.timeout, startedAt, now),
  );
}
