import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

type UiCustom = ExtensionUIContext["custom"];

type PermissionUiPromptEvent = {
  requestId: string;
  /** Value the live dialog is expected to show (command, path, or legacy message). */
  fingerprint: string;
  /** Gate surface from `request.surface`, when the 26.x payload carries it. */
  gateSurface?: string;
};

/** Prefix length that survives the default 400-char prompt field cap. */
const FINGERPRINT_PREFIX = 80;

type PendingApproval = {
  surface: string;
  expiresAt: number;
};

type PromptAttempt = {
  controller: AbortController;
  settled: boolean;
  recognized: boolean;
  autoApprove?: () => void;
  denyForUiConflict?: () => void;
  restore?: () => void;
};

const AUTO_APPROVED_DECISION = {
  approved: true,
  state: "approved",
  autoApproved: true,
} as const;

const UI_CONFLICT_DENIED_DECISION = {
  approved: false,
  state: "denied",
} as const;

const DEFAULT_PENDING_TTL_MS = 10_000;

/**
 * Bridges a model allow that the permission-system delegation envelope capped
 * to defer into the immediately following local TUI terminal.
 *
 * The bridge is deliberately request-bound and one-shot. Any timing, event, UI,
 * component, or wrapper mismatch leaves the normal human dialog in control.
 */
export class PermissionUiAutoConfirmer {
  private readonly pending = new Map<string, PendingApproval>();
  private activeAttempt: PromptAttempt | undefined;

  constructor(
    private readonly enabledSurfaces: () => readonly string[],
    private readonly pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  ) {}

  stage(requestId: string, surface: string): boolean {
    this.pruneExpired();
    if (!this.enabledSurfaces().includes(surface)) return false;
    this.pending.set(requestId, {
      surface,
      expiresAt: Date.now() + this.pendingTtlMs,
    });
    return true;
  }

  handlePrompt(raw: unknown, ctx: ExtensionContext): void {
    const event = parsePermissionUiPromptEvent(raw);
    if (!event || ctx.mode !== "tui" || !ctx.hasUI) return;

    this.pruneExpired();
    const pending = this.pending.get(event.requestId);
    if (!pending) {
      // A staged allow is valid only for the immediately following prompt.
      // Never leave it latent after a different request reaches the terminal.
      this.pending.clear();
      this.settleActiveForConflict();
      return;
    }
    this.pending.delete(event.requestId);

    if (!this.enabledSurfaces().includes(pending.surface)) return;
    // Top-level event.surface is the display tool name (e.g. bash), not the
    // gate. Only request.surface is comparable to the staged allow.
    if (event.gateSurface && event.gateSurface !== pending.surface) return;
    this.settleActiveForConflict();

    const attempt: PromptAttempt = {
      controller: new AbortController(),
      settled: false,
      recognized: false,
    };
    this.activeAttempt = attempt;
    if (!this.installOneShotInterceptor(ctx.ui, event, attempt)) {
      attempt.controller.abort();
      attempt.settled = true;
      this.activeAttempt = undefined;
    }
  }

  clear(): void {
    this.pending.clear();
    const attempt = this.activeAttempt;
    this.activeAttempt = undefined;
    if (!attempt) return;
    attempt.restore?.();
    attempt.controller.abort();
    attempt.settled = true;
  }

  private installOneShotInterceptor(
    ui: ExtensionUIContext,
    event: PermissionUiPromptEvent,
    attempt: PromptAttempt,
  ): boolean {
    const previousCustom = ui.custom;
    let invoked = false;
    let wrapper: UiCustom;

    const release = () => {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
    };
    const restore = () => {
      try {
        if (ui.custom === wrapper) ui.custom = previousCustom;
      } catch {
        // A shared-UI wrapper conflict degrades to the normal human dialog.
      }
    };

    wrapper = ((factory: (...args: any[]) => any, options?: any) => {
      if (invoked) {
        return invokeUiCustom(previousCustom, ui, factory, options);
      }
      invoked = true;
      restore();

      if (options?.overlay !== false) {
        this.releaseUnrecognized(attempt, release);
        return invokeUiCustom(previousCustom, ui, factory, options);
      }

      const wrappedFactory = (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => {
        let uiFinished = false;
        const finish = (result: unknown) => {
          if (uiFinished) return;
          uiFinished = true;
          if (!attempt.settled) {
            attempt.settled = true;
            attempt.controller.abort();
            release();
          }
          done(result);
        };

        attempt.autoApprove = () => finish(AUTO_APPROVED_DECISION);
        attempt.denyForUiConflict = () => finish(UI_CONFLICT_DENIED_DECISION);

        let produced: unknown;
        try {
          produced = factory(tui, theme, keybindings, finish);
        } catch (error) {
          this.releaseUnrecognized(attempt, release);
          throw error;
        }

        if (isPromiseLike(produced)) {
          return Promise.resolve(produced).then(
            (component) =>
              this.recognizeComponent(component, event, attempt, release),
            (error) => {
              this.releaseUnrecognized(attempt, release);
              throw error;
            },
          );
        }
        return this.recognizeComponent(produced, event, attempt, release);
      };

      return invokeUiCustom(previousCustom, ui, wrappedFactory, options);
    }) as UiCustom;

    attempt.restore = restore;
    try {
      ui.custom = wrapper;
    } catch {
      return false;
    }

    // v24 opens the permission component synchronously after the event. Never
    // leave a wrapper installed long enough to catch an unrelated custom UI.
    queueMicrotask(() => {
      if (invoked) return;
      restore();
      this.releaseUnrecognized(attempt, release);
    });
    return true;
  }

  private recognizeComponent(
    component: unknown,
    event: PermissionUiPromptEvent,
    attempt: PromptAttempt,
    release: () => void,
  ): unknown {
    if (!isPermissionPromptComponent(component, event)) {
      this.releaseUnrecognized(attempt, release);
      return component;
    }
    attempt.recognized = true;
    queueMicrotask(() => {
      try {
        if (!attempt.settled && attempt.recognized) {
          attempt.autoApprove?.();
        }
      } catch {
        attempt.controller.abort();
        attempt.settled = true;
        release();
      }
    });
    return component;
  }

  private releaseUnrecognized(
    attempt: PromptAttempt,
    release: () => void,
  ): void {
    if (attempt.recognized || attempt.settled) return;
    attempt.restore?.();
    attempt.controller.abort();
    attempt.settled = true;
    release();
  }

  private settleActiveForConflict(): void {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.settled) return;
    try {
      attempt.denyForUiConflict?.();
    } catch {
      attempt.controller.abort();
      attempt.settled = true;
      this.activeAttempt = undefined;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [requestId, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(requestId);
    }
  }
}

function parsePermissionUiPromptEvent(
  raw: unknown,
): PermissionUiPromptEvent | undefined {
  if (!isRecord(raw)) return;
  const requestId = nonemptyString(raw.requestId);
  if (!requestId) return;

  const request = isRecord(raw.request) ? raw.request : undefined;
  // permission-system 26+ removed `message`. Prefer the structured value the
  // dialog actually renders, then the display projection, then the legacy
  // assembled sentence.
  const fingerprint =
    nonemptyString(request?.value) ??
    nonemptyString(raw.value) ??
    nonemptyString(raw.message);
  if (!fingerprint) return;

  return {
    requestId,
    fingerprint,
    gateSurface: nonemptyString(request?.surface),
  };
}

function isPermissionPromptComponent(
  value: unknown,
  event: PermissionUiPromptEvent,
): boolean {
  if (!isRecord(value) || typeof value.render !== "function") return false;
  const constructorName =
    typeof value.constructor === "function" ? value.constructor.name : "";
  if (constructorName !== "PermissionPromptComponent") return false;

  try {
    const rendered = value.render(2_000);
    if (!Array.isArray(rendered)) return false;
    const plain = normalizeWhitespace(stripAnsi(rendered.join("\n")));
    const needle = event.fingerprint.slice(0, FINGERPRINT_PREFIX);
    return (
      plain.includes("Permission Required") &&
      needle.length > 0 &&
      plain.includes(needle)
    );
  } catch {
    return false;
  }
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const compact = normalizeWhitespace(value);
  return compact || undefined;
}

function invokeUiCustom(
  method: UiCustom,
  ui: ExtensionUIContext,
  factory: (...args: any[]) => any,
  options: any,
): Promise<any> {
  return Reflect.apply(method as (...args: any[]) => Promise<any>, ui, [
    factory,
    options,
  ]);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function stripAnsi(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,
    "",
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
