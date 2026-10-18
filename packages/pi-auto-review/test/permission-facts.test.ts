import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeDecidingPath, normalizeDelegationLicense } from "../src/permission-facts.ts";
import { normalizePermissionEvidence } from "../src/policy.ts";
import { boundaryRequest } from "../src/review/input.ts";
import { boundaryRequestHash } from "../src/broker/grants.ts";
import { PolicyAuditController, PolicyAuditStore } from "../src/policy-audit/index.ts";

const pathFact = { path: "/Sheet1/B1", effect: "unproven", effectSource: "declared-project" } as const;
const intent = {
  surface: "external_directory", matchValues: ["/Sheet1/B1"], boundaryValue: "/Sheet1/B1",
  delegationLicense: "nothing-on-disk",
};

test("bounded path facts reject malformed values and copy only known members", () => {
  assert.deepEqual(normalizeDecidingPath({ ...pathFact, extra: "never propagate" }), pathFact);
  assert.ok(Object.isFrozen(normalizeDecidingPath(pathFact)));
  for (const value of [
    null, [], "read", {}, { ...pathFact, path: " " }, { ...pathFact, path: "x".repeat(16_385) },
    { ...pathFact, effect: "delete" }, { ...pathFact, effectSource: "model" },
    { ...pathFact, effect: { toString: () => "read" } },
  ]) assert.equal(normalizeDecidingPath(value), undefined);
  assert.equal(normalizeDelegationLicense(intent), "nothing-on-disk");
  assert.equal(normalizeDelegationLicense({ ...intent, surface: "external_directory_read" }), "nothing-on-disk");
  for (const value of [undefined, {}, { ...intent, surface: "path" }, { ...intent, surface: "bash" },
    { ...intent, delegationLicense: "model-allow" }]) {
    assert.equal(normalizeDelegationLicense(value), undefined);
  }
});

test("only structured gate facts reach direct/forwarded reviewer requests", () => {
  for (const forwarding of [undefined, { requesterAgentName: "worker", requesterSessionId: "child" }]) {
    const details = {
      requestId: "facts-ask", source: "tool_call", toolName: "bash",
      command: "officecli set data.xlsx /Sheet1/B1", accessIntent: intent, forwarding,
      payload: { request: { decidingPath: pathFact } },
    };
    const evidence = normalizePermissionEvidence(details);
    assert.deepEqual(evidence.decidingPath, pathFact);
    assert.equal(evidence.accessIntent?.delegationLicense, "nothing-on-disk");
    const request = boundaryRequest({ cwd: "/work" } as never, details as never, {
      checkPermission: () => "ask",
    } as never);
    assert.deepEqual(request.decidingPath, pathFact);
    assert.deepEqual(request.accessIntent, evidence.accessIntent);
    assert.equal(request.requesterSessionId, forwarding?.requesterSessionId);
    const hash = boundaryRequestHash(request);
    assert.notEqual(hash, boundaryRequestHash({ ...request, decidingPath: { ...pathFact, effectSource: "core" } }));
    assert.notEqual(hash, boundaryRequestHash({ ...request, accessIntent: { ...request.accessIntent!, delegationLicense: undefined } }));
  }
  const preview = normalizePermissionEvidence({
    surface: "external_directory", toolInputPreview: JSON.stringify({ decidingPath: pathFact, accessIntent: intent }),
  });
  assert.equal(preview.decidingPath, undefined);
  assert.equal(preview.accessIntent, undefined);
  const wrongSurface = normalizePermissionEvidence({
    surface: "bash", payload: { request: { decidingPath: pathFact } },
  });
  assert.equal(wrongSurface.decidingPath, undefined);
});

test("audit joins finite path provenance without storing raw paths or granting safer recommendations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-facts-audit-"));
  const secretPath = "/Sheet1/private-cell-unique-885efc";
  const audit = new PolicyAuditController({
    config: () => ({ enabled: true, retentionDays: 180 }),
    cwd: () => "/work/project", directory,
    warn: (message) => assert.fail(message),
  });
  try {
    audit.noteRequest("ask-1", {
      surface: "external_directory", decidingPath: { ...pathFact, path: secretPath }, accessIntent: intent,
    });
    // The UI omits accessIntent; it must not erase the earlier license.
    audit.notePrompt({ requestId: "ask-1", request: { surface: "external_directory", decidingPath: { ...pathFact, path: secretPath } } });
    audit.record({ requestId: "ask-1", surface: "external_directory", value: secretPath,
      result: "allow", resolution: "authorizer_allowed", origin: "project" });
    const { report, markdown } = await audit.report({ days: 30, top: 20, minCount: 1, scope: "current" });
    assert.equal(report.total, 1);
    assert.match(report.pathAttributions![0]!.name, /effect_source:declared-project/);
    assert.match(report.pathAttributions![0]!.name, /delegation_license:nothing-on-disk/);
    assert.match(markdown, /Path effect attribution/);
    assert.equal(report.suggestedAllowRules.length, 0, "declarations do not promote machine allows into recommendation evidence");
    assert.equal(JSON.stringify(report).includes(secretPath), false);
    await audit.close();
    const store = await PolicyAuditStore.open({ directory, retentionDays: 180 });
    try {
      const result = store.query({ days: 30, top: 20, minCount: 1, scope: "current", projectPath: "/work/project" });
      assert.equal(result.rows[0]!.features, "delegation_license:nothing-on-disk,effect:unproven,effect_source:declared-project");
    } finally { store.close(); }
    assert.equal(readFileSync(join(directory, "policy-audit.sqlite")).includes(Buffer.from(secretPath)), false);
  } finally {
    await audit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
