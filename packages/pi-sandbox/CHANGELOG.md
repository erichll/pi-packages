# Changelog

## Unreleased

- Raise the development pin to `pi-subagents ^0.87.0`; the peer stays
  `>=0.83.0`.
- Let the compatibility workflow create capability-bearing user namespaces on
  Ubuntu 26.04 (`kernel.apparmor_restrict_unprivileged_userns=0`). Retry the
  host-IPC tmux pane capture, because tmux 3.6a can still show a blank pane
  immediately after `new-session -d`.
- Verify the deterministic and model-backed pi-subagents compatibility gate
  against pi-subagents 0.87.0 with Pi 1.5.0. The same gate previously passed
  on 0.85.0 and 0.86.0.

## 0.29.2 - 2026-11-03

- Keep the Pi peer floor at `>=1.4.0` and pi-subagents `>=0.83.0`. Raise the
  development baseline to Pi 1.5.0.
- Record that protected mode was tested on Pi 1.4.0 and 1.5.0 with
  pi-subagents 0.83.0 and 0.83.1.
- Verify the type check and the full sandbox test suite against Pi 1.5.0.

## 0.29.1 - 2026-10-29

- Keep the protected pi-subagents capability ceiling active in saved sessions
  on pi-subagents 0.83.1, which looks ceilings up by Pi session id only. The
  ceiling is now registered under both the session id and the session file
  path (used by 0.83.0 background launches), so background children keep the
  five-tool restriction and agent whitelist on either version. Protected
  steering still checks run ownership by session file path, which 0.83.1 did
  not change.
- Raise the development pin to `pi-subagents ^0.83.1`; the peer stays
  `>=0.83.0`.
- Verify the type check, full test suite and both deterministic and
  model-backed pi-subagents compatibility gate phases on 0.83.1, plus the
  pi-subagents tests and deterministic gate on 0.83.0.

## 0.29.0 - 2026-10-28

- Raise the development and peer baselines to Pi 1.4.0, pi-subagents 0.83.0
  and typebox 1.4.3. pi-subagents remains an optional peer. Older peer
  versions are no longer supported by this release.
- Update the pi-auto-review runtime dependency to ^0.28.0.
- Verify the type check, sandbox test suite and both deterministic and
  model-backed pi-subagents compatibility gate phases, including the native
  baseline and protected native-background whitelist.

## 0.28.1 - 2026-10-23

- Support the pi-subagents 0.81.0 bundle layout: the `./capability-ceiling`
  export check accepts `./bundle/` targets in addition to `./src/api/`.
- Locate the pi-subagents package root by walking up from the resolved entry
  to the package manifest, rather than assuming `dirname(entry)` (which sits in
  `bundle/index.js` in 0.81.0).
- Raise development pin to `pi-subagents ^0.81.0`. The npm peer dependency
  (`>=0.80.0`) and structural loader floor (`>=0.79.0`) remain unchanged.
  Verified against 0.81.0: workspace type check, full test suite, and the
  deterministic compatibility gate. See `docs/compat-notes.md`.

## 0.28.0 - 2026-10-21

- Raise the pi-subagents npm peer dependency to `>=0.80.0` and the development
  pin to `^0.80.0`. The structural loader floor stays at `>=0.79.0`. Verified
  against 0.80.0: type check, full sandbox suite, and both deterministic and
  model-backed compat gate phases (native baseline and protected
  native-background whitelist). See `docs/compat-notes.md`.

## 0.27.0 - 2026-10-18

- Raise all development/peer baselines to the latest stable registry releases:
  Pi 1.3.0, pi-subagents 0.79.0, typebox 1.4.2, Node types 26.6.5 and
  TypeScript 7.0.2. Declare the already-imported pi-tui host peer explicitly
  at 1.3.0. Keep pi-subagents optional and do not bundle host peers.
- Align the structural loader with the stable 0.79.0 floor and validate its
  ownership/runtime-root seams as well as discovery/config/ceiling exports.
- Replace protected management's blacklist with an explicit allowlist. Reject
  unknown future actions and chain appends; workflows and resume remain off.
- Require steeringRecovery=false, a complete direct-run ID, current canonical
  agent validation, and host-owned status proof before steering. Ownership of
  an inherited run is not sandbox proof: verify its sandbox-origin ceiling
  and its own child-runtime acknowledgement, and fail closed on missing proof,
  malformed status or linked paths. Inspection/stop remain available. Keep
  status-file-based recovery compatibility; explicitly document that these
  JSON facts are not attestation against writers with runtime-directory access.
- Add real same-process session-succession, input-alias, action-drift and
  runtime-file regression coverage; refresh compatibility documentation.

## 0.26.1 - 2026-10-13

- Upgrade the Pi 1.2.0 development baseline (`pi-coding-agent`, `pi-ai`,
  typebox `>=1.3.37`) and drop the unused
  `@earendil-works/pi-server` development dependency: nothing in this package
  imports it and pi-subagents 0.77.0 no longer references it, while upstream
  removed the package in 1.2.0.
- Revalidate the compatibility gate against pi-subagents 0.78.0 on Pi 1.2.0.
  pi-subagents 0.77.0 required chord for every host from Pi 0.85 onward,
  which broke background children on Pi 1.2.0 (chord removed upstream);
  0.78.0 requires chord only when the host manifest declares it, so the
  package needs no workaround. The deterministic gate and the model-backed
  native baseline / protected child acceptance pass. Raise the pi-subagents
  peer floor to `>=0.78.0` because 0.77.x background children fail on
  Pi 1.2.0; 0.78.0 also works on Pi 1.1.0.
- Keep the pi-coding-agent peer floor at `>=1.1.0`: both 1.1.0 and 1.2.0 are
  verified, so 1.1.0 users are not forced onto the newer Pi.

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
