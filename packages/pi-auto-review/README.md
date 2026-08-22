# @erichll/pi-auto-review

A fail-closed, model-backed boundary reviewer for the Pi coding agent.

The extension participates in `@gotgenes/pi-permission-system` as the
`pi-auto-review` authorizer and exposes a process-local broker for OS sandbox
adapters. It is an authorizer *inside* the permission system, so installing
that dependency is a hard prerequisite (see [Install and enable](#install-and-enable)). The npm package and reviewer model have separate names:

- package: `@erichll/pi-auto-review`
- authorizer: `pi-auto-review`
- default reviewer model: `codex-auto-review`

## Install and enable

> **Prerequisite:** pi-auto-review is an authorizer inside
> `@gotgenes/pi-permission-system`. Pi does not auto-install peer packages, so
> install the permission system separately (once per machine) before this
> extension. Version 0.10.0 requires permission-system 27.x:

```bash
pi install npm:@gotgenes/pi-permission-system
pi install npm:@erichll/pi-auto-review
```

Install the package outside the agent-writable workspace:

Add it to the permission-system authorizer chain:

```json
{
  "authorizerChain": ["pi-auto-review"]
}
```

The configured reviewer provider and model must also be registered in Pi.

## Security model

Requests pass through these controls in order:

1. deterministic hard denies;
2. bounded model review;
3. the local permission terminal when required; and
4. an exact, expiring, one-use grant for an external sandbox adapter.

The model cannot override hard denies or grant authority directly. External
adapters must consume the exact grant before retrying an operation. Changing
the command, path, resolved path, destination, cwd, agent, or tool input
invalidates that grant.

Permission-system downgrades authorizer allows on `path` and
`external_directory` to `defer`. In an interactive TUI,
`autoConfirmBoundedAllows` can bind the exact model allow to the immediately
following recognized permission dialog. The bridge is request-ID-bound,
expires after ten seconds, and is consumed once. Mode, component, request, or
event-order mismatches leave the original human dialog in place.

Automatic review stops for the current turn after three consecutive denials or
ten denials in the last fifty reviews. An explicit denial tells the agent that
automatic policy denied the request (not a human click), not to rephrase or
circumvent the same action, and points to `/auto-review-approve` for an exact
non-critical reviewer retry or `/auto-review-break-glass` for a critical model
denial. Local deterministic hard denies never offer an override command.

Deterministic hard denies cover recursive forced wipes of `/`, `~`, and
`$HOME`. A named path under `/home/...` is reviewed by the model as high-risk,
not treated as a home-directory wipe.

## Configuration

Configuration is resolved in this order:

1. package defaults in `src/config.json`;
2. optional trusted user overlay at
   `~/.pi/agent/extensions/pi-auto-review/config.json`; and
3. optional project tighten-only settings at `.pi/pi-auto-review.json`.

Use the user-global file for normal customization. It may set any legal key:

```json
{
  "model": "provider/reviewer-model",
  "autoConfirmBoundedAllows": ["external_directory", "path"]
}
```

Package defaults:

```json
{
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 90000,
  "maxTokens": 256,
  "retries": 2,
  "maxUserTranscriptTokens": 1200,
  "maxToolTranscriptTokens": 1200,
  "maxRelevantResultTokens": 800,
  "maxReviewerInputTokens": 8192,
  "breakGlassEnabled": true,
  "failureMode": "deny",
  "grantTtlMs": 60000,
  "autoConfirmBoundedAllows": ["external_directory", "path"]
}
```

`failureMode: "deny"` is the default. `"defer"` falls through to the human
terminal. Set `autoConfirmBoundedAllows` to `[]` to keep every bounded allow
manual.

Project configuration may only lower timeouts, token/evidence limits, retries,
and grant TTL, set `failureMode` to `"deny"`, set `breakGlassEnabled` to
`false`, or remove auto-confirmed surfaces. It cannot re-enable break glass,
select a model, raise a trusted limit, or weaken fail-closed behavior. Invalid
configuration disables the reviewer for that session.

### Deadlines and retries

`timeoutMs` is one deadline shared by model resolution, authentication, model
attempts, and retry delays. Each attempt receives only the remaining time.
Provider-internal retries are disabled, and a review makes at most two actual
model calls even when the public `retries` value is higher.

Valid decisions, output-length stops, timeouts, aborts, authentication/model/
request errors, and unknown failures do not retry. Empty, non-JSON, or
schema-invalid output and recognized connection, temporary 5xx, or 429
failures may retry once when the retry budget and deadline allow it. A
`Retry-After` above five seconds or beyond the remaining deadline fails closed.
Format retries preserve the canonical request and selected evidence and append
only a fixed, budget-checked schema correction.

## Operator feedback and exact retry

Interactive sessions show the current permission check in a single widget
above the editor. Each check first shows its surface, compact target, and the
dynamically configured reviewer model, then replaces that content in place
with the outcome, target and rationale, model, token usage, duration, and any
extra call count. A new check replaces the previous result; the latest result
remains visible until then and is cleared when the session changes or shuts
down. Concurrent older checks cannot overwrite the most recently started one.

Every request still has its own model call, verdict, grant, local confirmation,
and audit record. No new review-result transcript entries are written. Existing
`pi-auto-review` entries in historical sessions remain renderable. Non-TUI
modes retain best-effort notifications, and a failed TUI widget update falls
back to the same notification path. UI delivery never changes the authorization
result.

In an interactive TUI, `/auto-review-approve` lists up to ten recent
non-critical model denials from the current session. Selecting one asks the
agent to retry exactly that request. The old `/approve` command is not
registered.
The host-generated override:

- binds the complete request hash;
- expires after 60 seconds and is consumed once;
- remains separate from untrusted user/tool evidence;
- still goes through deterministic hard denies and model review; and
- cannot be reissued for the same request semantics in that session.

It is authorization evidence, not a direct allow.

`/auto-review-break-glass` is a separate, high-friction path for model denials
whose risk level is `critical`. It lists only critical model denials from the
same session made in the last five minutes. After showing the rationale,
surface, cwd, command or target summary, and request-hash fingerprint, it
requires an explicit confirmation and a random `BREAK-GLASS <CODE>` phrase
within 60 seconds. Successful confirmation creates a 60-second, one-use
authorization bound to the complete request hash, session, scope, and original
request ID. The exact retry reruns local hard-deny checks, then allows directly
without calling the reviewer and, for sandbox adapters, still issues the normal
one-shot grant. Break glass does not reset circuit-breaker history and can be
disabled in trusted or project configuration with `breakGlassEnabled: false`.

## Boundary broker API

The extension publishes a process-local service at:

```ts
Symbol.for("pi-auto-review:boundary-approval-broker")
```

Adapters should use the exported helper:

```ts
import {
  getBoundaryBroker,
  type BoundaryRequest,
} from "@erichll/pi-auto-review";

const request: BoundaryRequest = {
  id: "sandbox-runtime-query-id",
  source: "sandbox-runtime",
  surface: "network",
  operation: "connect",
  cwd: "/workspace/project",
  command: "npm install",
  destination: "registry.npmjs.org:443",
};

const broker = getBoundaryBroker();
const decision = await broker?.review(request, {
  sessionId: "pi-session-id",
  scopeKey: "pi-session-id:turn-id",
  issueGrant: true,
});

// A break-glass allow includes structured provenance:
// decision.authorization = {
//   kind: "break-glass",
//   originalRequestId: "...",
//   confirmedAt: 0,
// };

if (
  decision?.kind === "allow" &&
  decision.grant &&
  broker?.consumeGrant(request, "pi-session-id", decision.grant.token)
) {
  // Retry this exact operation once inside the OS sandbox.
}
```

Grants expire after `grantTtlMs` and cannot be reused.

## Reviewer context and token budgets

The reviewer receives one compact canonical request plus bounded, explicitly
untrusted evidence. Selection is deterministic rather than semantic:

- the latest raw user message is the authorization anchor;
- older user messages require an exact request/tool/requester association or an
  exact trusted retry;
- tool calls require an exact tool-call ID, exact structured request fields, a
  surface profile, or a security-combination classification; and
- selected results stay paired with their producer and are limited to exact
  results, deletion prechecks, Git push context, matching branch protection,
  and Sandbox Runtime process evidence.

Unrelated reads, directory listings, builds, tests, assistant prose, and old
task history are excluded. Compaction and branch summaries are labeled as
non-authorization context and are never injected as user intent. The host does
not rewrite a model allow from regex matches on user text, vague continuations,
or a computed authorization ceiling; those judgments stay with the reviewer
model. Hard denies still terminate before the model.

The current operation appears once as stable, key-sorted JSON. Duplicate exact
tool-call arguments collapse to an ID/name/reason linkage shell, while fields
not represented by the request remain available as evidence. This compact
reviewer representation does not affect request hashes, grants, overrides, or
audit evidence.

`maxReviewerInputTokens` covers the fixed policy, canonical request, override,
evidence, omissions, JSON framing, and a 64-token provider-framing reserve. Its
legal range is 2,048–32,768. Because no matching tokenizer is bundled, the
`conservative:utf8` estimator counts every UTF-8 byte as one token.

When over budget, the host removes secondary reasons, older structured tool
matches, then optional producer/result units, re-estimating after each step. It
never silently removes the canonical request, exact override, latest user
evidence, security-combination evidence, exact tool linkage, or a required
surface profile. If mandatory evidence does not fit, review fails closed before
calling the model. More than four security-combination candidates also fails
closed locally.

## Sandbox integration

This package exposes the broker contract but does not intercept OS sandbox
events itself. Adapters translate a concrete boundary into a `BoundaryRequest`
and consume the exact grant before allowing it.

This monorepo's `pi-sandbox` adapter uses Anthropic Sandbox Runtime. Filesystem
policy is static and fail-closed; unmatched public network destinations use the
broker for one connection. Each Bash command or built-in subagent session owns
an independent Sandbox Runtime broker process. Adapter implementations should
use the package's `./sandbox` export and must not create broad permanent rules
in `.pi/sandbox.json`.

## Trust boundary

Production copies must live outside the agent-writable workspace. Pi installs
user npm and Git packages under `~/.pi/agent/npm/` and `~/.pi/agent/git/`.
Workspace-loaded copies are rejected unless local development explicitly opts
in:

```bash
PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1 pi --approve
```

Writes to the installed reviewer package, its user-global configuration,
project and global security configuration, and the global audit directory are
deterministically denied.

## Telemetry and smoke testing

Every actual model call emits an internal `review_attempt`; each approval emits
one `review_complete`. Events contain stable status/error classes, timings,
usage counters, evidence metadata, and prompt-part counts. They do not contain
prompt or response text, provider errors, credentials, headers, or URL query
values. Usage is marked `unknown_provenance` when pi-ai cannot distinguish
provider counters from initialized values, and `unavailable` when absent.

For a controlled real-model smoke test, load only the provider, reviewer,
sandbox, and audit listener:

```bash
PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1 \
PI_AUTO_REVIEW_SMOKE_AUDIT_PATH=/tmp/pi-auto-review-smoke-audit.jsonl \
PI_AUTO_REVIEW_BASELINE_ID=reviewer-check \
PI_AUTO_REVIEW_BASELINE_CACHE_STATE=cold \
PI_AUTO_REVIEW_BASELINE_RUN_ORDER=1 \
PI_AUTO_REVIEW_BASELINE_SAMPLE_SET=reviewer-v1 \
PI_AUTO_REVIEW_SMOKE_TRIGGER=baseline-v1 \
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  --no-builtin-tools --no-session --print \
  --extension /trusted/path/to/provider/extensions/index.ts \
  --extension ./packages/pi-auto-review/src/index.ts \
  --extension ./packages/pi-sandbox/src/index.ts \
  --extension ./scripts/real-model-smoke-audit.ts \
  --model provider/reviewer-model \
  "Run the configured synthetic reviewer baseline sample, then reply done."
```

The listener submits filesystem-write, network, delete, Git-push, and forwarded
subagent boundaries. No represented operation is executed; the main-agent
request is aborted after the samples finish. `--no-builtin-tools` ensures Bash
comes from `pi-sandbox` rather than Pi's built-in implementation.
