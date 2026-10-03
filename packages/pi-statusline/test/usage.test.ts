import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { UsageCache, readUsage } from "../src/usage.ts";
import { assistant, messageEntry, usage } from "./helpers.ts";

test("streaming replaces one provisional response and persistence does not count it twice", () => {
  const cache = new UsageCache();
  const first = messageEntry("1");
  cache.update([first]);
  cache.setLive(assistant(2, usage(200, 5, 0.2)));
  assert.equal(cache.snapshot().input, 300);
  cache.setLive(assistant(2, usage(200, 35, 0.3)));
  assert.equal(cache.snapshot().input, 300);
  assert.equal(cache.snapshot().output, 55);
  const final = messageEntry("2", assistant(2, usage(200, 35, 0.3)));
  cache.update([first, final]);
  assert.equal(cache.snapshot().input, 300);
  assert.equal(cache.snapshot().output, 55);
  cache.update([first, final]);
  assert.equal(cache.snapshot().cost, 0.4);
});

test("all recorded usage categories survive compaction and navigation, but private subagent details do not add spend", () => {
  const base = { parentId: null, timestamp: new Date(0).toISOString() };
  const entries = [
    messageEntry("1"),
    { ...base, type: "usage", id: "2", kind: "cache_warm", provider: "x", model: "y", usage: usage() },
    { ...base, type: "compaction", id: "3", summary: "Summary", firstKeptEntryId: "1", tokensBefore: 100, usage: usage() },
    { ...base, type: "branch_summary", id: "4", fromId: "1", summary: "Other branch", usage: usage() },
    { ...base, type: "message", id: "5", message: { role: "toolResult", toolName: "example", toolCallId: "x", content: [], isError: false, timestamp: 5, usage: usage() } },
    { ...base, type: "custom_message", id: "6", customType: "subagent-slash-result", content: "result", display: true, details: { cost: 100 } },
  ] as SessionEntry[];
  const cache = new UsageCache();
  cache.update(entries);
  assert.equal(cache.snapshot().input, 500);
  assert.equal(cache.snapshot().cost, 0.5);
  cache.update(entries, true);
  assert.equal(cache.snapshot().cost, 0.5);
  cache.reset();
  cache.update([messageEntry("new")]);
  assert.equal(cache.snapshot().cost, 0.1);
});

test("invalid provider counters are ignored and amended trailing entries replace old totals", () => {
  assert.deepEqual(readUsage({ input: NaN, output: -1, cacheRead: Infinity, cost: { total: "1" } }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const cache = new UsageCache();
  cache.update([messageEntry("1")]);
  cache.update([messageEntry("1", assistant(1, usage(300, 50, 0.5)))]);
  assert.equal(cache.snapshot().input, 300);
  assert.equal(cache.snapshot().cost, 0.5);
});
