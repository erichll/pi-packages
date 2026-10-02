import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/review/config.ts";
import { resolveReviewerMeta } from "../src/review/provider.ts";
import type { ReviewerMeta } from "../src/review/types.ts";

function model(provider: string, id: string): ReviewerMeta["model"] {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: `https://${provider}.example/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function harness() {
  const dedicated = model("reviewer", "review-model");
  let active: ReviewerMeta["model"] | undefined = model("session", "group/chat-model");
  const providerLookups: string[] = [];
  const streamSimple = (() => { throw new Error("resolution must not call the provider"); }) as
    NonNullable<ReviewerMeta["streamSimple"]>;
  let registeredApi = "openai-completions";
  const ctx = {
    get model() { return active; },
    modelRegistry: {
      getAvailable: () => [dedicated],
      find: (provider: string, id: string) =>
        provider === dedicated.provider && id === dedicated.id ? dedicated : undefined,
      getRegisteredProviderConfig(provider: string) {
        providerLookups.push(provider);
        return { api: registeredApi, streamSimple };
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx, dedicated, streamSimple, providerLookups,
    setModel(value: typeof active) { active = value; },
    setRegisteredApi(value: string) { registeredApi = value; },
  };
}

test("explicit reviewer references keep registry resolution and custom-ID fallback", async () => {
  const instance = harness();
  for (const ref of ["review-model", "reviewer/review-model"]) {
    const resolved = await resolveReviewerMeta(instance.ctx, { ...DEFAULT_CONFIG, model: ref });
    assert.equal(resolved.model, instance.dedicated);
  }
  const custom = await resolveReviewerMeta(instance.ctx, {
    ...DEFAULT_CONFIG, model: "reviewer/custom-model",
  });
  assert.deepEqual(custom.model, { ...instance.dedicated, id: "custom-model", name: "custom-model" });
  instance.setModel(undefined);
  const explicit = await resolveReviewerMeta(instance.ctx, {
    ...DEFAULT_CONFIG, model: "reviewer/review-model",
  });
  assert.equal(explicit.model, instance.dedicated);
  await assert.rejects(resolveReviewerMeta(instance.ctx, {
    ...DEFAULT_CONFIG, model: "missing/review-model",
  }), /provider missing is unavailable/);
});

test("current mode inherits the exact live model and its provider stream", async () => {
  const instance = harness();
  const config = { ...DEFAULT_CONFIG, model: "current" };
  const first = await resolveReviewerMeta(instance.ctx, config);
  assert.equal(first.model, instance.ctx.model);
  assert.equal(first.model.id, "group/chat-model");
  assert.equal(first.model.provider, "session");
  assert.equal(first.streamSimple, instance.streamSimple);

  const next = model("another-provider", "another-model");
  instance.setModel(next);
  const second = await resolveReviewerMeta(instance.ctx, config);
  assert.equal(second.model, next);
  assert.deepEqual(instance.providerLookups, ["session", "another-provider"]);
  instance.setRegisteredApi("anthropic-messages");
  assert.equal((await resolveReviewerMeta(instance.ctx, config)).streamSimple, undefined);
});

test("current mode has no fallback when the session has no model", async () => {
  const instance = harness();
  instance.setModel(undefined);
  await assert.rejects(resolveReviewerMeta(instance.ctx, {
    ...DEFAULT_CONFIG, model: "current",
  }), /current Pi session model is unavailable/);
  assert.deepEqual(instance.providerLookups, []);
});

test("provider/current still refers to an explicit model ID", async () => {
  const instance = harness();
  const resolved = await resolveReviewerMeta(instance.ctx, {
    ...DEFAULT_CONFIG, model: "reviewer/current",
  });
  assert.equal(resolved.model.provider, "reviewer");
  assert.equal(resolved.model.id, "current");
});
