import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTrapToBoundaryRequest } from "../src/integrations/sandbox.ts";

test("maps a Sandbox Runtime filesystem boundary without losing the resolved path", () => {
  assert.deepEqual(
    sandboxTrapToBoundaryRequest(
      {
        kind: "filesystem",
        query_id: "42",
        operation: "read",
        path: "/repo/secret",
        requested_path: "./secret",
        reason: "allow_miss",
        process: { pid: 7, exe: "/usr/bin/cat", cwd: "/repo" },
      },
      { cwd: "/fallback", command: "cat ./secret" },
    ),
    {
      id: "sandbox-runtime:42",
      source: "sandbox-runtime",
      surface: "filesystem-read",
      operation: "read",
      cwd: "/repo",
      command: "cat ./secret",
      path: "./secret",
      resolvedPath: "/repo/secret",
      toolName: "/usr/bin/cat",
      agentName: undefined,
      matchedPolicy: { decision: "ask", rule: "allow_miss" },
    },
  );
});

test("maps a Sandbox Runtime network boundary to an exact destination", () => {
  const request = sandboxTrapToBoundaryRequest(
    {
      kind: "network",
      operation: "connect",
      target: "api.example.com:443",
    },
    { cwd: "/repo" },
  );
  assert.equal(request.source, "sandbox-runtime");
  assert.equal(request.surface, "network");
  assert.equal(request.destination, "api.example.com:443");
});
