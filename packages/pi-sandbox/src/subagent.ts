import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { NetworkEndpoint } from "./approval.ts";
import {
  runSandboxedCommand,
  type SandboxCommandOptions,
} from "./runner.ts";
import type {
  SandboxApprovalAction,
  SandboxApprovalTrap,
} from "./traps.ts";

export type ProcessInvocation = {
  command: string;
  args: string[];
};

export type ProcessBackedSubagentOptions = {
  task: string;
  cwd: string;
  model?: string;
  tools?: string[];
  signal?: AbortSignal;
  timeout?: number;
  invocation?: ProcessInvocation;
  env?: NodeJS.ProcessEnv;
  review(trap: SandboxApprovalTrap): Promise<SandboxApprovalAction>;
  reviewDomain(endpoint: NetworkEndpoint): Promise<SandboxApprovalAction>;
  onUpdate?(text: string): void;
  policy?: SandboxCommandOptions["policy"];
  sandbox?: Pick<SandboxCommandOptions, "platform" | "broker">;
};

export type ProcessBackedSubagentResult = {
  exitCode: number | null;
  text: string;
  rawOutput: string;
};

export type ProcessBackedSubagentSessionState =
  | "starting"
  | "running"
  | "idle"
  | "failed"
  | "stopped";

export type ProcessBackedSubagentSessionInfo = {
  id: string;
  parentId?: string;
  depth: number;
  state: ProcessBackedSubagentSessionState;
  task: string;
  text: string;
  error?: string;
};

type RpcResponse = {
  id?: string;
  type: "response";
  success: boolean;
  error?: string;
};

type PendingRpc = {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  type: "get_state" | "prompt" | "follow_up" | "abort";
  line: string;
};

type SettledWaiter = {
  target: number;
  resolve(result: ProcessBackedSubagentResult): void;
  reject(error: Error): void;
  cleanup(): void;
};

export type ProcessBackedSubagentSessionOptions = Omit<
  ProcessBackedSubagentOptions,
  "task" | "signal" | "onUpdate"
> & {
  id?: string;
  task: string;
  parentId?: string;
  depth?: number;
  rpcTimeoutMs?: number;
};

export type ProcessBackedSubagentManagerOptions = {
  maxConcurrency?: number;
  maxDepth?: number;
  invocation?: ProcessInvocation;
};

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const SUBAGENT_DEPTH_ENV = "PI_SANDBOX_SUBAGENT_DEPTH";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolvePiInvocation(): ProcessInvocation {
  const currentEntry = process.argv[1];
  if (
    currentEntry &&
    /(?:^|[/\\])cli\.(?:js|mjs|cjs|ts)$/.test(currentEntry)
  ) {
    return { command: process.execPath, args: [currentEntry] };
  }
  const packageEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  return {
    command: process.execPath,
    args: [join(dirname(packageEntry), "cli.js")],
  };
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return "";
  return record.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const content = part as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string"
        ? [content.text]
        : [];
    })
    .join("\n")
    .trim();
}

export function finalAssistantText(output: string): string {
  let final = "";
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "message_end" && event.message) {
        const text = assistantText(event.message);
        if (text) final = text;
      }
    } catch {
      // stderr and non-protocol output remain available in rawOutput.
    }
  }
  return final;
}

function rpcAssistantText(event: Record<string, unknown>): string {
  return event.type === "message_end" && event.message
    ? assistantText(event.message)
    : "";
}

function sessionResult(
  text: string,
  rawOutput: string,
): ProcessBackedSubagentResult {
  return { exitCode: 0, text, rawOutput };
}

export class ProcessBackedSubagentSession {
  readonly id: string;
  readonly parentId?: string;
  readonly depth: number;
  readonly task: string;

  private stateValue: ProcessBackedSubagentSessionState = "starting";
  private textValue = "";
  private errorValue: string | undefined;
  private rawOutput = "";
  private stderr = "";
  private stdoutBuffer = "";
  private stdin: Writable | undefined;
  private rpcSequence = 0;
  private settledCount = 0;
  private requestedSettlements = 0;
  private activePrompt:
    | {
        message: string;
        target: number;
      }
    | undefined;
  private pending = new Map<string, PendingRpc>();
  private waiters = new Set<SettledWaiter>();
  private updates = new Set<(text: string) => void>();
  private readonly controller = new AbortController();
  private completion: Promise<void> | undefined;
  private readonly options: ProcessBackedSubagentSessionOptions;
  private startReady:
    | {
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;

  constructor(options: ProcessBackedSubagentSessionOptions) {
    this.options = options;
    this.id = options.id ?? randomUUID();
    this.parentId = options.parentId;
    this.depth = options.depth ?? 1;
    this.task = options.task;
  }

  get info(): ProcessBackedSubagentSessionInfo {
    return {
      id: this.id,
      parentId: this.parentId,
      depth: this.depth,
      state: this.stateValue,
      task: this.task,
      text: this.textValue,
      ...(this.errorValue ? { error: this.errorValue } : {}),
    };
  }

  onUpdate(listener: (text: string) => void): () => void {
    this.updates.add(listener);
    return () => this.updates.delete(listener);
  }

  async start(): Promise<void> {
    if (this.completion) throw new Error(`subagent session ${this.id} already started`);
    const invocation = this.options.invocation ?? resolvePiInvocation();
    const args = [
      ...invocation.args,
      "--mode",
      "rpc",
      "--no-session",
    ];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.tools && this.options.tools.length > 0) {
      args.push("--tools", this.options.tools.join(","));
    }
    const ready = new Promise<void>((resolve, reject) => {
      this.startReady = { resolve, reject };
    });
    const envDepth = String(this.depth);
    const run = runSandboxedCommand({
      command: `process-backed subagent rpc ${this.id}`,
      cwd: this.options.cwd,
      env: {
        ...(this.options.env ?? process.env),
        [SUBAGENT_DEPTH_ENV]: envDepth,
      },
      signal: this.controller.signal,
      timeout: this.options.timeout,
      policy: this.options.policy,
      ...this.options.sandbox,
      directInvocation: { command: invocation.command, args },
      review: this.options.review,
      reviewDomain: this.options.reviewDomain,
      onData() {},
      onStdout: (data) => this.consumeStdout(data),
      onStderr: (data) => {
        this.stderr += data.toString("utf8");
      },
      onStart: (stdin) => this.handleSandboxStart(stdin),
    });
    this.completion = run.then(
      (result) => {
        if (this.stateValue !== "stopped") {
          const error = new Error(
            `subagent session ${this.id} exited with ${result.exitCode}: ${this.stderr.trim()}`,
          );
          this.fail(error);
        }
      },
      (error: unknown) => {
        if (this.stateValue === "stopped" && this.controller.signal.aborted) return;
        this.fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
    await ready;
    await this.send("get_state");
    this.stateValue = "idle";
  }

  async prompt(message: string): Promise<number> {
    this.ensureActive();
    return this.queuePrompt("prompt", message);
  }

  async followUp(message: string): Promise<number> {
    this.ensureActive();
    return this.queuePrompt("follow_up", message);
  }

  async abort(): Promise<void> {
    this.ensureActive();
    await this.send("abort");
  }

  waitForSettled(
    target = this.requestedSettlements,
    signal?: AbortSignal,
  ): Promise<ProcessBackedSubagentResult> {
    if (this.stateValue === "failed") {
      return Promise.reject(new Error(this.errorValue ?? "subagent session failed"));
    }
    if (this.stateValue === "stopped") {
      return Promise.reject(new Error(`subagent session ${this.id} is stopped`));
    }
    if (this.settledCount >= target) {
      return Promise.resolve(sessionResult(this.textValue, this.rawOutput));
    }
    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: SettledWaiter = {
        target,
        resolve,
        reject,
        cleanup: () => {
          this.waiters.delete(waiter);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        },
      };
      onAbort = () => {
        waiter.cleanup();
        reject(new Error("aborted"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.stateValue === "stopped") return;
    this.stateValue = "stopped";
    this.controller.abort();
    this.stdin?.end();
    const error = new Error(`subagent session ${this.id} stopped`);
    this.rejectPending(error);
    this.rejectWaiters(error);
    await this.completion;
  }

  private ensureActive(): void {
    if (this.stateValue === "failed") {
      throw new Error(this.errorValue ?? `subagent session ${this.id} failed`);
    }
    if (this.stateValue === "stopped") {
      throw new Error(`subagent session ${this.id} is stopped`);
    }
  }

  private async send(
    type: "get_state" | "prompt" | "follow_up" | "abort",
    fields: Record<string, unknown> = {},
  ): Promise<RpcResponse> {
    const stdin = this.stdin;
    if (!stdin?.writable || stdin.destroyed) {
      throw new Error(`subagent session ${this.id} RPC stdin is unavailable`);
    }
    const id = `${this.id}:${++this.rpcSequence}`;
    const line = `${JSON.stringify({ id, type, ...fields })}\n`;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `timeout waiting for subagent RPC ${type}: ${this.stderr.trim()}`,
          ),
        );
      }, this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, type, line });
    });
    stdin.write(line);
    const result = await response;
    if (!result.success) {
      throw new Error(result.error ?? `subagent RPC ${type} failed`);
    }
    return result;
  }

  private async queuePrompt(
    type: "prompt" | "follow_up",
    message: string,
  ): Promise<number> {
    const previousTarget = this.requestedSettlements;
    const target = Math.max(previousTarget, this.settledCount) + 1;
    this.requestedSettlements = target;
    this.activePrompt = { message, target };
    try {
      await this.send(type, { message });
      return target;
    } catch (error) {
      if (
        this.requestedSettlements === target &&
        this.settledCount < target
      ) {
        this.requestedSettlements = Math.max(
          previousTarget,
          this.settledCount,
        );
      }
      if (this.activePrompt?.target === target) {
        this.activePrompt = undefined;
      }
      throw error;
    }
  }

  private handleSandboxStart(stdin: Writable): void {
    this.stdin = stdin;
    this.startReady?.resolve();
    this.startReady = undefined;
  }

  private resolveSettledWaiters(): void {
    const result = sessionResult(this.textValue, this.rawOutput);
    for (const waiter of [...this.waiters]) {
      if (waiter.target <= this.settledCount) {
        waiter.cleanup();
        waiter.resolve(result);
      }
    }
  }

  private consumeStdout(data: Buffer): void {
    const text = data.toString("utf8");
    this.rawOutput += text;
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      event.type === "response" &&
      typeof event.id === "string" &&
      this.pending.has(event.id)
    ) {
      const pending = this.pending.get(event.id)!;
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      pending.resolve(event as RpcResponse);
      return;
    }
    const text = rpcAssistantText(event);
    if (text) {
      this.textValue = text;
      for (const update of this.updates) update(text);
    }
    if (event.type === "agent_start") {
      this.stateValue = "running";
    }
    if (event.type === "agent_settled") {
      this.stateValue = "idle";
      this.settledCount++;
      if (
        this.activePrompt &&
        this.activePrompt.target <= this.settledCount
      ) {
        this.activePrompt = undefined;
      }
      this.resolveSettledWaiters();
    }
  }

  private fail(error: Error): void {
    this.stateValue = "failed";
    this.errorValue = error.message;
    this.startReady?.reject(error);
    this.startReady = undefined;
    this.rejectPending(error);
    this.rejectWaiters(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}

export class ProcessBackedSubagentManager {
  private readonly sessions = new Map<string, ProcessBackedSubagentSession>();
  private readonly maxConcurrency: number;
  private readonly maxDepth: number;
  private readonly options: ProcessBackedSubagentManagerOptions;

  constructor(options: ProcessBackedSubagentManagerOptions = {}) {
    this.options = options;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new Error("subagent maxConcurrency must be a positive integer");
    }
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new Error("subagent maxDepth must be a positive integer");
    }
  }

  list(): ProcessBackedSubagentSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }

  get(id: string): ProcessBackedSubagentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown subagent session: ${id}`);
    return session;
  }

  async start(
    options: ProcessBackedSubagentSessionOptions,
  ): Promise<ProcessBackedSubagentSession> {
    const active = [...this.sessions.values()].filter((session) =>
      ["starting", "running", "idle"].includes(session.info.state),
    ).length;
    if (active >= this.maxConcurrency) {
      throw new Error(
        `subagent concurrency limit reached (${this.maxConcurrency})`,
      );
    }
    const inheritedDepth = Number.parseInt(
      process.env[SUBAGENT_DEPTH_ENV] ?? "0",
      10,
    );
    const parentDepth = options.parentId
      ? this.sessions.get(options.parentId)?.depth
      : undefined;
    const depth = options.depth ?? (parentDepth ?? inheritedDepth) + 1;
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > this.maxDepth) {
      throw new Error(`subagent nesting depth limit reached (${this.maxDepth})`);
    }
    const session = new ProcessBackedSubagentSession({
      ...options,
      depth,
      invocation: options.invocation ?? this.options.invocation,
    });
    this.sessions.set(session.id, session);
    try {
      await session.start();
      return session;
    } catch (error) {
      this.sessions.delete(session.id);
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const session = this.get(id);
    this.sessions.delete(id);
    await session.stop();
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }
}

export async function runProcessBackedSubagent(
  options: ProcessBackedSubagentOptions,
): Promise<ProcessBackedSubagentResult> {
  const invocation = options.invocation ?? resolvePiInvocation();
  const args = [
    ...invocation.args,
    "--mode",
    "json",
    "-p",
    "--no-session",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }
  args.push(`Task: ${options.task}`);
  const command = [invocation.command, ...args].map(shellQuote).join(" ");
  let output = "";
  const result = await runSandboxedCommand({
    command,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeout: options.timeout,
    policy: options.policy,
    ...options.sandbox,
    review: options.review,
    reviewDomain: options.reviewDomain,
    onData(data) {
      output += data.toString("utf8");
      options.onUpdate?.(finalAssistantText(output) || "(subagent running)");
    },
  });
  const text = finalAssistantText(output);
  if (result.exitCode !== 0) {
    throw new Error(
      `subagent exited with ${result.exitCode}: ${text || output.trim()}`,
    );
  }
  return { ...result, text, rawOutput: output };
}
