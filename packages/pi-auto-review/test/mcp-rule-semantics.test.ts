import assert from "node:assert/strict";
import test from "node:test";
// These deep imports reach pi-permission-system internals that its public
// entry (".") does not export, and they are pinned to the 33.x source layout:
// 33.0.0 changed both the MCP target derivation and the MCP rule evaluator, so
// re-verify every path below when the devDependency line moves again.
//
// Like test/authorizer-integration.test.ts, this file is excluded from `tsc`:
// upstream ships raw .ts sources with extensionless relative imports, which the
// package's NodeNext type-check cannot resolve. `npm test` loads them through
// test/register-external-ts.mjs instead.
import { createMcpPermissionTargets } from "../../../node_modules/@gotgenes/pi-permission-system/src/access-intent/mcp-targets.ts";
import {
  evaluateAnyValue,
  type Rule,
  type Ruleset,
} from "../../../node_modules/@gotgenes/pi-permission-system/src/policy/rule.ts";
import { posixPathFlavor } from "../../../node_modules/@gotgenes/pi-permission-system/src/path/path-flavor.ts";
import { normalizePermissionEvidence } from "../src/policy.ts";
import { reviewTargetFromRequest } from "../src/user-feedback.ts";

const SERVER = "atlassian";
const TOOL = "atlassian_getJiraIssue";

function mcpRule(pattern: string, action: "allow" | "deny"): Rule {
  return { surface: "mcp", pattern, action, layer: "config", origin: "global" };
}

test("a prefix-named MCP tool derives its bare server, not a double-prefixed alias", () => {
  const withServerHint = createMcpPermissionTargets(
    { tool: TOOL, server: SERVER },
    [SERVER],
  );
  assert.deepEqual(withServerHint, [TOOL, SERVER, "mcp_call"]);
  // The 32.x derivation led with `atlassian_atlassian_getJiraIssue`, a name no
  // rule can usefully carry. Assert it stays gone: it made rule-matched
  // verdicts depend on which alias was reported rather than on rule order.
  assert.ok(!withServerHint.includes(`${SERVER}_${SERVER}_getJiraIssue`));

  // The same tool name without a server hint resolves identically, so a
  // reviewer prompt and a rule decision agree between the two call shapes.
  assert.deepEqual(
    createMcpPermissionTargets({ tool: TOOL }, [SERVER]),
    withServerHint,
  );
});

test("an MCP rule naming the server reaches a prefix-named tool, last match deciding", () => {
  const targets = createMcpPermissionTargets({ tool: TOOL }, [SERVER]);

  const broadThenServer: Ruleset = [mcpRule("*", "allow"), mcpRule(SERVER, "deny")];
  const denied = evaluateAnyValue("mcp", targets, broadThenServer, posixPathFlavor);
  assert.equal(denied.rule.action, "deny");
  assert.equal(denied.rule.pattern, SERVER);
  assert.equal(denied.value, SERVER);

  // Rule position, not candidate order, decides: a catch-all written last
  // re-allows the same call, and the reported name is the most specific
  // candidate that rule matches.
  const serverThenBroad: Ruleset = [mcpRule(SERVER, "deny"), mcpRule("*", "allow")];
  const allowed = evaluateAnyValue("mcp", targets, serverThenBroad, posixPathFlavor);
  assert.equal(allowed.rule.action, "allow");
  assert.equal(allowed.rule.pattern, "*");
  assert.equal(allowed.value, TOOL);
});

test("a tool rule still wins over a server rule when it is written later", () => {
  const targets = createMcpPermissionTargets({ tool: TOOL }, [SERVER]);
  const rules: Ruleset = [
    mcpRule(SERVER, "deny"),
    mcpRule(TOOL, "allow"),
  ];
  const allowed = evaluateAnyValue("mcp", targets, rules, posixPathFlavor);
  assert.equal(allowed.rule.action, "allow");
  assert.equal(allowed.rule.pattern, TOOL);
  assert.equal(allowed.value, TOOL);
});

test("MCP access intent is forwarded verbatim and shown as the boundary value", () => {
  const targets = createMcpPermissionTargets({ tool: TOOL }, [SERVER]);
  const evidence = normalizePermissionEvidence({
    surface: "mcp",
    toolName: "mcp",
    toolInputPreview: JSON.stringify({ tool: TOOL }),
    accessIntent: {
      surface: "mcp",
      matchValues: targets,
      boundaryValue: targets[0],
    },
  });

  assert.equal(evidence.surface, "mcp");
  assert.deepEqual(evidence.accessIntent?.matchValues, targets);
  assert.equal(evidence.resolvedPath, TOOL);
  // The reviewer and the audit trail must show the tool name rather than a
  // synthesized alias, because the displayed target is what an operator
  // decides on.
  assert.equal(
    reviewTargetFromRequest({
      resolvedPath: evidence.resolvedPath,
      toolName: "mcp",
    }),
    TOOL,
  );
});
