import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { parseConfig, presetConfig } from "../src/config.ts";
import { formatReset, QuotaState, readQuotaHeaders, readQuotaEvent, renderQuota } from "../src/quota.ts";
import { renderFooter, sampleSnapshot } from "../src/render.ts";
import { testTheme } from "./helpers.ts";

const now = 2000000000000;
const model = { provider: "cliproxyapi", id: "test", api: "cliproxyapi-codex-responses", baseUrl: "http://localhost:8317/backend-api/codex" };
function headers(primary = 40, secondary = 21): Record<string, string> {
  return {
    "X-Codex-Primary-Used-Percent": String(primary),
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now / 1000 + 3 * 3600 + 3 * 60),
    "x-codex-secondary-used-percent": String(secondary),
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(now / 1000 + 4 * 86400 + 9 * 3600),
  };
}
function snapshot() {
  const state = new QuotaState(); state.beginRequest(model); state.response(headers(), model);
  return state.snapshot(model, now)!;
}

test("Codex quota parser reads only allowlisted numeric fields and preserves a reported zero", () => {
  const quota = readQuotaHeaders({ ...headers(0), Authorization: "secret", "x-codex-credits-balance": "secret", "x-ratelimit-remaining-tokens": "100" });
  assert.deepEqual(quota?.primary, { usedPercent: 0, resetAtSeconds: now / 1000 + 10980 });
  assert.equal(quota?.secondary?.usedPercent, 21);
  assert.ok(!JSON.stringify(quota).includes("secret"));
  assert.equal(readQuotaHeaders({ "x-ratelimit-remaining-tokens": "100", "x-other-primary-used-percent": "50" }), undefined);
  assert.equal(readQuotaHeaders({}), undefined);
  for (const invalid of ["", " ", "0x10", "-1", "101", "NaN", "Infinity", "secret", "1e1"]) {
    assert.equal(readQuotaHeaders({ ...headers(), "X-Codex-Primary-Used-Percent": invalid })?.primary, undefined);
  }
  for (const invalid of ["", "0", "-1", "Infinity", "1e9", "secret", "999999999999999"]) {
    assert.equal(readQuotaHeaders({ ...headers(), "x-codex-primary-reset-at": invalid })?.primary, undefined);
  }
  assert.equal(readQuotaHeaders({ "x-codex-primary-used-percent": "40" }), undefined);
});

function quotaEvent(primary = 40, secondary = 21) {
  return { type: "codex.rate_limits", rate_limits: {
    primary: { used_percent: primary, window_minutes: 300, reset_at: now / 1000 + 10980 },
    secondary: { used_percent: secondary, window_minutes: 10080, reset_at: now / 1000 + 4 * 86400 + 9 * 3600 },
  } };
}

test("native Codex WebSocket events use only numeric default-bucket windows", () => {
  const event = { ...quotaEvent(0), account_id: "secret", credits: { balance: "secret" }, response: { output: "secret" } };
  const before = structuredClone(event);
  assert.deepEqual(readQuotaEvent(event), readQuotaHeaders(headers(0)));
  assert.deepEqual(event, before, "adapter-owned events must remain read-only");
  assert.ok(!JSON.stringify(readQuotaEvent(event)).includes("secret"));
  assert.deepEqual(readQuotaEvent({ ...event, metered_limit_name: "codex" }), readQuotaEvent(event));
  for (const invalid of [null, [], {}, { ...event, type: "response.completed" }, { ...event, metered_limit_name: "codex_other" }, { ...event, limit_name: "codex_bengalfox" }, { ...event, metered_limit_name: {} }, { ...event, rate_limits: [] }]) assert.equal(readQuotaEvent(invalid), undefined);
  for (const invalid of ["40", NaN, Infinity, -1, 101, null]) {
    assert.equal(readQuotaEvent({ ...event, rate_limits: { primary: { used_percent: invalid, reset_at: now / 1000 + 60 } } }), undefined);
  }
  for (const invalid of ["2000000000", 0, -1, Infinity, 9e12, undefined]) {
    assert.equal(readQuotaEvent({ ...event, rate_limits: { primary: { used_percent: 40, reset_at: invalid } } }), undefined);
  }
});

test("WebSocket quota survives subsequent ordinary frames with no HTTP hook and updates atomically", () => {
  const state = new QuotaState(); state.beginRequest(model);
  const consume = (data: unknown) => state.observeStream(model.provider, model.id, model.api, model, data);
  assert.equal(consume({ type: "response.created" }), false);
  assert.equal(consume(quotaEvent()), true);
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 40);
  assert.equal(consume({ type: "response.output_text.delta", delta: "secret" }), false);
  consume({ type: "response.completed", response: { usage: { output_tokens: 100 } } });
  assert.equal(state.snapshot(model, now)?.secondary?.usedPercent, 21);
  assert.ok(!JSON.stringify(state.snapshot(model, now)).includes("secret"));
  consume({ ...quotaEvent(), metered_limit_name: "codex_other" });
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 40, "independent metered buckets do not overwrite default quota");
  consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 0, reset_at: now / 1000 + 60 } } });
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 0);
  assert.equal(state.snapshot(model, now)?.secondary, undefined, "new snapshot must not retain another credential's window");
  consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: "bad" } } });
  assert.equal(state.snapshot(model, now), undefined);
  consume(quotaEvent());
  state.beginRequest(model); consume({ type: "response.created" });
  assert.equal(state.snapshot(model, now), undefined, "next WS request without quota must not inherit previous account's sample");
});

test("late or mismatched WebSocket events cannot populate quota after a selection change", () => {
  const state = new QuotaState();
  state.observeStream(model.provider, model.id, model.api, model, quotaEvent());
  assert.equal(state.snapshot(model, now), undefined, "a current request is required");
  state.beginRequest(model);
  state.observeStream("other", model.id, model.api, model, quotaEvent());
  assert.equal(state.snapshot(model, now), undefined);
  state.beginRequest(model);
  state.observeStream(model.provider, model.id, model.api, model, quotaEvent());
  const other = { ...model, id: "other" }; state.select(other);
  state.observeStream(model.provider, model.id, model.api, other, quotaEvent());
  assert.equal(state.snapshot(other, now), undefined);
});

test("quota snapshots replace both windows per response, instead of leaking a previous pool account", () => {
  const state = new QuotaState();
  state.response(headers(), model);
  assert.equal(state.snapshot(model, now), undefined, "unsolicited/late response without a request is ignored");
  state.beginRequest(model); state.response(headers(), model);
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 40);
  state.beginRequest(model);
  state.response({ "x-codex-primary-used-percent": "0", "x-codex-primary-reset-at": String(now / 1000 + 60) }, model);
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 0);
  assert.equal(state.snapshot(model, now)?.secondary, undefined, "must not retain another account's secondary window");
  state.beginRequest(model); state.response({}, model);
  assert.equal(state.snapshot(model, now), undefined, "missing data is not zero or an old sample");
});

test("successful streams without an HTTP hook hide old SSE quota", () => {
  const state = new QuotaState();
  state.beginRequest(model); state.response(headers(), model);
  assert.ok(state.snapshot(model, now));
  state.beginRequest(model);
  assert.equal(state.observeStream(model.provider, model.id, model.api, model), true);
  assert.equal(state.snapshot(model, now), undefined);
  state.beginRequest(model); state.response(headers(), model);
  state.observeStream(model.provider, model.id, model.api, model);
  assert.equal(state.snapshot(model, now)?.primary?.usedPercent, 40);
});

test("model/provider/API/endpoint changes, selection reset and fresh sessions invalidate quota", () => {
  for (const next of [{ ...model, id: "other" }, { ...model, provider: "other" }, { ...model, api: "other" }, { ...model, baseUrl: "http://other" }]) {
    const state = new QuotaState(); state.beginRequest(model); state.response(headers(), model);
    state.select(next);
    state.response(headers(), next); // late callback from the invalidated request
    assert.equal(state.snapshot(next, now), undefined);
    assert.equal(state.snapshot(model, now), undefined, "switching back must not resurrect old data");
  }
  const state = new QuotaState(); state.beginRequest(model); state.response(headers(), model); state.clear();
  assert.equal(state.snapshot(model, now), undefined);
  assert.equal(new QuotaState().snapshot(model, now), undefined);
});

test("countdown advances on the clock and hides expired samples without inventing zero usage", () => {
  const state = new QuotaState(); state.beginRequest(model); state.response(headers(), model);
  assert.equal(state.snapshot(model, now)?.primary?.resetInMinutes, 183);
  assert.equal(state.snapshot(model, now + 60000)?.primary?.resetInMinutes, 182);
  assert.equal(state.snapshot(model, now + 10980000)?.primary, undefined);
  assert.equal(state.snapshot(model, now + (4 * 86400 + 9 * 3600) * 1000), undefined);
  assert.equal(formatReset(183), "3h3m");
  assert.equal(formatReset(4 * 1440 + 9 * 60), "4d9h");
  assert.equal(formatReset(1), "1m");
  assert.equal(formatReset(60), "1h0m");
});

test("quota renders primary then secondary with compact reset countdowns", () => {
  assert.equal(renderQuota(snapshot(), false), "████░░░░░░ 40%[3h3m] | ██░░░░░░░░ 21%[4d9h]");
  assert.equal(renderQuota(snapshot(), true), "####------ 40%[3h3m] | ##-------- 21%[4d9h]");
  assert.equal(renderQuota(undefined, false), undefined);
  assert.equal(renderQuota({}, false), undefined);
  assert.equal(renderQuota({ secondary: snapshot().secondary }, false), "██░░░░░░░░ 21%[4d9h]");
  const value = snapshot(); value.primary!.usedPercent = 0; value.secondary!.usedPercent = 100;
  assert.match(renderQuota(value, false)!, /░{10} 0%.*█{10} 100%/);
  value.primary!.usedPercent = 0.1;
  assert.match(renderQuota(value, false)!, /█░{9} 0\.1%/);
});

test("quota is auto-inserted after context in old configs; explicit disable/order survives saving", () => {
  const config = parseConfig({ segments: [{ id: "model" }, { id: "context" }, { id: "directory" }] });
  assert.deepEqual(config.segments.slice(0, 4).map((item) => item.id), ["model", "context", "quota", "directory"]);
  assert.equal(config.segments[2]!.enabled, true);
  assert.deepEqual(parseConfig(config), config, "migration is idempotent");
  const disabled = parseConfig({ segments: [{ id: "quota", enabled: false }, { id: "context" }] });
  assert.equal(disabled.segments[0]!.enabled, false);
  assert.deepEqual(parseConfig(disabled), disabled);
  assert.equal(parseConfig({ segments: [] }).segments.find((item) => item.id === "quota")!.enabled, true);
});

test("footer places Usage directly after context, hides missing quota and preserves model/context at narrow widths", () => {
  const data = sampleSnapshot(); data.quota = snapshot(); data.context.percent = 4.6;
  const config = presetConfig();
  const line = stripTerminalSequences(renderFooter(300, data, config, testTheme())[0]!);
  assert.match(line, /󰆼 █░░░░░░░░░ 4\.6%  󰦖 ████░░░░░░ 40%\[3h3m\] \| ██░░░░░░░░ 21%\[4d9h\]  󰉋/);
  assert.doesNotMatch(line, /Usage|resets in/);
  for (const appearance of ["dark", "light"] as const) {
    for (const icons of ["unicode", "nerd", "ascii"] as const) {
      for (const width of [0, 1, 5, 20, 40, 60, 80, 100, 120, 160, 300]) {
        for (const rendered of renderFooter(width, data, { ...config, icons }, testTheme(appearance))) {
          assert.ok(visibleWidth(rendered) <= width);
          const plain = stripTerminalSequences(rendered);
          if (plain.includes("40%") || plain.includes("21%")) assert.match(plain, /40%.*21%/, "never truncate a quota window mid-string");
        }
      }
    }
  }
  const narrow = stripTerminalSequences(renderFooter(40, data, config, testTheme())[0]!);
  assert.match(narrow, /Example/); assert.match(narrow, /4\.6%/); assert.doesNotMatch(narrow, /40%|21%/);
  const medium = stripTerminalSequences(renderFooter(80, data, config, testTheme())[0]!);
  assert.match(medium, /40%.*21%/);
  config.segments.find((item) => item.id === "quota")!.enabled = false;
  assert.doesNotMatch(stripTerminalSequences(renderFooter(300, data, config, testTheme())[0]!), /40%|21%/);
  config.segments.find((item) => item.id === "quota")!.enabled = true;
  data.quota = undefined;
  assert.doesNotMatch(stripTerminalSequences(renderFooter(300, data, config, testTheme())[0]!), /40%|21%/);
});
