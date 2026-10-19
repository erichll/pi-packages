import { appendFileSync } from "node:fs";

export function writeOptionalAuditFile(event: unknown): void {
  const auditFile = process.env.PI_AUTO_REVIEW_AUDIT_FILE;
  if (!auditFile) return;
  try {
    appendFileSync(auditFile, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // The optional test/release audit sink is observational only.
  }
}

// Fields that may carry (sanitized) provider text. They are written only to
// the opt-in PI_AUTO_REVIEW_AUDIT_FILE sink and never broadcast on pi.events.
const FILE_ONLY_FIELDS = ["errorDetail"] as const;

export function withoutFileOnlyFields<T extends object>(event: T): T {
  if (!FILE_ONLY_FIELDS.some((field) => field in event)) return event;
  const copy = { ...event } as Record<string, unknown>;
  for (const field of FILE_ONLY_FIELDS) delete copy[field];
  return copy as T;
}

export const MAX_ERROR_DETAIL_CHARACTERS = 500;

const SECRET_KEY =
  "authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|set-cookie";

// Best-effort redaction of provider error text before it reaches the opt-in
// audit file. Errors can echo request headers, keys, or signed URLs.
export function sanitizeErrorDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw;
  // Authorization schemes: "Bearer abc", "Basic abc".
  text = text.replace(
    /\b(bearer|basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi,
    "$1 [REDACTED]",
  );
  // key: value / key=value / "key": "value"
  text = text.replace(
    new RegExp(
      `((?:${SECRET_KEY})["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED\\]|(?:bearer|basic)\\s)[^\\s"',;}&]+`,
      "gi",
    ),
    "$1[REDACTED]",
  );
  // Well-known credential prefixes (OpenAI/Anthropic, GitHub, Copilot, Google).
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|tid=[^\s;"']+|AIza[0-9A-Za-z_-]{20,})/g,
    "[REDACTED]",
  );
  // JWTs.
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    "[REDACTED]",
  );
  // URL query values.
  text = text.replace(
    /(https?:\/\/[^\s?#"']+)\?[^\s#"']*/gi,
    "$1?[REDACTED]",
  );
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_ERROR_DETAIL_CHARACTERS
    ? `${text.slice(0, MAX_ERROR_DETAIL_CHARACTERS)}…`
    : text;
}
