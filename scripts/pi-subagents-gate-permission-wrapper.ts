import { readFileSync } from "node:fs";
import { join } from "node:path";
import permissionSystemExtension from "../node_modules/@gotgenes/pi-permission-system/src/index.ts";

type GateExtensionApi = {
  on(event: "session_shutdown", handler: () => void): void;
};

const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

function servingHeartbeatPid(): number | null {
  const parentSessionId = process.env[PARENT_SESSION_ENV]?.trim();
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!parentSessionId || !agentDir) return null;
  try {
    const record = JSON.parse(readFileSync(join(
      agentDir,
      "sessions",
      "permission-forwarding",
      "serving",
      `${encodeURIComponent(parentSessionId)}.json`,
    ), "utf8")) as { pid?: unknown };
    return typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
  } catch {
    return null;
  }
}

/**
 * Gate-only wrapper for permission-system inside outer-isolated children.
 *
 * Sandbox Runtime intentionally hides host PIDs. A child's `kill(parentPid, 0)`
 * therefore returns ESRCH even while the parent heartbeat is fresh, which
 * makes permission-system abandon the forwarded request before the model
 * authorizer can answer. Treat only the exact PID in this gate's parent
 * heartbeat as alive. Heartbeat freshness still expires normally, so a parent
 * that stops polling is still detected without weakening the sandbox.
 */
export default function piSubagentsGatePermissionWrapper(pi: GateExtensionApi): void {
  const shouldAdapt =
    process.env.PI_SUBAGENT_CHILD === "1" &&
    process.env.PI_SUBAGENTS_GATE_EXTERNAL_ISOLATION === "1";
  const originalKill = process.kill;
  let adaptedKill: typeof process.kill | undefined;
  if (shouldAdapt) {
    adaptedKill = ((pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0 && pid === servingHeartbeatPid()) return true;
      return originalKill(pid, signal as NodeJS.Signals | number);
    }) as typeof process.kill;
    process.kill = adaptedKill;
    pi.on("session_shutdown", () => {
      if (process.kill === adaptedKill) process.kill = originalKill;
    });
  }

  permissionSystemExtension(pi as never);
}
