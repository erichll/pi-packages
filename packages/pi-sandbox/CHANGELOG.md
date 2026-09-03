# Changelog

## 0.15.3 - 2026-09-03

- Reviewer decisions on sandbox network boundaries inherit the fenced-JSON
  tolerance fix through the `@erichll/pi-auto-review` 0.15.3 dependency
  (strict decision-schema validation unchanged).
- Move the tested `pi-subagents` baseline to 0.64.0.
- Verify watchdog launch blocking occurs before worker spawn and leaves no child
  transcript in the model-backed gate.
- Exercise `watchdog_diff` against read-only Git worktree metadata through the
  real outer-sandbox launcher.

## 0.15.2 - 2026-09-02

- No user-facing changes. Compatibility-verification release only: the
  dev/test baselines move to `pi-subagents 0.63.0` and
  `@anthropic-ai/sandbox-runtime 0.0.75`, with sandbox runtime, policy,
  grants, and the public API unchanged.
