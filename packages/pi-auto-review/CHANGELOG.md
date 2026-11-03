# Changelog

## 0.28.1 - 2026-11-03

- Keep the Pi peer floor at `>=1.4.0` and pi-permission-system `>=42.0.0`.
  Raise the development baseline to Pi 1.5.0.
- Verify the type check and the full auto-review test suite against Pi 1.5.0,
  including the GitHub Copilot `gpt-6-luna` catalog entry.

## 0.28.0 - 2026-10-28

- Raise the development and peer baselines to Pi 1.4.0 and
  pi-permission-system 42.0.0. Older peer versions are no longer supported
  by this release.
- Verify the type check and the full auto-review test suite against the new
  permission-system baseline.

## 0.27.2 - 2026-10-20

- Apply Pi's credential `baseUrl` to reviewer requests. GitHub Copilot
  tokens are only accepted by the `proxy-ep` host in the token; calling the
  catalog's default individual endpoint returned 401 while the main session,
  which does apply that host, succeeded (#10).
- Record which endpoint each reviewer request used. `review_attempt` now
  carries `endpointSource` (`credential` or `catalog`), and the opt-in audit
  file copy adds `endpointHost` (host only, never broadcast).

## 0.27.1 - 2026-10-20

- Make reviewer failures diagnosable (#10). `review_attempt` now records the
  provider's numeric `httpStatus`, and failed `review_complete` events record
  `failureStage` (`credential_resolution` or `provider_response`) so
  "Pi could not supply credentials" is distinguishable from "the provider
  rejected the request".
- The opt-in `PI_AUTO_REVIEW_AUDIT_FILE` sink additionally records a redacted,
  500-character-capped `errorDetail` for failed attempts and for credential
  resolution failures. `errorDetail` is stripped before `pi-auto-review:audit`
  broadcast, so listeners still receive no provider error text.

## 0.27.0 - 2026-10-18

- Raise all development/peer baselines to the latest stable registry releases:
  Pi (`pi-ai` / `pi-coding-agent`) 1.3.0, permission-system 41.0.0,
  Node types 26.6.5 and TypeScript 7.0.2. Peer minimums now match the tested
  baseline rather than continuing to advertise older hosts.
- Adapt the real-chain integration harness to permission-system 41's named
  delegation-envelope signature. Runtime authorizer registration still uses
  the public service API.
- Validate and forward structured deciding-path effect/provenance and the
  nothing-on-disk license to the reviewer and review log; bind those facts into
  exact retry/grant hashes. Declared effects remain configuration claims, not
  independent safety proofs or authorization. Keep the reviewer prompt bounded.
- Preserve the local path-family allow-to-defer cap, including licensed local
  and forwarded asks in TUI/RPC modes; UI auto-confirm opt-out still applies.
  No native/headless licensed allow or commandEffects declaration is enabled.
- Join finite effect/source/license labels into policy audit's existing schema
  v3 features and optional report section without storing raw deciding paths
  or promoting machine approvals into configuration recommendation evidence.

## 0.26.1 - 2026-10-13

- Fix Pi 1.2.0 compatibility: pass an explicit `{ deliverAs: "followUp" }` to both
  `pi.sendUserMessage()` calls (`/auto-review-approve` and
  `/auto-review-break-glass`), which 1.2.0 makes required. "followUp" starts a
  new turn while idle and queues behind any run that started after the
  `isIdle()` check instead of steering into it, so an authorized retry always
  lands as a fresh turn. No `before_agent_start` changes are needed: the
  extension does not register that handler.
- Upgrade the Pi 1.2.0 development baseline (`pi-ai`, `pi-coding-agent`) and
  permission-system to `>=40.2.0`, and drop the unused
  `@earendil-works/pi-server` development dependency, which upstream removed
  in 1.2.0. Peer floors stay at `>=1.1.0`: the explicit `deliverAs` is also a
  valid optional argument on 1.1.0, so the fix is compatible with both.
- Verified against Pi 1.2.0: type check clean, all 252 tests pass.

## 0.26.0 - 2026-10-08

- Upgrade Pi development dependencies and peer floors to `^1.1.0`, require
  permission-system `>=40.0.2`, and align the Node engine with Pi
  (`>=22.19.0`). Node types (`^26.6.4`) and TypeScript (`^7.0.2`) already
  match the latest stable registry versions.
- Retry `server_busy` and server-busy provider details within the existing
  two-attempt review budget, aligning with Pi 1.1.0
  ([#10543](https://github.com/earendil-works/pi/issues/10543)).
- Recognize the exact Mistral `finish_reason: "error"` message from pi-ai
  1.0.x as a transient server failure. pi-ai 1.1.0 adds a server-error suffix
  that the existing classifier already recognizes
  ([#10487](https://github.com/earendil-works/pi/issues/10487)); keep unknown,
  authentication, and configuration failures non-retryable.
- Clear staged UI auto-confirmations and one-shot interceptors when Pi 1.1.0
  emits `agent_settled.aborted: true`
  ([#10607](https://github.com/earendil-works/pi/issues/10607)). Preserve
  existing behavior when the field is absent, false, or malformed.

## 0.25.0 - 2026-10-07

- Pass permission-system's matched bash spelling (#910) through the review and
  audit pipeline. The ask payload's `request.matchedSpelling` — the alternate
  spelling the matched rule hit when it did not match the command as typed,
  e.g. the absolute spelling of a relative path argument — is now normalized
  into the reviewer evidence and `BoundaryRequest`, described to the model
  reviewer, carried through hard-deny audits, and persisted in the policy
  audit as an anonymous `spelling_fingerprint` (schema v3; v1 and v2
  databases migrate transactionally). Because `permissions:decision` still
  carries only `matchedPattern`, the spelling is captured from
  authorizer entry (including automatic allow/deny) and
  `permissions:ui_prompt` by request id and joined at record time with a
  bounded FIFO cache; decisions that carry the field directly are used
  as-is. The report grows a "spelling fingerprints" section (v3); the
  spelling stays out of the boundary request hash, which is display-only
  input. On permission-system 39.x the field is simply absent and the audit
  behaves exactly as before. The development baseline moves to ^40.0.2,
  including the /dev/null core-reader exemption fix and bash-chain session
  grant isolation security fix; the peer floor stays `>=39.0.0`. Real
  permission-system integration tests cover alternate spellings, redirect
  exemptions, automatic spelling audits, and sibling-unit isolation.
- Isolate authorizer tests from the real user audit database: ordinary tests
  disable audit collection, while audit integration uses a temporary HOME.
  Schema v3 is a forward migration; upgrade and restart all audit collectors
  rather than leaving pre-v3 sessions writing to the upgraded database.

## 0.24.0 - 2026-10-03

- Raise the `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  peer floors to `^1.0.0` and the development baselines to `^1.0.0`, plus
  `@types/node` to `^26.6.4`. Raise the
  `@gotgenes/pi-permission-system` development baseline to `^38.0.2`; the peer
  floor stays `>=36.0.0`. Validated against Pi 1.0.0 with
  pi-permission-system 38.0.2 via `tsc --noEmit` and the full test suite: no
  source changes were required, and the authorizer seam this package consumes
  is unchanged.
- Move the example's Pi MCP tool rules under `mcp` (`mcp__atlassian__*`,
  `mcp__pencil__*`) and update the README's MCP guidance to match, because
  pi-permission-system 38.0.0 gates Pi's built-in MCP tools on the `mcp`
  surface instead of their top-level names.

## 0.23.0 - 2026-10-02

- Add opt-in `model: "current"` to review approval requests with the active Pi
  session model and provider, reflecting model changes on subsequent reviews.
- Decide, authorize, and hard-deny on the command that will actually execute,
  not only the rule-matched unit. The permission-system ask payload is now
  normalized into `executedUnit` (what a sudo/env/xargs/inline-shell wrapper
  runs), `fullCommand` (the whole program), and `matchedPattern` (the rule or a
  sentinel such as `<opaque-bash-wrapper>`), and those facts flow into the
  reviewer context and the public `BoundaryRequest`.
- Split deterministic hard denies by family. Structural rules (recursive forced
  wipes of `/`, `~`, or `$HOME`, and TLS/certificate weakening) scan a
  skeleton with quoted literals masked, plus nested shell payloads (`bash -c`,
  `eval`), including shells with options before `-c`. Literal path components
  retain placeholders so named cleanup targets cannot become root/home wipes.
  Other interpreter payloads (`python -c`, `node -e`, `perl -e`, `ruby -e`) and
  heredoc bodies stay raw because shell quoting cannot establish whether their
  strings execute. Inert mentions in shell commit messages and `echo` arguments
  remain excluded. Hard denies scan the full program, outer unit, and executed
  unit independently, preserving wrapper environment settings. Credential and
  redirect rules keep scanning raw text, including quoted credential operands.
- Bound nested interpreter expansion to 32 payloads and 32 KiB of cumulative
  payload text per command fact, shared across recursion levels. Lazy
  extraction stops repeated `eval` chains from producing megabytes of
  overlapping suffixes. On exhaustion, raw-command hard denies retain priority;
  otherwise the request defers to a human without calling the model, including
  on a trusted reviewer retry.
- Bind grants and the exact-retry match to the execution text, so two different
  heredoc bodies gated by the same wrapper unit no longer share one request
  hash. Denial labels and surface inference (`git-push`, `delete`) use the same
  text.
- Bound the reviewer view: `command`, `executedUnit`, and `fullCommand` are each
  cut to 10 KiB, and any cut sets `fullCommandTruncated`. An incomplete program
  now deterministically defers to a human before the model is called; a trusted
  exact-retry override still reaches the reviewer, and local hard denies keep
  priority. Hashing, hard denies, retry matching, and denial labels always use
  the untruncated text.

## 0.22.1 - 2026-10-01

- Fix permission-policy auditing being disabled on Bun with
  `No such built-in module: node:sqlite`. Bun, including Bun-compiled Pi, now
  uses its built-in `bun:sqlite`; Node continues to use `node:sqlite`.
- Preserve audit statistics and request deduplication when switching between
  Node and Bun by sharing the existing database schema and HMAC key.
- Finalize Bun's cached SQLite statements when closing the database so the
  last WAL connection can checkpoint and release its resources.
- Add regression coverage for database migration, redaction, retention,
  failure handling, concurrent Node/Bun writers, and persistent audit reports
  in a real Bun-compiled Pi process.
- Update the permission-system example for current MCP tool names, including
  `codemode`, `tool_search`, `mcp__atlassian__*`, and `mcp__pencil__*`.
