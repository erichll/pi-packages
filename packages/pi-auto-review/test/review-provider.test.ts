import assert from "node:assert/strict";
import test from "node:test";
import { completeSimple, getModels } from "@earendil-works/pi-ai/compat";
import {
  classifyProviderFailure,
  isRetryableError,
} from "../src/review/provider.ts";
import type { ReviewErrorClass } from "../src/review/types.ts";

test("busy codes and server-busy details are retryable transient failures", () => {
  const codedError = Object.assign(new Error("upstream failure"), {
    code: "server_busy",
  });
  assert.equal(classifyProviderFailure(undefined, codedError, {}), "transient_server");
  for (const detail of [
    "server_busy",
    "server busy",
    "servers-busy",
    "The servers are currently busy. Please try again later.",
    "The server is currently busy.",
  ]) {
    const errorClass = classifyProviderFailure(
      { stopReason: "error", errorMessage: detail }, undefined, {},
    );
    assert.equal(errorClass, "transient_server", detail);
    assert.equal(isRetryableError(errorClass), true, detail);
    assert.equal(classifyProviderFailure(undefined, new Error(detail), {}), errorClass);
  }
  assert.equal(isRetryableError(classifyProviderFailure(undefined, codedError, {})), true);
});

test("HTTP status keeps precedence over busy and Mistral error text", () => {
  const cases: Array<[number, ReviewErrorClass, boolean]> = [
    [408, "timeout", false],
    [429, "rate_limit", true],
    [500, "transient_server", true],
    [503, "transient_server", true],
    [599, "transient_server", true],
    [401, "authentication", false],
    [403, "authentication", false],
    [400, "request_configuration", false],
    [404, "request_configuration", false],
    [409, "request_configuration", false],
    [422, "request_configuration", false],
  ];
  for (const [status, expectedClass, retryable] of cases) {
    const error = Object.assign(new Error("Provider stopped with: error"), {
      status, code: "server_busy",
    });
    assert.equal(classifyProviderFailure(undefined, error, {}), expectedClass);
    const fromMetadata = classifyProviderFailure(
      { errorMessage: "servers are currently busy" }, undefined, { status },
    );
    assert.equal(fromMetadata, expectedClass);
    assert.equal(isRetryableError(fromMetadata), retryable);
  }
});

test("existing connection codes and non-retryable failures keep their classification", () => {
  for (const code of [
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETDOWN", "ENETRESET",
    "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  ]) {
    const errorClass = classifyProviderFailure(undefined, { code }, {});
    assert.equal(errorClass, "transient_connection", code);
    assert.equal(isRetryableError(errorClass), true, code);
  }
  for (const [detail, expected] of [
    ["invalid api key", "authentication"],
    ["unknown model", "model_resolution"],
    ["invalid request", "request_configuration"],
    ["request timed out", "timeout"],
    ["my local tool is currently busy", "unknown"],
    ["Provider stopped with: sensitive", "unknown"],
    ["Provider stopped with: unexpected", "unknown"],
    ["unclassified failure", "unknown"],
  ] as const) {
    const errorClass = classifyProviderFailure({ errorMessage: detail }, undefined, {});
    assert.equal(errorClass, expected, detail);
    assert.equal(isRetryableError(errorClass), false, detail);
  }
});

test("old and new Mistral finish_reason error messages are retryable", () => {
  for (const errorMessage of [
    "Provider stopped with: error",
    "Provider stopped with: error (server error)",
  ]) {
    const errorClass = classifyProviderFailure({ stopReason: "error", errorMessage }, undefined, {});
    assert.equal(errorClass, "transient_server");
    assert.equal(isRetryableError(errorClass), true);
  }
});

test("real completeSimple exposes Mistral finish_reason error through the compat adapter", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "partial output" }, finish_reason: "error" }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const message = await completeSimple(
      getModels("mistral")[0]!,
      { messages: [{ role: "user", content: "synthetic test", timestamp: Date.now() }] },
      { apiKey: "synthetic-test-key", maxRetries: 0 },
    );
    assert.equal(calls, 1);
    assert.equal(message.stopReason, "error");
    // pi-ai 1.1.0 adds the server-error suffix; 1.0.x returns the bare text.
    assert.match(message.errorMessage ?? "", /^Provider stopped with: error(?: \(server error\))?$/);
    assert.equal(classifyProviderFailure(message, undefined, { status: 200 }), "transient_server");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
