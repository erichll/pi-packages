import assert from "node:assert/strict";
import test from "node:test";
import { formatSandboxTrap } from "../src/traps.ts";

test("formats filesystem and network sandbox boundaries", () => {
  assert.equal(
    formatSandboxTrap({
      kind: "filesystem",
      operation: "read",
      path: "/home/user/secret",
    }),
    "read /home/user/secret",
  );
  assert.equal(
    formatSandboxTrap({
      kind: "network",
      operation: "connect",
      target: "api.example.com:443",
    }),
    "connect api.example.com:443",
  );
});
