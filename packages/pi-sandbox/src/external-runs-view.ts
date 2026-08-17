// Optional FleetView integration for pi-sandbox's isolated external workers.
//
// When the host is running the external `pi-subagents` provider with
// `externalWorkerIsolation: "enforce"`, pi-sandbox supervises the external
// worker process trees itself. This module mirrors those supervised workers
// into pi-subagents' caller-owned external-run registry so they show up in the
// FleetView (pi-subagents >= 0.50.0).
//
// This is a pure observability enhancement: it participates in NO sandbox
// allow/deny decision, and nothing here can downgrade an isolated worker into
// host execution. `pi-subagents/external-runs` is loaded via a DYNAMIC import
// only (never a top-level static import), because pi-subagents is an OPTIONAL
// peer dependency: builtin/off deployments may not have it installed.
//
// Deliberate scope of v1: records are "running" only. No completed/failed/
// endedAt are fabricated because neither the launcher nor the supervisor
// protocol currently reports process exit evidence to this extension (the
// record would therefore be a lie). See docs/compat-notes.md seam 5.

type ExternalRunState = "running";

/** Structural view of the specific pi-subagents API we consume. */
type ExternalRunsApi = {
  registerExternalRun(input: {
    id: string;
    sessionId: string;
    source: string;
    label: string;
    state: ExternalRunState;
    startedAt: number;
    preview?: string;
  }): unknown;
  unregisterExternalRun(sessionId: string, id: string): boolean;
};

export type ExternalRunsView = {
  /** Whether the pi-subagents runtime is reachable (dynamic import succeeded). */
  readonly enabled: boolean;
  /** Diagnostic string when the runtime is disabled. */
  readonly error?: string;
  /** Mirror a supervisor lifecycle.registered event into the registry. */
  registered(worker: { id: string; cwd: string; startedAt: number }): void;
  /** Mirror a supervisor lifecycle.unregistered event out of the registry. */
  unregistered(workerId: string): void;
  /** Unregister every run this view registered (session shutdown / replace). */
  close(): void;
};

const VIEW_LABEL = "isolated pi-subagents worker";
const VIEW_SOURCE = "pi-sandbox";

/**
 * Whether the FleetView integration should be enabled for a given provider /
 * isolation combination. It is enabled ONLY when the external pi-subagents
 * provider owns orchestration AND outer worker isolation is enforced -- the
 * sole case where pi-sandbox actually supervises external workers and can
 * truthfully vouch for a "running" record it owns.
 */
export function externalRunsViewEnabledWhen(
  provider: string,
  externalWorkerIsolation: string,
): boolean {
  return provider === "pi-subagents" && externalWorkerIsolation === "enforce";
}

function ident(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) {
    return { ok: false, error: "must be a non-empty trimmed string" };
  }
  return { ok: true, value: trimmed };
}

export function createExternalRunsView(
  sessionIdInput: string,
  load: () => Promise<unknown> = () => import("pi-subagents/external-runs"),
): Promise<ExternalRunsView> {
  return (async () => {
    const sessionId = ident(sessionIdInput);
    if (!sessionId.ok) {
      return disabledView(`invalid session id: ${sessionId.error}`);
    }
    let api: ExternalRunsApi | undefined;
    let loadError: string | undefined;
    try {
      const mod = (await load()) as Record<string, unknown>;
      const registerExternalRun = mod.registerExternalRun;
      const unregisterExternalRun = mod.unregisterExternalRun;
      if (typeof registerExternalRun !== "function" || typeof unregisterExternalRun !== "function") {
        throw new Error("pi-subagents/external-runs does not expose registerExternalRun/unregisterExternalRun");
      }
      api = { registerExternalRun, unregisterExternalRun } as unknown as ExternalRunsApi;
    } catch (error) {
      loadError = `FleetView external-run registration unavailable: ${error instanceof Error ? error.message : String(error)}`;
      // Never thrown: disable only the display path. Sandbox fail-closed and
      // network approval for the supervisor are untouched.
      return disabledView(loadError);
    }

    // (sessionId, workerId) pairs this extension registered, so we never
    // duplicate-register and never unregister records owned by other sources.
    const registered = new Map<string, number>();

    return {
      get enabled() {
        return Boolean(api);
      },
      error: loadError,
      registered(worker) {
        const fullId = ident(worker.id);
        const cwd = ident(worker.cwd);
        if (!api || !fullId.ok || !cwd.ok) return;
        if (registered.has(fullId.value)) return; // avoid duplicate registration
        try {
          api!.registerExternalRun({
            id: fullId.value,
            sessionId: sessionId.value,
            source: VIEW_SOURCE,
            label: VIEW_LABEL,
            state: "running",
            startedAt:
              Number.isSafeInteger(worker.startedAt) && worker.startedAt > 0
                ? worker.startedAt
                : Date.now(),
            preview: cwd.value,
          });
          registered.set(fullId.value, Date.now());
        } catch (error) {
          // Registry full / malformed record / unknown fields: log, do not emit.
          console.error(
            `pi-sandbox: could not register external run for worker '${fullId.value}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      unregistered(workerId) {
        const fullId = ident(workerId);
        if (!fullId.ok) return;
        if (!registered.has(fullId.value)) return; // we did not register it
        registered.delete(fullId.value);
        if (api) {
          try {
            api.unregisterExternalRun(sessionId.value, fullId.value);
          } catch {
            // Best-effort; nothing else to fall back to.
          }
        }
      },
      close() {
        for (const workerId of registered.keys()) {
          if (api) {
            try {
              api.unregisterExternalRun(sessionId.value, workerId);
            } catch {
              // best-effort
            }
          }
        }
        registered.clear();
      },
    };
  })();
}

function disabledView(error: string): ExternalRunsView {
  console.error(`pi-sandbox: ${error}`);
  return {
    enabled: false,
    error,
    registered() {},
    unregistered() {},
    close() {},
  };
}