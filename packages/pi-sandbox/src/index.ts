import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getBoundaryBroker } from "@erichll/pi-auto-review/broker";
import {
  approveDomainEndpoint,
  approveHostIPCExecution,
  approveSandboxTrap,
  type HumanApproval,
} from "./approval.ts";
import {
  loadPiSandboxConfig,
  type HostIPCConfig,
  type SubagentProvider,
} from "./config.ts";
import { runCommandWithHostIPC } from "./host-ipc.ts";
import {
  runSandboxedCommand,
  type SandboxCommandOptions,
} from "./runner.ts";
import { createDefaultPolicy } from "./policy.ts";
import type {
  ProcessBackedSubagentManager,
  ProcessBackedSubagentSession,
} from "./subagent.ts";
import { Type } from "typebox";

const EXTENSION_NAME = "pi-sandbox";
const registrations = new WeakMap<ExtensionAPI, Promise<void>>();

export type PiSandboxExtensionOptions = {
  subagentProvider?: SubagentProvider;
  subagentManager?: ProcessBackedSubagentManager;
  createSubagentManager?: () => ProcessBackedSubagentManager;
  sandbox?: Pick<SandboxCommandOptions, "broker" | "platform">;
  /** Test/embedding override. Normal extension loading uses trusted global config. */
  hostIPC?: HostIPCConfig;
};

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function isPiSubagentsSource(
  sourceInfo: ReturnType<ExtensionAPI["getAllTools"]>[number]["sourceInfo"],
): boolean {
  const packagePattern =
    /(?:^|[/\\:@])(?:@[^/\\]+[/\\])?pi-subagents(?:$|[/\\:@])/;
  return [sourceInfo.source, sourceInfo.path, sourceInfo.baseDir].some(
    (value) => value !== undefined && packagePattern.test(value),
  );
}

function externalSubagentDiagnostic(pi: ExtensionAPI): {
  message: string;
  level: "info" | "warning";
} {
  const active = pi.getActiveTools().includes("subagent");
  const tool = pi.getAllTools().find((candidate) => candidate.name === "subagent");
  if (!active || !tool) {
    return {
      message:
        "pi-sandbox provider pi-subagents selected, but no external subagent tool is active",
      level: "warning",
    };
  }
  if (!isPiSubagentsSource(tool.sourceInfo)) {
    return {
      message: `pi-sandbox provider pi-subagents selected, but the active subagent tool is owned by unexpected source ${tool.sourceInfo.source} (${tool.sourceInfo.path})`,
      level: "warning",
    };
  }
  return {
    message:
      "pi-subagents orchestration active; pi-sandbox protects Bash execution. External workers are not yet wrapped in an outer Sandbox Runtime sandbox.",
    level: "info",
  };
}

function humanApproval(ctx: ExtensionContext): HumanApproval {
  return async (request, reason, signal) => {
    if (!ctx.hasUI) return "deny";
    const target =
      request.surface === "host-ipc"
        ? request.command ?? request.operation
        : request.resolvedPath ??
          request.path ??
          request.destination ??
          request.operation;
    const suffix = reason ? `\n${reason}` : "";
    const hostWarning =
      request.surface === "host-ipc"
        ? request.matchedPolicy?.rule === "unix-socket-eperm"
          ? "\nWarning: the first sandboxed attempt may already have had partial side effects. The retry runs on the host outside the OS sandbox."
          : "\nWarning: this command will run on the host outside the OS sandbox."
        : "";
    const selected = await ctx.ui.select(
      `Sandbox approval required: ${request.operation} ${target}${hostWarning}${suffix}`,
      ["Allow this exact operation once", "Deny"],
      { signal },
    );
    return selected === "Allow this exact operation once"
      ? "allow-once"
      : "deny";
  };
}

function sandboxOperations(
  ctx: ExtensionContext,
  turnIndex: () => number,
  additionalAllowRead: readonly string[],
  hostIPC: HostIPCConfig,
  sandbox?: PiSandboxExtensionOptions["sandbox"],
): BashOperations {
  return {
    exec(command, cwd, options) {
      const currentSessionId = sessionId(ctx);
      const shellPath = SettingsManager.create(cwd).getShellPath();
      const approvalContext = {
        broker: getBoundaryBroker(),
        command,
        cwd,
        sessionId: currentSessionId,
        scopeKey: `${currentSessionId}:turn:${turnIndex()}`,
        signal: options.signal,
        humanApproval: humanApproval(ctx),
      };
      const local = createLocalBashOperations({ shellPath });
      return runCommandWithHostIPC({
        command,
        cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeout,
        onData: options.onData,
        config: hostIPC,
        approve: async (trigger) => {
          const result = await approveHostIPCExecution(
            trigger,
            approvalContext,
          );
          if (result.action === "deny" && result.reason && ctx.hasUI) {
            ctx.ui.notify(`Host-IPC denied: ${result.reason}`, "warning");
          }
          return result;
        },
        runHost: (timeout) =>
          local.exec(command, cwd, {
            ...options,
            timeout,
          }),
        runSandbox: (onStderr) =>
          runSandboxedCommand({
            command,
            cwd,
            env: options.env,
            signal: options.signal,
            timeout: options.timeout,
            ...sandbox,
            onData: options.onData,
            onStderr,
            shellPath,
            policy: createDefaultPolicy(cwd, { additionalAllowRead }),
            review: async (trap) => {
              const result = await approveSandboxTrap(trap, approvalContext);
              if (result.action === "deny" && result.reason) {
                if (ctx.hasUI) {
                  ctx.ui.notify(`Sandbox denied: ${result.reason}`, "warning");
                }
              }
              return result.action;
            },
            reviewDomain: async (endpoint) => {
              const result = await approveDomainEndpoint(
                endpoint,
                approvalContext,
              );
              if (result.action === "deny" && result.reason && ctx.hasUI) {
                ctx.ui.notify(
                  `Domain proxy denied: ${result.reason}`,
                  "warning",
                );
              }
              return result.action;
            },
          }),
      });
    },
  };
}

async function performRegistration(
  pi: ExtensionAPI,
  options: PiSandboxExtensionOptions,
): Promise<void> {
  let currentTurn = 0;
  const config = loadPiSandboxConfig();
  const subagentProvider =
    options.subagentProvider ?? config.subagents.provider;
  const additionalAllowRead = config.filesystem.additionalAllowRead;
  const hostIPC = options.hostIPC ?? config.hostIPC;
  const subagents =
    subagentProvider === "builtin"
      ? (options.subagentManager ??
        options.createSubagentManager?.() ??
        new (await import("./subagent.ts")).ProcessBackedSubagentManager({
          maxConcurrency: 4,
          maxDepth: 3,
        }))
      : undefined;
  const cwd = process.cwd();
  const localBash = createBashToolDefinition(cwd);

  pi.registerTool({
    ...localBash,
    label: "bash (pi-sandbox)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!ctx) throw new Error(`${EXTENSION_NAME}: missing extension context`);
      const tool = createBashToolDefinition(ctx.cwd, {
        operations: sandboxOperations(
          ctx,
          () => currentTurn,
          additionalAllowRead,
          hostIPC,
          options.sandbox,
        ),
      });
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  if (subagents)
    pi.registerTool({
    name: "subagent",
    label: "Subagent (pi-sandbox)",
    description:
      "Run or manage persistent Pi worker sessions. Supports foreground/background start, follow-up, wait/status/stop, and nested handoff. Every worker process tree remains inside an independent outer Sandbox Runtime sandbox.",
    executionMode: "parallel",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("start"),
            Type.Literal("follow_up"),
            Type.Literal("wait"),
            Type.Literal("status"),
            Type.Literal("stop"),
            Type.Literal("handoff"),
          ],
          { description: "Session operation; defaults to start" },
        ),
      ),
      task: Type.Optional(
        Type.String({ description: "Task or follow-up instruction" }),
      ),
      sessionId: Type.Optional(
        Type.String({ description: "Existing session for the operation" }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: "Return after RPC acceptance instead of waiting",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Optional provider/model override" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const action = params.action ?? "start";
      const currentSessionId = sessionId(ctx);
      const requireTask = (): string => {
        if (!params.task?.trim()) {
          throw new Error(`subagent ${action} requires task`);
        }
        return params.task;
      };
      const requireSession = (): ProcessBackedSubagentSession => {
        if (!params.sessionId) {
          throw new Error(`subagent ${action} requires sessionId`);
        }
        return subagents.get(params.sessionId);
      };
      const update = (session: ProcessBackedSubagentSession) =>
        session.onUpdate((text) => {
          onUpdate?.({
            content: [{ type: "text", text }],
            details: {
              sandbox: "sandbox-runtime-outer",
              session: session.info,
            },
          });
        });
      const sessionOptions = (
        task: string,
        parentId?: string,
      ) => {
        const approvalContext = {
          broker: getBoundaryBroker(),
          command: `process-backed subagent: ${task}`,
          cwd: ctx.cwd,
          sessionId: currentSessionId,
          scopeKey: `${currentSessionId}:turn:${currentTurn}`,
          agentName: parentId ? "nested-subagent" : "subagent",
          humanApproval: humanApproval(ctx),
        };
        return {
          task,
          parentId,
          cwd: ctx.cwd,
          model: params.model,
          tools: pi.getActiveTools().filter((name) => name !== "subagent"),
          policy: createDefaultPolicy(ctx.cwd, { additionalAllowRead }),
          sandbox: options.sandbox,
          review: async (trap: Parameters<typeof approveSandboxTrap>[0]) =>
            (await approveSandboxTrap(trap, approvalContext)).action,
          reviewDomain: async (
            endpoint: Parameters<typeof approveDomainEndpoint>[0],
          ) => (await approveDomainEndpoint(endpoint, approvalContext)).action,
        };
      };

      if (action === "status") {
        const sessions = params.sessionId
          ? [requireSession().info]
          : subagents.list();
        return {
          content: [
            {
              type: "text",
              text:
                sessions.length > 0
                  ? JSON.stringify(sessions, null, 2)
                  : "(no subagent sessions)",
            },
          ],
          details: { sandbox: "sandbox-runtime-outer", sessions },
        };
      }

      if (action === "stop") {
        const session = requireSession();
        await subagents.remove(session.id);
        return {
          content: [{ type: "text", text: `Stopped subagent ${session.id}` }],
          details: { sandbox: "sandbox-runtime-outer", session: session.info },
        };
      }

      if (action === "wait") {
        const session = requireSession();
        const unsubscribe = update(session);
        try {
          const result = await session.waitForSettled(undefined, signal);
          return {
            content: [
              {
                type: "text",
                text:
                  result.text || "(subagent completed without assistant text)",
              },
            ],
            details: { sandbox: "sandbox-runtime-outer", session: session.info },
          };
        } catch (error) {
          if (signal?.aborted) {
            await session.abort().catch(() => undefined);
          }
          throw error;
        } finally {
          unsubscribe();
        }
      }

      if (action === "follow_up") {
        const session = requireSession();
        const unsubscribe = update(session);
        try {
          const target = await session.followUp(requireTask());
          if (params.background) {
            return {
              content: [
                {
                  type: "text",
                  text: `Follow-up queued for subagent ${session.id}`,
                },
              ],
              details: { sandbox: "sandbox-runtime-outer", session: session.info },
            };
          }
          const result = await session.waitForSettled(target, signal);
          return {
            content: [
              {
                type: "text",
                text:
                  result.text || "(subagent completed without assistant text)",
              },
            ],
            details: { sandbox: "sandbox-runtime-outer", session: session.info },
          };
        } catch (error) {
          if (signal?.aborted) {
            await session.abort().catch(() => undefined);
          }
          throw error;
        } finally {
          unsubscribe();
        }
      }

      const task =
        action === "handoff"
          ? `Handoff from subagent session ${requireSession().id}.\n\nPrevious result:\n${requireSession().info.text}\n\nNext task:\n${requireTask()}`
          : requireTask();
      const parentId =
        action === "handoff" ? requireSession().id : undefined;
      const session = await subagents.start(sessionOptions(task, parentId));
      const unsubscribe = update(session);
      try {
        const target = await session.prompt(task);
        if (params.background) {
          return {
            content: [
              {
                type: "text",
                text: `Started background subagent ${session.id}`,
              },
            ],
            details: { sandbox: "sandbox-runtime-outer", session: session.info },
          };
        }
        const result = await session.waitForSettled(target, signal);
        if (action === "start") await subagents.remove(session.id);
        return {
          content: [
            {
              type: "text",
              text: result.text || "(subagent completed without assistant text)",
            },
          ],
          details: {
            sandbox: "sandbox-runtime-outer",
            session: session.info,
            exitCode: result.exitCode,
          },
        };
      } catch (error) {
        if (!params.background) {
          await subagents.remove(session.id).catch(() => undefined);
        }
        throw error;
      } finally {
        unsubscribe();
      }
    },
    });

  pi.on("user_bash", (_event, ctx) => ({
    operations: sandboxOperations(
      ctx,
      () => currentTurn,
      additionalAllowRead,
      hostIPC,
      options.sandbox,
    ),
  }));

  pi.on("turn_start", (event) => {
    currentTurn = event.turnIndex;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      if (subagentProvider === "pi-subagents") {
        const diagnostic = externalSubagentDiagnostic(pi);
        ctx.ui.notify(diagnostic.message, diagnostic.level);
      } else if (subagentProvider === "builtin") {
        ctx.ui.notify(
          "pi-sandbox subagent provider: builtin; worker process trees use the outer Sandbox Runtime sandbox",
          "info",
        );
      } else {
        ctx.ui.notify(
          "pi-sandbox subagent provider: off; pi-sandbox protects Bash execution only",
          "info",
        );
      }
    }
    if (process.platform !== "linux" && process.platform !== "darwin") {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${EXTENSION_NAME} is unavailable on ${process.platform}; Bash commands will fail closed`,
          "warning",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        process.platform === "darwin"
          ? `${EXTENSION_NAME} enabled: macOS Sandbox Runtime with static filesystem policy and per-connection network review`
          : `${EXTENSION_NAME} enabled: Linux Sandbox Runtime with static filesystem policy and per-connection network review`,
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await subagents?.shutdown();
  });
}

export function registerPiSandbox(
  pi: ExtensionAPI,
  options: PiSandboxExtensionOptions = {},
): Promise<void> {
  const existing = registrations.get(pi);
  if (existing) return existing;
  const registration = performRegistration(pi, options);
  registrations.set(pi, registration);
  return registration;
}

export default async function piSandbox(pi: ExtensionAPI): Promise<void> {
  await registerPiSandbox(pi);
}
