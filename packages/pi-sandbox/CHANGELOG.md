# Changelog

## 0.19.1 - 2026-09-20

- Pin the development `pi-subagents` baseline to `^0.70.0`. The runtime peer
  stays `>=0.66.0`.
- Accept the compiled module layout introduced in 0.70.0: the npm package now
  ships `src/**/*.js` plus `.d.ts` and publishes `./capability-ceiling` as a
  `{ types, default }` condition map instead of the 0.69.0 bare
  `./src/api/capability-ceiling.ts` string. The loader derives the module
  extension and internal module paths from that export, so the source
  (0.66.0-0.69.0) and compiled (0.70.0+) layouts share one validated code path;
  unknown export targets still fail closed.
- Revalidated protected native mode against published pi-subagents 0.70.0:
  `SUBAGENT_CAPABILITY_CEILING_VERSION` 1, `registerSubagentCapabilityCeiling`,
  discovery/canonical resolution, and the config loader with `scheduledRuns`
  are unchanged. The package test suite passes (89 pass, 1 skipped) and the
  deterministic `gate:pi-subagents` preflight passes with
  `piSubagentsModuleExtension: ".js"`. The model-backed gate phase was skipped
  locally because no model credential was exported.
- Record in `docs/compat-notes.md` that 0.70.0 makes the root
  `PI_SUBAGENT_PARENT_SESSION` marker self-deleting while detached runners keep
  receiving it from their exact launch. Protected mode requires `async: true`
  children, so forwarded-permission routing is unaffected; the gate's
  parent-forwarding adapter is now a no-op shim for 0.69.0 and earlier.

## 0.19.0 - 2026-09-20

- Require Pi `^0.86.0` for both the development and peer dependency of
  `@earendil-works/pi-coding-agent`, and depend on `@erichll/pi-auto-review`
  `^0.19.0` so the pair shares the same Pi floor. The `pi-subagents` runtime
  peer stays `>=0.66.0`.
- Revalidated against Pi 0.86.0: the package test suite passes (88 pass, 1
  skipped), the deterministic `gate:pi-subagents` preflight passes, and the
  model-backed gate passes both phases (native baseline host-readable,
  protected sandboxed Bash blocked from the host read) with native
  acknowledgement `@erichll:pi-sandbox`.
- Recorded the Pi 0.86.0 floor in `README.md`, `docs/compat-notes.md`, and the
  `pi-subagents-native.ts` compatibility notes: protected mode with
  pi-subagents 0.68.0+ needs Pi 0.86.0 or newer.

## 0.18.2 - 2026-09-20

- Pin the development `pi-subagents` baseline to `^0.69.0` and Pi to
  `^0.85.1`. The runtime peer stays `>=0.66.0`.
- Revalidated protected native mode against published pi-subagents 0.69.0:
  the `./capability-ceiling` export path, `SUBAGENT_CAPABILITY_CEILING_VERSION`
  1, `registerSubagentCapabilityCeiling`, discovery/canonical resolution, and
  the config loader with `scheduledRuns` are unchanged. The deterministic gate
  and the package test suite pass against 0.67.0 and 0.69.0.
- Recorded in `docs/compat-notes.md` that protected mode with pi-subagents
  0.68.0+ needs Pi 0.85.1 or newer: 0.85.0 does not ship
  `@earendil-works/pi-server`, so background children fail to launch there.

## 0.18.1 - 2026-09-17

- Trim redundant paths from default `denyWrite` policy (`settings.json`,
  agent `settings.json`, `permissions.json`, `sandbox.json`, and legacy
  `pi-sandbox.json`), reducing unnecessary mount point stubs created by bubblewrap
  while preserving protection for `.pi/pi-auto-review.json` and agent extensions.

## 0.18.0 - 2026-09-11

- Depend on the coordinated `@erichll/pi-auto-review 0.18.0` release.
- Pin the development `pi-subagents` baseline to `^0.67.0`. The runtime peer
  remains `>=0.66.0`; protected native mode still fail-closes below 0.66.0.

## 0.17.1 - 2026-09-06

- Move the `pi-subagents` compatibility floor to 0.66.0 for protected native
  mode and drop the upper pin: new minors are accepted, and the real
  compatibility gates remain the `./capability-ceiling` export check and the
  capability-ceiling version check.
- Revalidated the adapter against the published pi-subagents 0.66.0 package:
  the ceiling registry (`SUBAGENT_CAPABILITY_CEILING_VERSION` 1),
  `registerSubagentCapabilityCeiling` options and handle, agent discovery and
  resolution, config loading with `scheduledRuns`, and the
  `runtimeAcknowledgedExtensions` acknowledgement mechanism are unchanged.
- Widen the `pi-subagents` peer and dev ranges to `>=0.66.0`. Protected mode
  now requires pi-subagents 0.66.0 or newer; 0.65.x installs fail closed with
  an explicit version error.

## 0.17.0 - 2026-09-05

- Depend on the coordinated `@erichll/pi-auto-review 0.17.0` release.
- Accept the whole pi-subagents 0.65.x line for protected native mode instead
  of pinning exactly 0.65.0: patch updates such as 0.65.1 (background session
  and worktree-patch fixes) now load normally. Any minor or major bump still
  fails closed, and the real compatibility gates remain the
  `./capability-ceiling` export check and the capability-ceiling version
  check, so the version range only guards against blind accept-on-drift.
- Widen the `pi-subagents` peer range to `>=0.65.0 <0.66.0` and the dev pin
  accordingly.

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
