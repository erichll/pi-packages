import { PolicyAuditStore } from "../../src/policy-audit/store.ts";

const [directory, requestId] = process.argv.slice(2);
if (!directory || !requestId) throw new Error("expected audit directory and request ID");
const store = await PolicyAuditStore.open({ directory, retentionDays: 180 });
try {
  const recorded = store.record("/work/shared-project", {
    requestId,
    surface: "bash",
    signature: "git status",
    bashCategory: "simple",
    risk: "read_only",
    pathClass: "unknown",
    features: [],
    result: "allow",
    resolution: "user_approved",
    origin: "project",
    forwarded: false,
  });
  const result = store.query({ days: 30, top: 20, minCount: 1, scope: "all", projectPath: "/ignored" });
  console.log(JSON.stringify({ recorded, total: result.rows.reduce((sum, row) => sum + row.count, 0) }));
} finally {
  store.close();
}
