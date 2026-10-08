# Changelog

## 0.26.0 - 2026-10-08

- Require `@erichll/pi-auto-review ^0.26.0` so sandbox approvals use the
  coordinated Pi 1.1.0 reviewer and cancellation fixes.
- Upgrade Pi development dependencies and the coding-agent peer floor to
  `^1.1.0`; move pi-subagents to development `^0.76.1` / peer `>=0.76.1` and
  typebox to development `^1.3.36` / peer `>=1.3.36`. Keep pi-subagents optional
  and leave the sandbox-runtime and jiti dependency declarations unchanged.
- Revalidate the deterministic 0.76.1 compatibility gate and isolated Node,
  Bun, and compiled-Bun host-peer loading on Pi 1.1.0. Fix the copied-package
  test for dependencies that do not export package.json, including the new
  Temporal polyfill. Revalidate model-backed acceptance with the native host
  read baseline and the protected child blocking that read, including the
  required sandbox runtime acknowledgement.
- Reject settlement waiters for RPC runs cancelled with Pi 1.1.0
  `agent_settled.aborted: true`
  ([#10607](https://github.com/earendil-works/pi/issues/10607)), including
  waiters registered after the event or after subsequent successful runs.
  Keep the persistent child idle and available for follow-up instead of
  reporting a successful result or terminating the session. Legacy events
  without the field retain their existing behavior.
- Ignore buffered lifecycle events after an RPC session stops or fails so
  cancellation and shutdown cannot resurrect a terminal session.

## 0.25.0 - 2026-10-07

- Align the `@erichll/pi-auto-review` dependency with `^0.25.0` so the
  workspace and sandbox use the same broker implementation and include the
  permission-system 40.0.2 integration baseline.
- Revalidate the deterministic and model-backed pi-subagents 0.75.0 gate:
  the native baseline reads the host probe, while the protected native
  background child blocks that read and acknowledges the sandbox extension.

## 0.24.0 - 2026-10-03

- Raise the `@earendil-works/pi-coding-agent` peer floor to `^1.0.0` and the
  development baselines for `pi-ai`, `pi-coding-agent`, and `pi-server` to
  `^1.0.0`, plus `@types/node` to `^26.6.4`. Validated against Pi 1.0.0 via
  `tsc --noEmit` and the full test suite: no behavior changes were required.
- Raise the `pi-subagents` development pin to `^0.75.0` and revalidate the
  protected loader against it. 0.75.0 is the first release that starts
  background children on Pi 1.0.0 again (through 0.74.0 they failed with "does
  not provide @earendil-works/pi-agent-core/node", which pi-agent-core 1.0.0
  dropped). The deterministic preflight passes on 0.75.0 — package exports,
  discovery, and the capability-ceiling seams are unchanged from 0.72.1, and
  the loader comment records the audit. The credential-backed model phases also
  pass on 0.75.0 — native baseline (`native-host-readable`) and the protected
  native-background whitelist (`sandboxed-bash-blocked-host-read`) — so the
  release gate is closed for this pin.
- Raise the `@anthropic-ai/sandbox-runtime` dependency to `^0.0.78` and the
  `@erichll/pi-auto-review` dependency to `^0.24.0`.
- Update the compatibility notes for pi-subagents 0.73.0, which replaced
  `workflowScript`/`workflowScriptPath` with a single `workflow` field: the
  loader already rejects every call that sets it (inline, path, or named), so
  protected mode still permits direct agent launches only.

## 0.23.0 - 2026-10-02

- Add opt-in `network.strictAllowlist` (default `false`) to deny unmatched
  destinations without model or human approval. Forward the setting to Sandbox
  Runtime for Bash and built-in workers, including persistent follow-up and
  nested handoff.
- Merge global/project strict mode with logical OR while retaining domain-list
  unions. Both files remain trusted policy sources: projects can add endpoints
  but cannot disable globally required strict enforcement.
- Reject strict mode combined with Host-IPC `ask` after configuration merging
  and embedding overrides. Keep non-strict approval and host forwarding behavior.
- Require `@erichll/pi-auto-review` `^0.23.0` for current-session review models
  and full-command execution-context validation.
- Cover real Linux broker network enforcement, persistent worker lifecycle and
  startup failures with synthetic endpoints; isolate configuration tests from
  the developer's working directory.

## 0.22.1 - 2026-10-01

- Fix sandboxed Bash on Bun-compiled Pi: launching the Sandbox Runtime broker
  could instead start another unsandboxed Pi session with the broker path as
  its prompt, leaving the requested command unexecuted
  ([#7](https://github.com/erichll/pi-packages/issues/7)). The broker now runs
  through a separate Node executable and communicates over JSON IPC.
- **Bun-compiled Pi requires Node.js >=22.19.0 on PATH**, with its directory
  listed as an absolute path. If Node cannot be found, commands fail explicitly
  before execution. Aliases back to the Pi executable are rejected.
- Fix built-in subagent startup for standalone Pi and resolve the host CLI
  symlink for Node-based Pi. Derive filesystem permissions from the actual
  runtime so a binary such as `/tmp/pi-bun` does not grant root reads or deny
  writes to the entire host temp directory.
- Fix protected `pi-subagents` loading on Bun when `pi-tui` and `typebox` are
  provided by Pi. Reuse the host modules in the internal loader so compiled
  Pi does not need separate copies beside the extension.
- Clean up command temp directories when broker startup fails. Add isolated
  Node, plain Bun, and compiled Bun regression tests for broker startup,
  capability-ceiling registration, and rejection of enabled schedules.
- Require `@erichll/pi-auto-review` `^0.22.1` to include the Bun SQLite audit fix.

## 0.22.0 - 2026-09-30

- Raise the `@earendil-works/pi-coding-agent` peer floor to `^0.99.1` and the
  development baseline to `^0.99.1`. Validated against Pi 0.99.1 with
  `tsc --noEmit` and the test suite (92 pass, 1 macOS-only skip); the shipped
  `src/` uses no API that changed between 0.87 and 0.99.
- Adapt two test fixtures to the 0.99 extension surface: `ToolInfo` now requires
  `exposure`, and tool handlers receive `ExtensionToolContext` (`tools`,
  `executeTool`). The shipped extension uses neither field, so runtime behavior
  is unchanged.
- Raise the `pi-subagents` development dependency to `^0.72.1` and revalidate
  the native-background loader against the published 0.72.1 package:
  `discoverAgents` and `resolveAgentName` keep their signatures,
  `src/agents/agents` only gains an optional `options.globalNpmRoot` argument,
  `typebox` moved from a hard dependency to an optional host peer, and the
  `./capability-ceiling` export still resolves to `.js`.
- Depend on `@erichll/pi-auto-review` `^0.22.0`.
- Document the three-way `subagents.provider` choice (`builtin` / `off` /
  `pi-subagents`) with copy-ready example configs, including the duplicate
  `subagent` tool that makes `builtin` unavailable whenever the pi-subagents
  extension is loaded, and the scheduled-runs-disabled pi-subagents config that
  protected mode requires.
- Bump the development `typescript` baseline to `^7.0.2`.

## 0.21.1 - 2026-09-26

- Alias `@earendil-works/pi-tui` for the `jiti` instance that loads the
  `pi-subagents` internals. `pi-subagents` imports that host peer from its
  internal modules but does not ship it, and Pi's own extension loader aliases
  it to the copy inside the running Pi package. The protected-mode loader
  created its own `jiti` instance without that alias, so installs where the peer
  is not hoisted next to the extension (for example the global
  `~/.pi/agent/npm` tree) failed to load as soon as `subagents.provider` was
  `pi-subagents` with `pi-subagents compatibility failure: Cannot find module
  '@earendil-works/pi-tui'`. The alias is computed host-first from the running Pi
  package (`process.argv[1]`, `PI_PACKAGE_DIR`) and falls back to plain
  resolution from the extension tree; an unresolvable host peer still fails
  closed with that explicit error.
- Add regression coverage for host alias resolution, including a `jiti` load in
  a tree where `@earendil-works/pi-tui` is unreachable without the alias.

## 0.21.0 - 2026-09-25

- Support project-level configuration at `.pi/extensions/pi-sandbox/config.json`.
  When present, project configuration is merged with global configuration:
  array permissions (`additionalAllowRead`, `allowedDomains`, `deniedDomains`,
  `preflightCommandPrefixes`) form deduplicated unions, and scalar settings
  (`subagents.provider`, `hostIPC.mode`, `hostIPC.retryOnUnixSocketError`)
  allow project-level overrides.
- Harden project-level configuration: added `.pi/extensions/pi-sandbox/config.json`
  to default sandbox `filesystem.denyWrite` policy. Project configuration is
  strictly read-only for sandboxed execution processes.
- Remove legacy configuration compatibility: removed fallback loading for
  `~/.pi/agent/pi-sandbox.json` and dropped deprecated `externalWorkerIsolation`
  migration parsing.
- Pair with `@erichll/pi-auto-review` `^0.21.0`.

## 0.20.1 - 2026-09-24

- Move `@anthropic-ai/sandbox-runtime` from `devDependencies` to runtime
  `dependencies`. The extension imports the package while loading, so published
  installs failed with `Cannot find module '@anthropic-ai/sandbox-runtime'`.
- Pair this release with `@erichll/pi-auto-review` `^0.20.1`, whose development
  baseline is upgraded to `@gotgenes/pi-permission-system` 33.1.1.
- Upgrade the development `@types/node` baseline to `^26.6.2`; the resolved
  version was already current under the previous range. `typescript` remains
  6.0.3 because the 7.0.2 native compiler is incompatible with the
  permission-system integration test transform.
- Type checking and the full suite pass (89 pass, 1 environment-dependent
  skip). The deterministic `gate:pi-subagents` preflight passes against
  `pi-subagents` 0.71.0; the model-backed phase was not run because no matching
  model credential was available in the current environment.

## 0.20.0 - 2026-09-23

- Require Pi `^0.87.1` (development and peer) for `@earendil-works/
  pi-coding-agent`, and upgrade the development `@earendil-works/pi-ai` and
  `@earendil-works/pi-server` baselines to 0.87.1 (validated against the
  published packages; type surface unchanged from 0.86.x).
- Pin the development `pi-subagents` baseline to `^0.71.0`; the runtime peer
  stays `>=0.66.0`. Revalidated protected native mode against published
  0.71.0: the ceiling implementation (`SUBAGENT_CAPABILITY_CEILING_VERSION` 1)
  and the config loader are byte-identical to 0.70.0, and `discoverAgents` /
  `resolveAgentName` keep their signatures (the new `applyRuntimeAgentSettings`
  and `completionGuard` removal do not touch validated agent fields). The
  package test suite passes (89 pass, 1 skipped) and the deterministic
  `gate:pi-subagents` preflight passes with `piSubagentsModuleExtension
  ".js"`; the model-backed gate phase was skipped locally for lack of a
  model credential.
- Upgrade `@anthropic-ai/sandbox-runtime` from the exact `0.0.75` pin to
  `^0.0.77` (adds `LinuxSandboxProfileError` exports and an `address` module;
  `NetworkConfigSchema` surface unchanged).
- Move the development `typebox` to `^1.3.34` (peer stays `>=1.0.0`).
- Type checking and the full test suite pass on Pi 0.87.1; the development
  `typescript` stays 6.0.3 (TS7 was evaluated and rejected, see the
  pi-auto-review 0.20.0 notes).

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
