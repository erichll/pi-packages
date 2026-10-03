import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CompactionState } from "../src/compaction.ts";

test("compaction success counts all file branches once and failure/cancel restore the base state", () => {
  let now = 0; const state = new CompactionState(() => now);
  const entry = (id: string): SessionEntry => ({ type: "compaction", id, parentId: null, timestamp: "", summary: "private", firstKeptEntryId: "message", tokensBefore: 1000 });
  const entries = [entry("a"), entry("b"), entry("a")];
  state.update(entries); assert.equal(state.snapshot().count, 2);
  state.start(); now = 3000; state.start(); assert.equal(state.snapshot().elapsedMs, 3000);
  state.finish("success", "c"); assert.equal(state.snapshot().count, 3);
  state.update([...entries, entry("c")]); assert.equal(state.snapshot().active, false);
  state.start(); state.finish("failed", undefined, "\x1b[2JHTTP https://private.example/path?api_key=secret token=secret\n" + "x".repeat(500));
  assert.equal(state.snapshot().count, 3); assert.equal(state.snapshot().active, false);
  assert.equal(state.snapshot().showFailure, true);
  assert.ok(!state.snapshot().last?.reason?.includes("secret")); assert.ok(state.snapshot().last!.reason!.length <= 180);
  state.activity(); assert.equal(state.snapshot().showFailure, false); assert.equal(state.snapshot().last?.status, "failed");
  state.start(); state.finish("cancelled"); assert.equal(state.snapshot().last?.status, "cancelled");
  state.update([...entries, entry("c")]); assert.equal(state.snapshot().count, 3);
  const restored = new CompactionState(); restored.update([...entries, entry("c")]);
  assert.equal(restored.snapshot().count, 3); assert.equal(restored.snapshot().last, undefined);
});
