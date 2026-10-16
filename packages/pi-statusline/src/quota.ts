interface QuotaModel { provider: string; id: string; api: string; baseUrl: string; }

export interface QuotaWindow {
  usedPercent: number;
  resetAtSeconds: number;
  /** Window length reported upstream; optional, and never guessed. */
  windowMinutes?: number;
}
export interface SubscriptionQuota {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
}
export interface QuotaSnapshot {
  primary?: QuotaWindow & { resetInMinutes: number };
  secondary?: QuotaWindow & { resetInMinutes: number };
}

function headerNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function validatedWindow(usedPercent: unknown, resetAtSeconds: unknown, windowMinutes?: unknown): QuotaWindow | undefined {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  if (typeof resetAtSeconds !== "number" || !Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0 || resetAtSeconds > 8.64e12) return undefined;
  // A bad length only loses the label; the usage itself is still valid.
  const minutes = typeof windowMinutes === "number" && Number.isFinite(windowMinutes) && windowMinutes > 0 && windowMinutes <= 5256000 ? windowMinutes : undefined;
  return { usedPercent, resetAtSeconds, ...(minutes ? { windowMinutes: minutes } : {}) };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function defaultQuotaEvent(data: Record<string, unknown>): boolean {
  if (data.type !== "codex.rate_limits") return false;
  // Other metered buckets are independent limits, not this default Codex allowance.
  const limit = data.metered_limit_name ?? data.limit_name;
  return limit == null || typeof limit === "string" && limit.trim().toLowerCase() === "codex";
}

/** Native WebSocket quota payload; read only known numeric fields, never account/credit data. */
export function readQuotaEvent(data: unknown): SubscriptionQuota | undefined {
  if (!record(data) || !defaultQuotaEvent(data) || !record(data.rate_limits)) return undefined;
  const quota: SubscriptionQuota = {};
  for (const key of ["primary", "secondary"] as const) {
    const value = data.rate_limits[key];
    if (!record(value)) continue;
    const window = validatedWindow(value.used_percent, value.reset_at, value.window_minutes);
    if (window) quota[key] = window;
  }
  return quota.primary || quota.secondary ? quota : undefined;
}

/** Read only Codex usage/reset/window headers, never credentials or full responses. */
export function readQuotaHeaders(headers: Record<string, string>): SubscriptionQuota | undefined {
  const fields = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (/^x-codex-(primary|secondary)-(used-percent|reset-at|window-minutes)$/.test(lower)) fields.set(lower, headers[name]!);
  }
  const quota: SubscriptionQuota = {};
  for (const window of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${window}-`;
    const usedPercent = headerNumber(fields.get(`${prefix}used-percent`));
    const resetAtSeconds = headerNumber(fields.get(`${prefix}reset-at`));
    // A percentage without a valid reset time cannot yield a trustworthy countdown.
    const value = validatedWindow(usedPercent, resetAtSeconds, headerNumber(fields.get(`${prefix}window-minutes`)));
    if (value) quota[window] = value;
  }
  return quota.primary || quota.secondary ? quota : undefined;
}

function modelKey(model: QuotaModel | undefined): string | undefined {
  return model ? JSON.stringify([model.provider, model.id, model.api, model.baseUrl]) : undefined;
}

/** Session-local response snapshot; never merge windows across requests or persist accounts. */
export class QuotaState {
  private responseReceived = false;
  private streamQuotaReceived = false;
  private selected: string | undefined;
  private request: string | undefined;
  private quota: SubscriptionQuota | undefined;

  select(model: QuotaModel | undefined): void {
    const key = modelKey(model);
    if (key !== this.selected) { this.clear(); this.selected = key; }
  }
  clear(): void {
    this.request = undefined; this.quota = undefined;
    this.responseReceived = false; this.streamQuotaReceived = false;
  }
  beginRequest(model: QuotaModel | undefined): void {
    this.select(model);
    this.responseReceived = false; this.streamQuotaReceived = false;
    this.request = modelKey(model);
  }
  response(headers: Record<string, string>, model: QuotaModel | undefined): void {
    this.select(model);
    if (!this.request || this.request !== modelKey(model)) return;
    this.responseReceived = true;
    // Missing/malformed headers on a later response invalidate the old account snapshot.
    this.quota = readQuotaHeaders(headers);
  }
  /** Returns true when the footer needs repainting; raw events are never retained. */
  observeStream(provider: string, id: string, api: string, model: QuotaModel | undefined, data?: unknown): boolean {
    this.select(model);
    if (model && (provider !== model.provider || id !== model.id || api !== model.api)) {
      this.clear();
      return true;
    }
    if (!this.request || this.request !== modelKey(model)) return false;
    if (record(data) && defaultQuotaEvent(data)) {
      this.streamQuotaReceived = true;
      // Replace the whole event snapshot; never merge two credentials' windows.
      this.quota = readQuotaEvent(data);
      return true; // A quota update (including invalidation) needs a repaint.
    }
    if (!this.streamQuotaReceived && !this.responseReceived) {
      // WebSocket requests can stream successfully without an HTTP response hook.
      // Never carry a previous SSE/account snapshot into that request.
      const hadQuota = !!this.quota;
      this.quota = undefined;
      return hadQuota;
    }
    return false;
  }
  snapshot(model: QuotaModel | undefined, now = Date.now()): QuotaSnapshot | undefined {
    this.select(model);
    if (!this.quota) return undefined;
    const result: QuotaSnapshot = {};
    for (const window of ["primary", "secondary"] as const) {
      const value = this.quota[window];
      if (!value || value.resetAtSeconds * 1000 <= now) continue;
      result[window] = { ...value, resetInMinutes: Math.ceil((value.resetAtSeconds * 1000 - now) / 60000) };
    }
    // Do not turn an expired sample into a made-up zero-usage window.
    return result.primary || result.secondary ? result : undefined;
  }
}

export function formatReset(minutes: number): string {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

const STANDARD_WINDOWS = [[300, "5h"], [1440, "1d"], [10080, "7d"], [43200, "30d"]] as const;
/** `300` → `5h`, `10080` → `7d`; other lengths print exactly (`90` → `1h30m`). */
export function windowLabel(minutes: number | undefined): string | undefined {
  if (!minutes) return undefined;
  // Codex itself treats lengths within 5% of a standard window as that window.
  for (const [expected, label] of STANDARD_WINDOWS) if (minutes >= expected * 0.95 && minutes <= expected * 1.05) return label;
  const total = Math.max(1, Math.round(minutes));
  const parts = [[Math.floor(total / 1440), "d"], [Math.floor(total % 1440 / 60), "h"], [total % 60, "m"]] as const;
  return parts.filter(([value]) => value > 0).map(([value, unit]) => `${value}${unit}`).join("");
}

export type QuotaDetail = "full" | "bars" | "percent";
export interface QuotaPiece { usedPercent: number; label?: string; bar?: string; percent: string; reset?: string }

/**
 * Windows in display order. Narrower details drop the countdown, then the bar; an
 * unlabeled window keeps its countdown instead, since that is all that tells it apart.
 */
export function quotaPieces(quota: QuotaSnapshot | undefined, ascii: boolean, detail: QuotaDetail = "full"): QuotaPiece[] | undefined {
  const windows = quota ? [quota.primary, quota.secondary].filter((window) => window !== undefined) : [];
  if (!windows.length) return undefined;
  return windows.map((window) => {
    const label = windowLabel(window.windowMinutes);
    const full = window.usedPercent > 0 ? Math.max(1, Math.round(window.usedPercent / 10)) : 0;
    const bar = (ascii ? "#" : "█").repeat(full) + (ascii ? "-" : "░").repeat(10 - full);
    const reset = formatReset(window.resetInMinutes);
    return {
      usedPercent: window.usedPercent, percent: `${Number(window.usedPercent.toFixed(1))}%`,
      ...(label ? { label } : {}),
      ...(detail === "full" || detail === "bars" && label ? { bar } : {}),
      ...(detail === "full" || !label ? { reset } : {}),
    };
  });
}
export function quotaSeparator(ascii: boolean): string { return ascii ? " / " : " · "; }

export function renderQuota(quota: QuotaSnapshot | undefined, ascii: boolean, detail: QuotaDetail = "full"): string | undefined {
  return quotaPieces(quota, ascii, detail)?.map((piece) => [piece.label, piece.bar, piece.percent, piece.reset].filter(Boolean).join(" ")).join(quotaSeparator(ascii));
}
