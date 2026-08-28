# Changelog

## Unreleased

- Fix `/auto-review-approve` and `/auto-review-break-glass` never applying in
  real TUI sessions. The exact-match request hash included `toolCallId`, but a
  retry is always a brand-new model tool call with a fresh tool call ID, so
  the authorization could never match the retried request. The hash now
  excludes both retry-minted identifiers (`id` was already excluded).
- Fix break-glass authorization being discarded on every retry. The stored
  authorization was bound to the denial-time turn scope, but the command flow
  appends a user message (`pi.sendUserMessage`) before the agent retries, so
  the retry always lands in a later turn whose scope differs. Consumption now
  binds on session and request hash plus the confirmation TTL instead of the
  turn scope. The non-critical approve path already behaved this way.
- Reset the turn circuit breaker when a break-glass allow is consumed, so the
  human-authorized scope can continue instead of staying blocked for the rest
  of the turn. Fresh repeated denials still trip it again after three
  consecutive failures.
- Clean up break-glass authorization bookkeeping: an expired authorization
  that was never consumed no longer blocks re-approving the same action, and
  a fresh denial of an action whose approval was already consumed re-arms
  one-shot approval (one approval per denial).

## 0.14.0 - 2026-08-28

- Upgrade `/auto-review-policy-audit` from redacted statistics to an
  evidence-driven permission-configuration optimizer. Reports now separate
  suggested allow rules, keep-ask rules, and insufficient evidence, and emit a
  copyable JSON fragment targeting the selected project or global
  permission-system configuration. Suggestions remain advisory and never read
  or modify permission configuration.
- Discover candidates from actual audit data without built-in tool, executable,
  Git, RTK, package-manager, or read-only command catalogs. Valid observed
  surfaces and sanitized Bash templates—including unknown tools and write
  operations—can qualify after the configured minimum number of successful
  ask-path approvals. Denials, gate failures, unavailable confirmations,
  forwarded requests, and structurally unsafe Bash variants block a suggestion.
- Migrate the policy-audit database transactionally to schema v2. Existing
  aggregate counts and `collecting_since` are preserved, while the new
  `recommendations_since` boundary prevents pre-migration data from producing
  allow suggestions. Valid custom tool names and sanitized Bash templates are
  retained for reporting. Templates replace paths, URLs, assignments, quoted
  values, and option values with wildcards; raw commands and non-Bash tool
  arguments or inputs remain excluded.

## 0.13.0 - 2026-08-28

- Add compatibility with `@gotgenes/pi-permission-system` 27.1 directional
  `path_*` and `external_directory_*` surfaces while retaining the original
  surface in authorization evidence, UI binding, logs, and policy audits.
- Keep the permission-system peer range at `^27.0.0` so existing 27.x bare
  `path` and `external_directory` integrations remain supported.

## 0.12.0 - 2026-08-27

- Add the private policy audit
  compare current-project or anonymous global surface/command hotspots, denial
  rates, approval sources, and rule-hit fingerprints; then review repeatedly
  approved read-only operations as candidates for narrowly scoped `allow`
  rules. Mutation, project execution, network, arbitrary-shell, unknown, and
  custom-tool activity is called out as keep-`ask` evidence rather than an
  automatic relaxation. The report does not edit policy or claim that an
  unobserved rule is unused.
- Add default-on, 180-day permission-policy auditing backed by built-in
  `node:sqlite`. Permission decisions are immediately reduced to fixed command,
  risk, path-class, source, and anonymous rule-hit aggregates; raw commands,
  paths, URLs, credentials, request IDs, and project names are never stored.
- Add `/auto-review-policy-audit` as an extension-owned custom-entry report.
  It is not registered as an Agent tool or packaged skill, so audit reporting
  adds no tool schema or skill metadata to the model context. Reports default
  to the current project and can explicitly show an anonymous global aggregate.
- Require Node.js 22.13.0 or newer. No SQLite CLI, system library, npm SQLite
  package, RTK, or historical permission-log import is required.

## 0.11.1 - 2026-08-25

- Align the package version with `@erichll/pi-sandbox` `0.11.1`. No
  pi-auto-review runtime or public API changes.

## 0.11.0 - 2026-08-24

- **Structured network destination.** Network approval requests now carry
  separate host, port, and protocol fields alongside the existing combined
  destination string. One-shot grants bind each component independently, so a
  grant issued for one host-port-protocol combination cannot be reused for a
  different one.
- **Deferred reviews are more visible.** The review widget now highlights
  deferred verdicts with a warning accent instead of the previous muted style,
  making pending human decisions easier to spot.

## 0.10.0 - 2026-08-22

- Replace the review footer and newly appended transcript entries with one
  above-editor `pi-auto-review` widget. Each permission check independently
  replaces the previous display, shows the configured reviewer model while it
  runs, and updates in place with its final outcome and metadata. The latest
  result remains until the next check and is cleared on session change or
  shutdown.
- Prevent late concurrent completions and permission decisions from overwriting
  a newer check. A current local denial adds `Local confirmation · denied` to
  that result only. Widget failures fall back to notifications without changing
  authorization behavior.
- Remove tool-call grouping, timers, capacity eviction, and tool/turn flush
  wiring for new feedback while retaining the historical entry renderer. Bound
  target and rationale text with visible ellipses, preserve width-aware wrapping,
  and keep token, duration, and call-count numbers in the normal metadata color.

## 0.9.0 - 2026-08-22

- Require `@gotgenes/pi-permission-system` `^27.0.0` and register through the
  session-keyed `getPermissionsService(sessionId)` locator. Repeated ready
  broadcasts are idempotent; session changes, shutdown, and late asynchronous
  imports cannot retain or revive a stale authorizer registration. In-process
  child nodes register against their own service without replacing the
  parent's process-local broker capability.
- Group local TUI review results by `(sessionId, toolCallId)` into one
  transcript entry while preserving independent asks, model calls, verdicts,
  grants, confirmations, and audit records. Denials flush immediately; tool
  start, terminal permission denial, turn/agent/session end, a 60-second TTL,
  and bounded-capacity eviction provide lossless fallback flushes. Forwarded,
  uncorrelated, and non-TUI reviews remain immediate.
- Add `toolCallId` to each `pi_auto_review_decision` audit entry and retain
  compatibility rendering for historical single-result transcript entries.
- Remove the review entry's left quote bar and combine each target with its
  rationale and member surface/outcome on one line, keeping model/token/duration
  metadata separate.
- Label every displayed model token count with `toks` in both grouped and
  single-result output.

## 0.8.2 - 2026-08-21

- Structure interactive review results as headline, target, rationale, and a
  meta line with the reviewer model name, input/output tokens, duration, and extra
  calls. The TUI renders them as markdown-style quote rows (`│` + `mdQuote`),
  with allow/deny verbs and token counts tinted from the theme. The model id is
  shown without a provider prefix; audit still records the full `provider/id`.
  Local hard denies omit model and token fields because no model ran.

## 0.8.1 - 2026-08-21

- Restore TUI auto-confirm for capped `path` / `external_directory` allows on
  permission-system 26.x. `permissions:ui_prompt` no longer carries `message`;
  the bridge now binds `requestId` plus `request.value` (falling back to the
  display `value`, then the legacy `message`) and fingerprints the live dialog
  with those fields. Top-level display `surface` is not treated as the gate.

## 0.8.0 - 2026-08-21

- Add `/auto-review-approve` for exact non-critical denial retries and remove
  the unprefixed `/approve` command without a compatibility alias.
- Add interactive `/auto-review-break-glass` for a recent critical model deny.
  The high-friction confirmation is bound to the full request hash, session,
  scope, and original request ID, expires after 60 seconds, permits one direct
  retry, and never bypasses deterministic or protected-write hard denies.
- Add tighten-only `breakGlassEnabled` (default `true`), structured break-glass
  allow provenance, and challenge/authorization/consumption/rejection audit
  events. Challenge phrases are never included in audit events.

## 0.7.0 - 2026-08-20

- **Named `/home` paths are not a home wipe.** The reviewer prompt now matches
  the deterministic hard-deny: recursive forced wipe of `/`, `~`, `$HOME`, or
  the home directory itself remains forbidden. A narrow, user-requested delete
  of named files or directories under `/home/...` is high-risk, not critical.
  High risk without medium/high user authorization defers to the human instead
  of denying as if it were a hard deny. The fixed prompt is compacted without
  changing those rules.
- **Clearer agent-facing denials.** Authorizer denies still fail closed, but the
  teaching reason now states that automatic policy denied the request (not a
  human click), forbids rephrasing or circumvention, and points to the exact
  retry command
  for one exact retry when the user already requested that action. The
  permission-system wrapper may still say `User denied`; the reason suffix is
  the correction this package can own.

## 0.6.0 - 2026-08-20

- **Remove host user-constraint overlay.** Stop rewriting model allows from
  regex matches on user text (`constraintEffect` / `vagueContinuation` /
  authorization ceilings). Older messages enter evidence only via an exact
  request reference or trusted exact retry. Compaction summaries remain
  excluded from user intent. Hard denies, grant hashing, and the reviewer
  model are unchanged.

## 0.5.0 - 2026-08-20

- **Safer evidence selection.** Review only request-linked tool calls, paired
  results, current-task user intent, and bounded security evidence. Compaction
  summaries cannot restore authorization, raw revocations override model
  allows, and missing mandatory evidence fails closed before a model call.
- **Independent, smaller reviewer requests.** Use one compact canonical request
  envelope and a byte-stable policy prefix, reducing fixed input from 2,011 to
  1,396 characters. Independent SSE calls prevent prior review state from
  carrying into later approvals while preserving cache/routing identity.
- **Explicit token limits.** Add tighten-only `maxReviewerInputTokens` with an
  8,192 default and conservative UTF-8 accounting across the complete prompt.
  Lower the default `maxTokens` from 1,600 to 256 after sequential real-model
  validation at 384 and 256; the legal range remains 256–4,096.
- **Typed, bounded retries.** Share one deadline across each review, disable
  provider-internal retries, and allow at most two actual model calls. Only
  format errors, recognized connection/5xx failures, and bounded 429 responses
  retry; deterministic and unknown failures remain terminal and fail closed.
- **Privacy-bounded telemetry.** Record per-attempt usage and per-review
  summaries for both reviewer entry points using stable status/error codes and
  prompt-part counts, without logging evidence text, provider errors,
  credentials, headers, or URL query values.

## 0.4.0 - 2026-08-19

- **Credential-exfiltration hardening.** Expand deterministic terminal denies to cover
  `.env` variants, common credential files, additional file readers and encoders,
  shell substitutions, staged variables, redirects, and multi-stage pipelines that
  upload credentials to network sinks. Template files such as `.env.example` and
  `.env.sample` remain reviewable.
- **Reviewer refresh safety.** Re-resolve reviewer model/provider metadata for each
  review, reacquire authentication for each attempt, and bind the reviewer session
  identity to the endpoint and authentication fingerprint so provider or OAuth
  refreshes cannot reuse a stale connection.
- **Compatibility.** Require Pi 0.84.1+ and permission-system 25.1.0+ to match the
  current reviewer and forwarded-permission contracts.

## 0.3.5 - 2026-08-13

- Raise the default model-review `timeoutMs` from 45s to 90s and the default
  `retries` from 1 to 2. Approval now tolerates real-world model latency better
  while keeping the same bounded transcript surface.

## 0.3.4 - 2026-08-08

- Normalize direct and permission-system v24 forwarded evidence before policy
  checks, model review, grant hashing, and audit logging. Forwarded Bash
  commands, canonical path boundaries, agent names, and requester session IDs
  now remain bound to the exact reviewed request.
- Add an opt-in `PI_AUTO_REVIEW_AUDIT_FILE` JSONL sink for isolated release
  verification without changing the normal event-based audit surface.

## 0.3.3 - 2026-08-06

- Fix config validation rejecting multi-segment model ids (`provider/group/model`).
  `validateConfig` no longer restricts a model to exactly one `/`; it only rejects
  ids with empty segments. Segments are resolved as before: the first segment is
  the provider and the rest is the model id.

## 0.3.2 - 2026-07-29

- Load an optional user-global trusted config from
  `~/.pi/agent/extensions/pi-auto-review/config.json` as a full overlay on the
  package defaults (model, `autoConfirmBoundedAllows`, and other legal keys).
- Keep project `.pi/pi-auto-review.json` tighten-only on top of that trusted
  layer.
- Deterministically deny writes to the user-global reviewer config directory.
- Default reviewer model is the bare id `codex-auto-review`; `provider/model`
  remains supported. Bare ids resolve against registered available models.
- Show user-facing review feedback in interactive UI: a footer status while the
  model is reviewing, then a short toast for allow / deny / defer / auto-confirm
  / circuit-breaker outcomes (separate from agent denial reasons).

## 0.3.1 - 2026-07-29

- Bind one-shot approval grants to matched policy evidence as well as the
  command, working directory, destination, paths, and other request fields.
- Prevent a grant issued for one Host-IPC trigger from authorizing a request
  with different trigger evidence.

## 0.3.0 - 2026-07-28

- Initial public release.
