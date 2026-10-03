import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeState } from "../src/runtime.ts";
import { assistant, usage } from "./helpers.ts";

test("monotonic runs span retry, tools, UI and compaction, settling exactly once", () => {
  let now = 0;
  const state = new RuntimeState(() => now);
  assert.equal(state.snapshot().status, "Idle");
  assert.equal(state.snapshot().usage, null);
  state.start(); const id = state.id; state.turnStart();
  now = 10000; state.beforeSettle("error");
  assert.equal(state.start(), false); assert.equal(state.id, id);
  state.turnStart(); state.toolStart("one", "bash");
  now = 18000; state.toolEnd("one"); state.uiStart();
  now = 20000; state.uiEnd(); state.compaction(true);
  now = 28000; state.compaction(false); state.turnStart();
  state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().status, "Done");
  assert.equal(state.snapshot().elapsedMs, 28000);
  assert.equal(state.snapshot().turns, 3);
  now = 45000; state.settle(); assert.equal(state.snapshot().elapsedMs, 28000);
  assert.equal(state.snapshot(false).status, "Idle");
  state.start(); assert.notEqual(state.id, id); assert.equal(state.snapshot().turns, 0);
  state.beforeSettle("aborted"); state.settle(); assert.equal(state.snapshot().status, "Cancelled");
  state.start(); state.beforeSettle("error"); state.settle(); assert.equal(state.snapshot().status, "Failed");
  state.reset(); assert.equal(state.snapshot().status, "Idle"); assert.equal(state.snapshot().runId, null);
});

test("tools deduplicate IDs, include nested/concurrent activity and never decide run outcome", () => {
  let now = 0; const state = new RuntimeState(() => now); state.start(); state.turnStart();
  state.toolStart("parent", "\x1b[31mbash\x1b[0m\n"); now = 12000;
  state.toolStart("parent", "ignored"); state.toolStart("child", "read");
  assert.deepEqual(state.snapshot().tools, [{ name: "bash", elapsedMs: 12000 }, { name: "read", elapsedMs: 0 }]);
  assert.equal(state.snapshot().noContentMs, null);
  state.toolEnd("parent"); state.toolEnd("child"); state.toolStart("child", "duplicate");
  assert.equal(state.snapshot().tools.length, 0); assert.equal(state.snapshot().toolCalls, 2);
  state.beforeSettle("completed"); state.settle(); assert.equal(state.snapshot().status, "Done");
});

test("only nonempty content resets the observation window, with UI and compaction suppression", () => {
  let now = 0; const state = new RuntimeState(() => now); state.start(); state.turnStart();
  const message = assistant();
  now = 10000; assert.equal(state.snapshot().noContentMs, 10000);
  state.message(message);
  state.stream({ type: "text_delta", contentIndex: 0, delta: "", partial: message });
  assert.equal(state.snapshot().noContentMs, 10000);
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
    now += 1000; state.stream({ type, contentIndex: 0, delta: " ", partial: message });
    assert.equal(state.snapshot().noContentMs, 0);
  }
  state.uiStart(); state.uiStart(); now += 25000; assert.equal(state.snapshot().noContentMs, null);
  state.uiEnd(); assert.equal(state.snapshot().awaitingInput, true);
  state.uiEnd(); assert.equal(state.snapshot().noContentMs, 0);
  state.compaction(true); now += 15000; assert.equal(state.snapshot().noContentMs, null);
  state.compaction(false); assert.equal(state.snapshot().noContentMs, 0);
  now += 10000; state.turnStart(); assert.equal(state.snapshot().noContentMs, 0);
  state.message(message, true); assert.equal(state.snapshot().noContentMs, null);
});

test("assistant usage replaces provisional counters and reconciles final clones without duplicate totals", () => {
  let now = 0; const state = new RuntimeState(() => now); state.start(); state.turnStart();
  const first = assistant(1, usage(100, 20)); state.messageStart(first);
  state.message(first); state.message({ ...first, usage: usage(100, 40) });
  const final = { ...first, usage: usage(200, 80) };
  state.message(final, true); state.message(structuredClone(final), true); // persisted turn_end
  now = 2000;
  assert.equal(state.snapshot().usage?.output, 80); assert.equal(state.snapshot().avg, 40);
  assert.equal(state.snapshot().cache, 40 / 250);
  state.compaction(true); state.message(assistant(2, usage(10000, 5000)), true); state.compaction(false);
  assert.equal(state.snapshot().usage?.output, 80);
  state.turnStart(); const second = assistant(3, usage(100, 20)); state.messageStart(second); state.message(second, true);
  now = 4000; state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().usage?.output, 100); assert.equal(state.snapshot().avg, 25);
  assert.equal(state.snapshot().cache, 80 / 400);
  state.start(); state.message(assistant(4, { ...usage(), input: NaN })); assert.equal(state.snapshot().usage, null);
  state.message(assistant(4, { ...usage(0, 0), cacheRead: 0, cacheWrite: 0 })); assert.equal(state.snapshot().cache, null);
});

test("final aborted/error messages settle correctly without a before-settle event", () => {
  for (const [reason, expected] of [["aborted", "Cancelled"], ["error", "Failed"]] as const) {
    const state = new RuntimeState(); state.start(); state.turnStart();
    state.message({ ...assistant(), stopReason: reason }, true);
    state.settle(); assert.equal(state.snapshot().status, expected);
  }
  const state = new RuntimeState(); state.start(); state.turnStart();
  state.message({ ...assistant(), stopReason: "error" }, true);
  state.turnStart(); state.message(assistant(2), true); state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().status, "Done");
});

test("an observed abort survives a stale success message and boundary outcome", () => {
  const state = new RuntimeState(); state.start(); state.turnStart(); state.observeAbort();
  state.message(assistant(), true); state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().status, "Cancelled");
  state.start(); state.turnStart(); state.observeAbort(); state.turnStart();
  state.message(assistant(2), true); state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().status, "Done");
});
