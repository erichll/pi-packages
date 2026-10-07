import assert from "node:assert/strict";
import test from "node:test";
// These real permission-system internals are verified against 40.0.2. Like
// authorizer-integration.test.ts, this file is excluded from tsc and loaded
// through register-external-ts.mjs because upstream uses extensionless imports.
import { BashProgram } from "../../../node_modules/@gotgenes/pi-permission-system/src/access-intent/bash/program.ts";
import { resolveBashCommandCheck } from "../../../node_modules/@gotgenes/pi-permission-system/src/handlers/gates/bash-command.ts";
import { GateRunner } from "../../../node_modules/@gotgenes/pi-permission-system/src/handlers/gates/runner.ts";
import { PathNormalizer } from "../../../node_modules/@gotgenes/pi-permission-system/src/path/path-normalizer.ts";
import { posixPathFlavor } from "../../../node_modules/@gotgenes/pi-permission-system/src/path/path-flavor.ts";
import { PermissionManager } from "../../../node_modules/@gotgenes/pi-permission-system/src/policy/permission-manager.ts";
import { PermissionResolver } from "../../../node_modules/@gotgenes/pi-permission-system/src/policy/permission-resolver.ts";
import { buildToolAskPayload } from "../../../node_modules/@gotgenes/pi-permission-system/src/presentation/tool-ask-payload.ts";
import { SessionRules } from "../../../node_modules/@gotgenes/pi-permission-system/src/session/session-rules.ts";
import { boundaryRequest } from "../src/review/input.ts";

const cwd = "/repo";
const normalizer = new PathNormalizer(posixPathFlavor, cwd);

function policy(patterns: Record<string, "allow" | "ask" | "deny">) {
  const manager = new PermissionManager({
    flavor: posixPathFlavor,
    policyLoader: {
      loadGlobalConfig: () => ({ permission: { "*": "allow", bash: patterns } }),
      loadProjectConfig: () => ({}),
      loadAgentConfig: () => ({}),
      loadProjectAgentConfig: () => ({}),
      getConfiguredMcpServerNames: () => [],
      getCacheStamp: () => "test-policy",
      getResolvedPolicyPaths: () => { throw new Error("unused by permission resolution"); },
    },
  });
  const sessionRules = new SessionRules();
  return { resolver: new PermissionResolver(manager, sessionRules), sessionRules };
}

function descriptor(command: string, check: ReturnType<typeof resolveBashCommandCheck>) {
  return {
    surface: "bash",
    input: { command },
    preCheck: check,
    payload: buildToolAskPayload({ check, agentName: null, surface: "bash", input: { command } }),
    promptDetails: { source: "tool_call" as const, agentName: null, toolName: "bash", command: check.command },
    logContext: {},
    decision: { surface: "bash", value: check.command ?? command },
  };
}

test("absolute bash rules match relative spelling and preserve the actual command", async () => {
  const command = "cat ./notes.txt";
  const absolute = "cat /repo/notes.txt";
  const program = await BashProgram.parse(command, normalizer);
  assert.ok(program.commands().some((unit) => unit.spellings?.includes(absolute)));
  for (const action of ["allow", "ask", "deny"] as const) {
    const { resolver } = policy({ "*": "allow", [absolute]: action });
    const check = resolveBashCommandCheck(command, program.commands(), undefined, resolver);
    assert.equal(check.state, action);
    assert.equal(check.command, command);
    assert.equal(check.matchedPattern, absolute);
    assert.equal(check.matchedSpelling, absolute);
    const payload = descriptor(command, check).payload;
    assert.equal(payload.request.matchedSpelling, absolute);
    const request = boundaryRequest({ cwd } as never, {
      requestId: `spelling-${action}`, source: "tool_call", agentName: null,
      toolName: "bash", command, payload,
    }, resolver);
    assert.equal(request.command, command);
    assert.equal(request.matchedPattern, absolute);
    assert.equal(request.matchedSpelling, absolute);

    const typedProgram = await BashProgram.parse(absolute, normalizer);
    const typedCheck = resolveBashCommandCheck(absolute, typedProgram.commands(), undefined, resolver);
    assert.equal(typedCheck.state, action);
    assert.equal(typedCheck.matchedSpelling, undefined);
    assert.equal(descriptor(absolute, typedCheck).payload.request.matchedSpelling, null);
  }
});

test("/dev/null redirects preserve core-reader wrapper exemption but file writes do not", async () => {
  const { resolver } = policy({ "*": "allow" });
  for (const suffix of ["", " >/dev/null", " 2>/dev/null", " >/dev/null 2>&1"]) {
    const command = `xargs cat${suffix}`;
    const program = await BashProgram.parse(command, normalizer);
    assert.equal(program.commands()[0]?.floorExemption, "core-reader", command);
    const check = resolveBashCommandCheck(command, program.commands(), undefined, resolver);
    assert.equal(check.state, "allow", command);
    assert.equal(check.floorExemption, "core-reader", command);
  }
  const command = "xargs cat >out.txt";
  const program = await BashProgram.parse(command, normalizer);
  assert.equal(program.commands()[0]?.floorExemption, undefined);
  const check = resolveBashCommandCheck(command, program.commands(), undefined, resolver);
  assert.equal(check.state, "ask");
  assert.equal(check.matchedPattern, "<indirection-bash-wrapper>");
});

test("a wrapper unit's session grant cannot approve an asking or denied sibling", async () => {
  for (const granted of ['eval "$SCRIPT"', "sudo git status"]) {
    const { resolver, sessionRules } = policy({ "*": "allow", "git push *": "ask", "git clean *": "deny" });
    sessionRules.approve("bash", granted);
    let prompts = 0;
    const decisions: Array<Record<string, unknown>> = [];
    const runner = new GateRunner(resolver, sessionRules, {
      async escalate(details) {
        prompts++;
        assert.equal(details.payload.request.value, "git push origin main");
        return { approved: false, state: "denied", decidedBy: { kind: "user" } };
      },
    }, { writeReviewLog() {}, emitDecision(event) { decisions.push(event); } }, () => false);

    const soloProgram = await BashProgram.parse(granted, normalizer);
    const solo = resolveBashCommandCheck(granted, soloProgram.commands(), undefined, resolver);
    assert.equal(solo.state, "allow");
    assert.equal(solo.source, "session");
    assert.equal((await runner.run(descriptor(granted, solo), null)).action, "allow");
    assert.equal(prompts, 0);

    const command = `${granted} && git push origin main`;
    const program = await BashProgram.parse(command, normalizer);
    const check = resolveBashCommandCheck(command, program.commands(), undefined, resolver);
    assert.equal(check.state, "ask");
    assert.notEqual(check.source, "session");
    assert.equal(check.command, "git push origin main");
    assert.deepEqual(check.askingUnits, [{ command: "git push origin main" }]);
    assert.equal((await runner.run(descriptor(command, check), null)).action, "block");
    assert.equal(prompts, 1);
    assert.equal(decisions.at(-1)?.result, "deny");

    const deniedCommand = `${granted} && git clean -fd`;
    const deniedProgram = await BashProgram.parse(deniedCommand, normalizer);
    const denied = resolveBashCommandCheck(deniedCommand, deniedProgram.commands(), undefined, resolver);
    assert.equal(denied.state, "deny");
    assert.equal((await runner.run(descriptor(deniedCommand, denied), null)).action, "block");
    assert.equal(prompts, 1, "a sibling policy deny never prompts");
  }
});

test("an unresolved session-granted unit stays allow rather than winning a sibling's ask", async () => {
  const { resolver, sessionRules } = policy({ "*": "allow", "git push *": "ask" });
  sessionRules.approve("bash", "echo known");
  const command = "echo known && git push origin main";
  const program = await BashProgram.parse(command, normalizer);
  // The parser recovery marker is supplied explicitly to exercise the floor
  // independently of tree-sitter's changing recovery for malformed programs.
  const units = program.commands().map((unit, index) => index === 0 ? { ...unit, parseUnresolved: true } : unit);
  const check = resolveBashCommandCheck(command, units, undefined, resolver);
  assert.equal(check.state, "ask");
  assert.notEqual(check.source, "session");
  assert.equal(check.command, "git push origin main");
  assert.deepEqual(check.askingUnits, [{ command: "git push origin main" }]);
});

test("GateRunner cannot fast-path a session-sourced check clamped to ask", async () => {
  const { resolver, sessionRules } = policy({ "*": "allow" });
  let prompts = 0;
  const runner = new GateRunner(resolver, sessionRules, {
    async escalate() {
      prompts++;
      return { approved: false, state: "denied", decidedBy: { kind: "user" } };
    },
  }, { writeReviewLog() {}, emitDecision() {} }, () => false);
  const check = { toolName: "bash", command: "unknown", state: "ask" as const, source: "session" as const, origin: "session" as const };
  assert.equal((await runner.run(descriptor("unknown", check), null)).action, "block");
  assert.equal(prompts, 1);
});
