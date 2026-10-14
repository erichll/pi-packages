interface QuotaModel { provider: string; id: string; api: string; baseUrl: string; }

export interface QuotaWindow {
  usedPercent: number;
  resetAtSeconds: number;
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

function validatedWindow(usedPercent: unknown, resetAtSeconds: unknown): QuotaWindow | undefined {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  if (typeof resetAtSeconds !== "number" || !Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0 || resetAtSeconds > 8.64e12) return undefined;
  return { usedPercent, resetAtSeconds };
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
    const window = validatedWindow(value.used_percent, value.reset_at);
    if (window) quota[key] = window;
  }
  return quota.primary || quota.secondary ? quota : undefined;
}

/** Read only Codex usage/reset headers, never credentials or full responses. */
export function readQuotaHeaders(headers: Record<string, string>): SubscriptionQuota | undefined {
  const fields = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (/^x-codex-(primary|secondary)-(used-percent|reset-at)$/.test(lower)) fields.set(lower, headers[name]!);
  }
  const quota: SubscriptionQuota = {};
  for (const window of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${window}-`;
    const usedPercent = headerNumber(fields.get(`${prefix}used-percent`));
    const resetAtSeconds = headerNumber(fields.get(`${prefix}reset-at`));
    // A percentage without a valid reset time cannot yield a trustworthy countdown.
    const value = validatedWindow(usedPercent, resetAtSeconds);
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

export function renderQuota(quota: QuotaSnapshot | undefined, ascii: boolean, detail: "full" | "bars" | "percent" = "full"): string | undefined {
  if (!quota) return undefined;
  const windows = [quota.primary, quota.secondary].filter((window) => window !== undefined);
  if (!windows.length) return undefined;
  return windows.map((window) => {
    const percent = `${Number(window.usedPercent.toFixed(1))}%`;
    if (detail === "percent") return percent;
    const full = window.usedPercent > 0 ? Math.max(1, Math.round(window.usedPercent / 10)) : 0;
    const bar = (ascii ? "#" : "█").repeat(full) + (ascii ? "-" : "░").repeat(10 - full);
    return `${bar} ${percent}${detail === "full" ? `[${formatReset(window.resetInMinutes)}]` : ""}`;
  }).join(" | ");
}
