# Changelog

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
