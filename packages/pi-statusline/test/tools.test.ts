import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { toolTarget } from "../src/tools.ts";

test("shell targets show the command that runs, without cd and env prefixes", () => {
  assert.equal(toolTarget("bash", { command: "npm test" }), "npm test");
  assert.equal(toolTarget("bash", { command: "cd /a/b && FOO=1 BAR='x y' npm run check" }), "npm run check");
  assert.equal(toolTarget("bash", { command: 'cd "dir with space"; git status --short' }), "git status --short");
  assert.equal(toolTarget("powershell", { command: "\n\nGet-ChildItem\nmore" }), "Get-ChildItem");
  assert.equal(toolTarget("bash", { command: "python3 -c 'print(1)' && echo done and more text" }), "python3 -c 'print(1)' &…");
  assert.equal(toolTarget("bash", { command: "cd /repo" }), "cd /repo", "a bare cd is what runs");
  assert.equal(toolTarget("bash", { command: "\x1b[31mrm\x1b[0m -i\tx" }), "rm -i x");
});

test("file, search and listing targets are short and sanitized", () => {
  assert.equal(toolTarget("read", { path: "/repo/src/render.ts" }), "render.ts");
  assert.equal(toolTarget("write", { path: "notes.md" }), "notes.md");
  assert.equal(toolTarget("grep", { pattern: "QuotaState" }), '"QuotaState"');
  assert.equal(toolTarget("find", { pattern: "**/*.test.ts and more" }), '"**/*.test.ts an…"');
  assert.equal(toolTarget("ls", { path: "/repo/src/" }), "src/");
  assert.equal(toolTarget("ls", { path: "." }), undefined);
  assert.equal(toolTarget("ls", {}), undefined);
  assert.ok(visibleWidth(toolTarget("read", { path: "/x/" + "中".repeat(40) })!) <= 24);
});

test("unknown tools and malformed arguments show no target", () => {
  assert.equal(toolTarget("web_search", { query: "x" }), undefined);
  for (const args of [undefined, null, "npm test", 1, { command: 42 }, { path: ["a"] }]) {
    assert.equal(toolTarget("bash", args), undefined); assert.equal(toolTarget("read", args), undefined);
  }
});
