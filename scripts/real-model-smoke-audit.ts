import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const relevant = new Set([
  "review_decision",
  "grant_issued",
  "grant_consumed",
  "grant_rejected",
  "override_authorized",
  "override_consumed",
]);

export default function realModelSmokeAudit(pi: ExtensionAPI): void {
  const outputPath = process.env.PI_AUTO_REVIEW_SMOKE_AUDIT_PATH;
  const record = (value: Record<string, unknown>) => {
    const line = `PI_AUTO_REVIEW_SMOKE ${JSON.stringify(value)}\n`;
    process.stderr.write(line);
    if (outputPath) appendFileSync(outputPath, line, "utf8");
  };
  record({ type: "listener_ready" });
  pi.on("session_start", () => {
    const bash = pi.getAllTools().find((tool) => tool.name === "bash");
    record({
      type: "bash_tool",
      source:
        "sourceInfo" in (bash ?? {})
          ? (bash as { sourceInfo?: { path?: string } }).sourceInfo?.path
          : undefined,
      active: pi.getActiveTools().includes("bash"),
    });
  });
  pi.events.on(
    "pi-auto-review:audit",
    (event: {
      type?: string;
      requestId?: string;
      surface?: string;
      details?: Record<string, unknown>;
    }) => {
      if (!event.type || !relevant.has(event.type)) return;
      record({
          type: event.type,
          requestId: event.requestId,
          surface: event.surface,
          outcome: event.details?.outcome,
      });
    },
  );
}
