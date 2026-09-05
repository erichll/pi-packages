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
