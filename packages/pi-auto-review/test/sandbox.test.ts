import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTrapToBoundaryRequest, parseHostPort } from "../src/integrations/sandbox.ts";

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
  assert.equal(request.destinationHost, "api.example.com");
  assert.equal(request.destinationPort, 443);
  assert.equal(request.destinationProtocol, undefined);
});

test("parseHostPort splits a valid host:port string", () => {
  assert.deepEqual(parseHostPort("example.com:8443"), {
    host: "example.com",
    port: 8443,
  });
});

test("parseHostPort returns host only when port is absent", () => {
  assert.deepEqual(parseHostPort("example.com"), {
    host: "example.com",
    port: undefined,
  });
});

test("parseHostPort rejects out-of-range ports", () => {
  assert.deepEqual(parseHostPort("example.com:0"), {
    host: "example.com:0",
    port: undefined,
  });
  assert.deepEqual(parseHostPort("example.com:70000"), {
    host: "example.com:70000",
    port: undefined,
  });
});

test("parseHostPort returns undefined for undefined input", () => {
  assert.equal(parseHostPort(undefined), undefined);
});
