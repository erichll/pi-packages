# Changelog

## Unreleased

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
