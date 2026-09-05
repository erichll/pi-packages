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
  type NetworkConfig,
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
import { validateSubagentModel } from "./subagent.ts";
import { Type } from "typebox";
import {
  loadPiSubagentsNativeRuntime,
  nativeSubagentCallBlockReason,
  PI_SANDBOX_ACKNOWLEDGEMENT,
  terminalChildrenHaveSandboxAcknowledgement,
  type CapabilityCeilingHandle,
} from "./pi-subagents-native.ts";

const EXTENSION_NAME = "pi-sandbox";
const registrations = new WeakMap<ExtensionAPI, Promise<void>>();

export type PiSandboxExtensionOptions = {
  subagentProvider?: SubagentProvider;
  subagentManager?: ProcessBackedSubagentManager;
  createSubagentManager?: () => ProcessBackedSubagentManager;
  sandbox?: Pick<SandboxCommandOptions, "broker" | "platform">;
  /** Test/embedding override. Normal extension loading uses trusted global config. */
  hostIPC?: HostIPCConfig;
  /** Test/embedding override. Normal extension loading uses trusted global config. */
  allowedNativeAgents?: readonly string[];
};

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function piSubagentsSessionId(ctx: ExtensionContext): string {
  const getSessionFile = (ctx.sessionManager as { getSessionFile?: () => string | null | undefined }).getSessionFile;
  return getSessionFile?.call(ctx.sessionManager) ?? ctx.sessionManager.getSessionId();
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
      "pi-subagents protected native-background mode active; child writes are restricted to sandboxed Bash. This is a tool boundary, not outer worker process isolation.",
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
  network: NetworkConfig,
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
            policy: createDefaultPolicy(cwd, { additionalAllowRead, network }),
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
  const isNativeSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
  const protectExternalOrchestration =
    subagentProvider === "pi-subagents" && !isNativeSubagentChild;
  const allowedNativeAgents = options.allowedNativeAgents ??
    config.subagents.allowedNativeAgents;
  if (protectExternalOrchestration && !allowedNativeAgents?.length) {
    throw new Error(
      `${EXTENSION_NAME}: pi-subagents protected mode requires allowedNativeAgents`,
    );
  }
  const nativeRuntime = protectExternalOrchestration
    ? await loadPiSubagentsNativeRuntime(allowedNativeAgents!)
    : undefined;
  const additionalAllowRead = config.filesystem.additionalAllowRead;
  const network = config.network;
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
  let capabilityCeiling: CapabilityCeilingHandle | undefined;
  let validatedNativeAgents: string[] = [];
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
          network,
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
          policy: createDefaultPolicy(ctx.cwd, { additionalAllowRead, network }),
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
      // Fail fast on an invalid explicit model before spawning a child Pi.
      // Only process-spawning actions (start/handoff) reach this block, so
      // status/wait/stop/follow_up are never intercepted by model validation.
      // When no model is specified the child inherits host behavior (no check).
      const modelSpec = params.model?.trim();
      if (modelSpec) {
        const modelCheck = validateSubagentModel(
          modelSpec,
          ctx.modelRegistry?.getAvailable() ?? [],
          ctx.model?.provider,
        );
        if (!modelCheck.ok) {
          throw new Error(modelCheck.error);
        }
      }
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
      network,
      hostIPC,
      options.sandbox,
    ),
  }));

  pi.on("turn_start", (event) => {
    currentTurn = event.turnIndex;
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "subagent" && protectExternalOrchestration) {
      const reason = nativeSubagentCallBlockReason(event.input);
      if (reason) {
        return { block: true, reason: `${EXTENSION_NAME}: ${reason}` };
      }
      if (event.input.action === undefined) {
        try {
          validatedNativeAgents = nativeRuntime!.validateAllowedAgents(
            ctx.cwd,
            ctx.model?.provider,
          );
          capabilityCeiling?.dispose();
          capabilityCeiling = nativeRuntime!.registerCeiling(
            piSubagentsSessionId(ctx),
            validatedNativeAgents,
          );
        } catch (error) {
          return {
            block: true,
            reason: `${EXTENSION_NAME}: protected launch validation failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (
      protectExternalOrchestration &&
      event.toolName === "subagent" &&
      (event.input.action === "status" || event.input.action === "debug.run") &&
      !event.isError &&
      !terminalChildrenHaveSandboxAcknowledgement(event.details)
    ) {
      return {
        content: [{
          type: "text",
          text: `${EXTENSION_NAME}: child result did not acknowledge ${PI_SANDBOX_ACKNOWLEDGEMENT}; protected execution proof is missing`,
        }],
        isError: true,
      };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (isNativeSubagentChild) {
      pi.events?.emit("subagent:acknowledge-extension", {
        id: PI_SANDBOX_ACKNOWLEDGEMENT,
      });
    }
    capabilityCeiling?.dispose();
    capabilityCeiling = undefined;
    if (protectExternalOrchestration) {
      validatedNativeAgents = nativeRuntime!.validateAllowedAgents(
        ctx.cwd,
        ctx.model?.provider,
      );
      capabilityCeiling = nativeRuntime!.registerCeiling(
        piSubagentsSessionId(ctx),
        validatedNativeAgents,
      );
      const ownership = externalSubagentDiagnostic(pi);
      if (ownership.level === "warning") {
        capabilityCeiling.dispose();
        capabilityCeiling = undefined;
        throw new Error(`${EXTENSION_NAME}: ${ownership.message}`);
      }
    }
    if (ctx.hasUI) {
      if (protectExternalOrchestration) {
        const diagnostic = externalSubagentDiagnostic(pi);
        ctx.ui.notify(diagnostic.message, diagnostic.level);
      } else if (subagentProvider === "builtin" && !isNativeSubagentChild) {
        ctx.ui.notify(
          "pi-sandbox subagent provider: builtin; worker process trees use the outer Sandbox Runtime sandbox",
          "info",
        );
      } else {
        ctx.ui.notify(
          isNativeSubagentChild
            ? "pi-sandbox active in native subagent child; writes are restricted to sandboxed Bash"
            : "pi-sandbox subagent provider: off; pi-sandbox protects Bash execution only",
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
          ? `${EXTENSION_NAME} enabled: macOS Sandbox Runtime with static filesystem/domain policy and per-connection network review`
          : `${EXTENSION_NAME} enabled: Linux Sandbox Runtime with static filesystem/domain policy and per-connection network review`,
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    capabilityCeiling?.dispose();
    capabilityCeiling = undefined;
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
