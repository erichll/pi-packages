import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusline from "../src/index.ts";

test("RPC, JSON and print startup perform no terminal setup or session traversal", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let commands = 0;
  statusline({ on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand(name: string) { assert.equal(name, "statusline"); commands++; } } as unknown as ExtensionAPI);
  assert.equal(commands, 1);
  for (const mode of ["rpc", "json", "print"] as const) {
    const ctx = { mode, get ui() { throw new Error("Unexpected UI access"); }, get sessionManager() { throw new Error("Unexpected session traversal"); } } as unknown as ExtensionContext;
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    await handlers.get("message_end")!({ message: { role: "assistant" } }, ctx);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  }
});
