# Changelog

## 0.20.1 - 2026-09-24

- Upgrade the development baseline for `@gotgenes/pi-permission-system` to
  `^33.1.1` (the runtime peer remains `>=30.0.0`). Version 33.1 changes how
  permission-system derives its authorizer tool surface and stop-gap
  `before_agent_start` guidance, while retaining a fail-closed runtime peer
  check and schema validation.
- Upgrade the development `@types/node` baseline to `^26.6.2`; the resolved
  version was already current under the previous range.
- Keep `typescript` at `6.0.3`, the latest 6.x release. TypeScript 7.0.2
  remains incompatible with the published-source transform used by the
  permission-system integration tests.
- Sync `examples/pi-permission-system.config.example.json` with the current
  tool split: Pencil and `mcp__pencil`, `update_plan`, and the complete goal
  lifecycle are explicitly allowed. The example passes the permission-system
  33.1.1 runtime schema.
- Type checking and the full package suite pass on the upgraded baselines
  (186 tests).

## 0.20.0 - 2026-09-23

- Require Pi `^0.87.1` for the development and peer dependency of
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (validated
  against the published 0.87.1 packages; `compat.d.ts`, the type surface this
  package builds on, is unchanged from 0.86.1).
- Validate against `@gotgenes/pi-permission-system` 33.0.8 (runtime peer stays
  `>=30.0.0`); no rule-semantics change observed.
- Upgrade the development `typescript` baseline: 7.0.2 was evaluated and kept
  on 6.0.3 because TS7 (the native Go compiler) removes the stable
  `transpileModule`/`ModuleKind` JS API used by `test/external-ts-loader.mjs`
  to transpile `pi-permission-system`'s published `.ts` sources.
- Sync `examples/pi-permission-system.config.example.json` with the live
  policy (add `goal_complete`, `obs_recall`, `pencil_read_skill`).

## 0.19.0 - 2026-09-20

- Require Pi `^0.86.0` for both the development and peer dependency of
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- Migrate the reviewer model call to Pi 0.86's normalized `TranscriptContext`:
  a registered provider `streamSimple` (models.json or extension-registered
  custom providers) now receives `normalizeContext(...)` so the reviewer system
  prompt and tool declarations arrive as the transcript's leading system
  message. Before this change such providers read the removed
  `context.systemPrompt`/`context.tools` and silently reviewed with a fallback
  system prompt and no tools.
- Read the normalized transcript in the authorizer integration tests
  (`getCurrentSystemPrompt` plus the last user message) and assert the leading
  system message, so the fake `streamSimple` observes the same shape the real
  provider adapters receive.

## 0.18.3 - 2026-09-20

- Move the `@gotgenes/pi-permission-system` development dependency to
  `^33.0.1` and refresh the type-check/test surface to Pi `^0.85.1`.
- Add an MCP rule-semantics regression test that locks the 33.x behavior this
  package depends on: a prefix-named tool such as `atlassian_getJiraIssue`
  derives its bare server (`atlassian`) as a candidate instead of an
  unmatchable double-prefixed alias, and MCP rules are evaluated
  last-match-wins across those candidates. A ruleset that puts
  `"*": "allow"` before `"atlassian": "deny"` now denies such a call, and the
  reviewer is shown the tool name as the boundary value.
- Sync `examples/pi-permission-system.config.example.json` with the live
  baseline: add the `mcp__atlassian` namespace-proxy allow and drop the
  redundant bare `atlassian` allow (after 33.0.0 its only reachable effect was
  silently allowing `mcp connect atlassian`, which starts the server). Ordinary
  `atlassian` / `jira` / `confluence` tool calls stay allowed.
- No runtime behavior change in this package: the public authorizer API it
  consumes and the normalized evidence shape are unchanged, and the peer range
  stays `>=30.0.0`. The bump only moves the development surface, so MCP rule
  semantics come from the installed permission-system (33.0.0 made
  prefix-named tools resolve to their bare server and evaluated MCP rules
  last-match-wins).

## 0.18.2 - 2026-09-17

- Treat empty or whitespace-only `.pi/pi-auto-review.json` files as missing
  configuration instead of throwing `SyntaxError`. This prevents `session_start`
  from disabling automatic reviews for an entire session when Linux bubblewrap
  creates a 0-byte mount point stub for deny-write paths (fixes #6).
- Apply the same empty-file tolerance to the user-global config loader.
- Remove redundant files from `protectedFiles` in `guards.ts` (`settings.json`,
  `permissions.json`, and unused `sandbox.json`) so workspaces can configure
  standard settings without triggering security tampering hard-denials.

## 0.18.1 - 2026-09-11

- Animate the live `reviewing` label in the above-editor widget with a
  left-to-right light sweep while the reviewer model is evaluating a boundary check.
- Paint shimmer frames at an 80ms interval cycling theme colors (`accent`,
  `muted`, `dim`) without altering the label text length or widget layout width.
- Ensure the animation timer cleanly stops and disposes when the review phase
  completes or the widget is dismissed.
- Export `USER_REVIEW_SWEEP_INTERVAL_MS` and `renderReviewingSweep` for testing
  and custom TUI rendering.

## 0.18.0 - 2026-09-11

- Coordinated release for `@erichll/pi-sandbox 0.18.0`.
- Dismiss the above-editor widget eight seconds after an allow or auto-confirm
  so a successful check does not stay on screen until the next review. Denials,
  deferrals, and local-confirmation waits still remain until the next check.
- Raise the `@gotgenes/pi-permission-system` peer floor to `>=30.0.0` and drop
  the upper bound. 29.x is no longer claimed; 32.x does not change the public
  authorizer API this package uses, and later majors are no longer excluded by
  the range.

## 0.17.0 - 2026-09-05

- Coordinated release for `@erichll/pi-sandbox 0.17.0`; the broker API and
  approval behavior are unchanged.
- Align the development pin of `@gotgenes/pi-permission-system` to the 31.1.x
  runtime line and update the authorizer-integration test to the 31.1.1
  internal source layout (the 31.1.1 refactor moved `path-normalizer.ts`).
- Split the 2,778-line `src/index.ts` into a `src/review/` module directory
  (`types`, `consts`, `config`, `audit`, `prompts`, `guards`, `input`,
  `provider`, `complete`) with an internal barrel, matching the existing
  `broker/` and `policy-audit/` conventions; the public export surface of
  `src/index.ts` is unchanged.
- Harden TypeScript checking: enable `noUncheckedIndexedAccess` and
  `noImplicitOverride` across the workspace and fix all 47 newly surfaced
  unguarded-index sites.
- Replace the full custom TypeScript test loader with native Node type
  transformation (`--experimental-transform-types`); a scoped hook now only
  handles the TypeScript sources shipped inside `node_modules`, which Node
  refuses to type-strip.

## 0.16.0 - 2026-09-05

- Coordinated release for `@erichll/pi-sandbox 0.16.0`; the broker API and
  approval behavior are unchanged.

## 0.15.3 - 2026-09-03

- Tolerate a single enclosing ```` ```json ```` or bare Markdown code fence
  around reviewer decisions while preserving strict decision-schema
  validation (fixes reviewer models that fence JSON despite the prompt,
  notably when routed through Claude Code).
- Verify compatibility with `@gotgenes/pi-permission-system` 30.2.0 and
  31.0.0, widen the peer range through 31.x, and move the development baseline
  to 31.0.0.
- Keep permission-system 31 statement-operand audit classification aligned for
  `for`/`select` word lists and `case` subjects without treating case patterns
  as accessed paths.
- Confirm that model auto-confirm stays one-shot and cannot select
  permission-system 30.2's wider both-directions session grant.

## 0.15.2 - 2026-09-02

- No behavior changes. Verified against `@gotgenes/pi-permission-system`
  29.x with a development baseline of `29.3.0`; the peer range now accepts
  29.x alongside 28.x.
