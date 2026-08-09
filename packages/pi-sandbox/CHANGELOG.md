# Changelog

## 0.6.0 - 2026-08-09

- Retarget the development compatibility target from `pi-subagents 0.42.1` to
  `pi-subagents 0.44.0` and update the coexistence assertions, capability
  boundary, and compatibility gate. The 0.44.0 line lands internal
  workflow/mission/schedule fixes that do not change pi-sandbox's contract
  (tool-ownership detection, `PI_SUBAGENT_PI_BINARY` worker bootstrap).
- Adapt the compatibility gate's "direct child" probe to the `workflowScript`
  single-run form: pi-subagents 0.43.0 removed public top-level `agent`/`task`
  direct execution, so the external provider's direct single-child launch is
  now `subagent({ workflowScript: "return runs.run('main', { agent, task })" })`.
  This unblocks the `subagents.externalWorkerIsolation: "enforce"` gate, which
  previously timed out when the isolated worker could not reconcile the removed
  direct signature with the newer `workflowScript`-only contract.

## 0.5.0 - 2026-08-08

- Pin the development compatibility target to `pi-subagents 0.42.1` and add
  coexistence assertions for its package identity and tool ownership.
- Add `npm run gate:pi-subagents`, an opt-in real-Pi compatibility gate. It
  uses an isolated agent directory and reports `SKIP` unless a dedicated gate
  model and credentials are supplied. The gate now waits for returned child
  results and uses configurable provider-latency timeouts.
- Add the opt-in `subagents.externalWorkerIsolation: "enforce"` bootstrap for
  external `pi-subagents` workers. It uses a tarball-shipped launcher and
  fails closed if its outer Sandbox Runtime broker cannot start, protects
  first-time security configuration creation, and cleans up only unchanged
  temporary bind placeholders.

## 0.4.3 - 2026-08-06

- Move the `pi-auto-review` dependency to `0.3.3`, which allows multi-segment
  model ids (`provider/group/model`) in the reviewer config.
- Bump `pi-subagents` dev dependency to `0.41.0` (build/test tooling only).

## 0.4.2 - 2026-07-30

- Load trusted configuration from
  `~/.pi/agent/extensions/pi-sandbox/config.json`, with a read fallback to the
  legacy `~/.pi/agent/pi-sandbox.json` path when the new file is absent.
- Deny writes to common workspace secrets by default (`.env` variants,
  `secrets/` / `.secrets/`, and discovered `*.pem` / `*.key` / `*.p12` /
  `*.pfx`), while leaving template files such as `.env.example` writable.
- Protect `~/.pi/agent/extensions` (including the extension-local config) from
  sandboxed writes.
- On macOS, add git-style secret globs for nested create protection; Linux keeps
  literal absolute paths only because Sandbox Runtime drops globs there.

## 0.4.1 - 2026-07-29

- Republish to refresh the npm search index used by the pi.dev package gallery.
- Depend on `@erichll/pi-auto-review@0.3.2`.

## 0.4.0 - 2026-07-29

- Add an optional, approval-gated Host-IPC Bash backend for commands that need
  access to host Unix sockets.
- Support trusted preflight command prefixes without treating a prefix as
  authorization; every complete command still requires an exact one-shot
  approval.
- Support one non-recursive host retry after a narrowly detected Unix-socket
  `Operation not permitted` sandbox failure.
- Preserve the first attempt's output, apply only the original timeout's
  remaining duration, and never retry successful, timed-out, or aborted
  commands.
- Refuse Host-IPC forwarding for built-in subagents.
- Add deterministic execution and approval coverage plus a Linux tmux socket
  smoke test.

## 0.3.1 - 2026-07-29

- Add trusted global filesystem read-path extensions while keeping default
  write and configuration protections intact.

## 0.3.0 - 2026-07-28

- Initial public release.
