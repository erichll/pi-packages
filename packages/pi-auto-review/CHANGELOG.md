# Changelog

## Unreleased

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
