const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

type SessionStartContext = {
  sessionManager: { getSessionId(): string };
};

type GateExtensionApi = {
  on(
    event: "session_start",
    handler: (event: unknown, ctx: SessionStartContext) => void,
  ): void;
};

/**
 * Remove pi-subagents' self-referential parent marker from the interactive
 * process without touching a real inherited parent marker.
 *
 * pi-subagents passes the parent session id explicitly to every child launch;
 * the root-process environment copy is therefore unnecessary. Keeping it on
 * the root makes pi-permission-system classify that root as a child and stop
 * serving the forwarded-permission inbox.
 */
export function clearSelfReferentialParentSession(
  currentSessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!currentSessionId || env[PARENT_SESSION_ENV] !== currentSessionId) {
    return false;
  }
  delete env[PARENT_SESSION_ENV];
  return true;
}

/**
 * Gate-scoped compatibility adapter. Load after pi-subagents (which publishes
 * the root marker during session_start) and before pi-permission-system (which
 * performs child detection during its own session_start handler).
 */
export default function piSubagentsParentForwardingAdapter(pi: GateExtensionApi): void {
  pi.on("session_start", (_event, ctx) => {
    clearSelfReferentialParentSession(ctx.sessionManager.getSessionId());
  });
}
