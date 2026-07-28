import {
  fork,
  type ChildProcess,
  type ForkOptions,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { NetworkEndpoint } from "./approval.ts";
import {
  createDefaultPolicy,
  toSandboxRuntimeConfig,
  type SandboxPolicy,
} from "./policy.ts";
import type {
  SandboxApprovalAction,
  SandboxApprovalTrap,
} from "./traps.ts";

export type SandboxCommandOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  onData(data: Buffer): void;
  onStdout?(data: Buffer): void;
  onStderr?(data: Buffer): void;
  /**
   * Kept for API compatibility with the approval adapter. Sandbox Runtime
   * does not expose a trustworthy filesystem ask callback, so filesystem
   * misses fail closed instead of reaching this callback.
   */
  review(trap: SandboxApprovalTrap): Promise<SandboxApprovalAction>;
  reviewDomain?(
    endpoint: NetworkEndpoint,
  ): Promise<SandboxApprovalAction>;
  policy?: SandboxPolicy;
  shellPath?: string;
  directInvocation?: {
    command: string;
    args: string[];
  };
  onStart?(stdin: Writable): void;
  /**
   * Test seam. Production callers leave this unset.
   */
  broker?: {
    modulePath: string;
    execArgv?: string[];
  };
  platform?: NodeJS.Platform;
};

type BrokerInitMessage = {
  type: "init";
  invocation: string[];
  runtimeConfig: SandboxRuntimeConfig;
};

type BrokerNetworkRequest = {
  type: "network-request";
  id: string;
  hostname: string;
  port: number;
};

type BrokerNetworkResponse = {
  type: "network-response";
  id: string;
  action: SandboxApprovalAction;
};

const BROKER_MODULE = fileURLToPath(
  new URL("./srt-broker.mjs", import.meta.url),
);

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function commandInvocation(options: SandboxCommandOptions): {
  argv: string[];
  commandFromStdin: boolean;
} {
  if (options.directInvocation) {
    return {
      argv: [
        options.directInvocation.command,
        ...options.directInvocation.args,
      ],
      commandFromStdin: false,
    };
  }
  const shell = getShellConfig(options.shellPath);
  const commandFromStdin = shell.commandTransport === "stdin";
  return {
    argv: commandFromStdin
      ? [shell.shell, ...shell.args]
      : [shell.shell, ...shell.args, options.command],
    commandFromStdin,
  };
}

function spawnBroker(options: SandboxCommandOptions): ChildProcess {
  const broker = options.broker ?? {
    modulePath: BROKER_MODULE,
    execArgv: [],
  };
  const forkOptions: ForkOptions = {
    cwd: options.cwd,
    detached: true,
    env: options.env ?? process.env,
    execArgv: broker.execArgv ?? [],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  };
  return fork(broker.modulePath, [], forkOptions);
}

export async function runSandboxedCommand(
  options: SandboxCommandOptions,
): Promise<{ exitCode: number | null }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`pi-sandbox does not support ${platform}`);
  }
  if (options.signal?.aborted) throw new Error("aborted");

  const invocation = commandInvocation(options);
  const policy = options.policy ?? createDefaultPolicy(options.cwd);
  const broker = spawnBroker(options);
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  let onAbort: (() => void) | undefined;

  try {
    broker.stdout?.on("data", (data: Buffer) => {
      options.onData(data);
      options.onStdout?.(data);
    });
    broker.stderr?.on("data", (data: Buffer) => {
      options.onData(data);
      options.onStderr?.(data);
    });
    broker.on("message", (message: unknown) => {
      if (!isNetworkRequest(message)) return;
      void answerNetworkRequest(broker, message, options);
    });

    const init: BrokerInitMessage = {
      type: "init",
      invocation: invocation.argv,
      runtimeConfig: toSandboxRuntimeConfig(policy),
    };
    broker.send?.(init);

    if (invocation.commandFromStdin) {
      broker.stdin?.on("error", () => undefined);
      broker.stdin?.end(options.command);
    } else if (options.directInvocation && broker.stdin) {
      broker.stdin.on("error", () => undefined);
      options.onStart?.(broker.stdin);
    } else {
      broker.stdin?.end();
    }

    onAbort = () => killProcessTree(broker);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(broker);
      }, options.timeout * 1_000);
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      broker.once("error", reject);
      broker.once("exit", resolve);
    });
    if (options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeout}`);
    return { exitCode };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (broker.exitCode === null && broker.signalCode === null) {
      killProcessTree(broker);
    }
  }
}

function isNetworkRequest(value: unknown): value is BrokerNetworkRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "network-request" &&
    typeof message.id === "string" &&
    typeof message.hostname === "string" &&
    typeof message.port === "number"
  );
}

async function answerNetworkRequest(
  broker: ChildProcess,
  request: BrokerNetworkRequest,
  options: SandboxCommandOptions,
): Promise<void> {
  let action: SandboxApprovalAction = "deny";
  try {
    action =
      (await options.reviewDomain?.({
        hostname: request.hostname,
        port: request.port,
        protocol: "tcp",
      })) ?? "deny";
  } catch (error) {
    options.onData(
      Buffer.from(
        `pi-sandbox: network approval failed for ${request.hostname}:${request.port}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
        "utf8",
      ),
    );
  }
  if (!broker.connected) return;
  const response: BrokerNetworkResponse = {
    type: "network-response",
    id: request.id,
    action,
  };
  broker.send?.(response);
}
