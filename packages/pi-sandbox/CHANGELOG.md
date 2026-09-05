# Changelog

## 0.16.0 - 2026-09-05

- Depend on the coordinated `@erichll/pi-auto-review 0.16.0` release.
- Replace the obsolete `externalWorkerIsolation` integration with the required
  `native-background-tools` protection mode for `pi-subagents 0.65.0`.
- Require a validated canonical native-agent whitelist, explicit asynchronous
  launches, ambient child extensions, disabled nested delegation, and
  `scheduledRuns.enabled=false`.
- Register the upstream capability ceiling with only `bash`, `read`, `grep`,
  `find`, and `ls`; child writes therefore pass through sandboxed Bash while
  `write`, `edit`, MCP, and extension tools are unavailable.
- Reject external runners, all workflow forms, schedules, resume, and agent or
  workflow management mutations. Protected mode supports only explicit async
  direct-agent launches because 0.65.0 workflow children disable ambient
  extensions.
- Remove the obsolete external launcher, supervisor, network-policy transport,
  and FleetView bridge. This mode is a tool boundary, not OS process isolation;
  use the default `builtin` provider when whole-worker isolation is required.

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
