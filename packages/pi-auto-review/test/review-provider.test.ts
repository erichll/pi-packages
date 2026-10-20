import assert from "node:assert/strict";
import test from "node:test";
import { completeSimple, getModels } from "@earendil-works/pi-ai/compat";
import {
  classifyProviderFailure,
  endpointHost,
  isRetryableError,
  modelCall,
  requestModelForAuth,
} from "../src/review/provider.ts";
import { DEFAULT_CONFIG } from "../src/review/config.ts";
import {
  MAX_ERROR_DETAIL_CHARACTERS,
  sanitizeErrorDetail,
  withoutFileOnlyFields,
} from "../src/review/audit.ts";
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

test("sanitizeErrorDetail redacts credentials, signed URLs, and bounds length", () => {
  const raw = [
    "401 Unauthorized",
    "Authorization: Bearer abc.def-ghi",
    "Basic dXNlcjpwYXNz",
    '{"api_key": "plain-secret-1", "x-api-key":"plain-secret-2"}',
    "token=plain-secret-3; refresh_token: plain-secret-4",
    "sk-ant-api03-plainsecret5 ghu_plainsecret6 github_pat_plain_secret7",
    "tid=plain-secret-8;exp=1;sku=x",
    "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    "https://copilot.example.test/chat?sig=plain-secret-9&x=1",
  ].join("\n");
  const detail = sanitizeErrorDetail(raw);
  assert.ok(detail);
  assert.match(detail, /^401 Unauthorized /);
  assert.doesNotMatch(detail, /plain-?secret|abc\.def|dXNlcjpwYXNz|eyJ|\n/);
  assert.match(detail, /Bearer \[REDACTED\]/);
  assert.match(detail, /https:\/\/copilot\.example\.test\/chat\?\[REDACTED\]/);
  // Ordinary words that merely mention tokens survive.
  assert.equal(sanitizeErrorDetail("IDE token expired"), "IDE token expired");

  const long = sanitizeErrorDetail("x".repeat(MAX_ERROR_DETAIL_CHARACTERS + 50));
  assert.equal(long?.length, MAX_ERROR_DETAIL_CHARACTERS + 1);
  assert.ok(long?.endsWith("…"));
  assert.equal(sanitizeErrorDetail("   "), undefined);
  assert.equal(sanitizeErrorDetail(undefined), undefined);
});

test("requestModelForAuth overlays only a credential endpoint", () => {
  const catalog = {
    id: "gpt-6-luna",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "Copilot-Integration-Id": "vscode-chat" },
  };
  assert.equal(requestModelForAuth(catalog, { apiKey: "token" }), catalog);
  const request = requestModelForAuth(catalog, {
    apiKey: "token",
    baseUrl: "https://api.business.githubcopilot.com",
  });
  assert.equal(request.baseUrl, "https://api.business.githubcopilot.com");
  assert.equal(request.headers["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(catalog.baseUrl, "https://api.individual.githubcopilot.com");
  assert.notEqual(request, catalog);
  assert.equal(requestModelForAuth(catalog, { apiKey: "token", baseUrl: "" }), catalog);
});

test("real pi-ai sends a Copilot reviewer request to the credential host", async () => {
  const catalog = getModels("github-copilot").find((model) => model.id === "gpt-6-luna");
  assert.ok(catalog, "pi-ai catalog must still ship github-copilot/gpt-6-luna");
  assert.equal(catalog.api, "openai-responses");
  assert.equal(catalog.baseUrl, "https://api.individual.githubcopilot.com");
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return new Response("Unauthorized", { status: 401 });
  };
  try {
    const auth = {
      apiKey: "tid=test;proxy-ep=proxy.business.githubcopilot.com",
      baseUrl: "https://api.business.githubcopilot.com",
    };
    const metadata = {};
    const message = await modelCall(
      { model: requestModelForAuth(catalog, auth), auth, sessionId: "pi-auto-review-test" },
      DEFAULT_CONFIG,
      new AbortController(),
      "synthetic review request",
      64,
      5_000,
      false,
      metadata,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://api.business.githubcopilot.com/responses");
    assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${auth.apiKey}`);
    assert.equal(requests[0]!.headers.get("copilot-integration-id"), "vscode-chat");
    assert.equal(requests[0]!.headers.get("x-initiator"), "user");
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /^github-copilot API error \(401\)/);
    assert.equal(catalog.baseUrl, "https://api.individual.githubcopilot.com");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("endpointHost keeps only the host and port", () => {
  assert.equal(endpointHost("https://api.business.githubcopilot.com"), "api.business.githubcopilot.com");
  assert.equal(
    endpointHost("https://user:secret@proxy.example.test:8443/v1/path?sig=query-secret"),
    "proxy.example.test:8443",
  );
  assert.equal(endpointHost("not a url"), undefined);
  assert.equal(endpointHost(""), undefined);
  assert.equal(endpointHost(undefined), undefined);
});

test("withoutFileOnlyFields strips errorDetail and endpointHost without mutating the event", () => {
  const event = {
    type: "review_attempt",
    httpStatus: 401,
    endpointSource: "credential",
    errorDetail: "x",
    endpointHost: "api.business.githubcopilot.com",
  };
  const stripped = withoutFileOnlyFields(event);
  assert.deepEqual(stripped, {
    type: "review_attempt",
    httpStatus: 401,
    endpointSource: "credential",
  });
  assert.equal(event.errorDetail, "x");
  assert.equal(event.endpointHost, "api.business.githubcopilot.com");
  const clean = { type: "review_complete" };
  assert.equal(withoutFileOnlyFields(clean), clean);
});
