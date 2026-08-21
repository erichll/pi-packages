# Changelog

## 0.8.4 - 2026-08-20

- Update the dev-only `pi-subagents` compatibility baseline to `0.53.0`.
- Extend the external-isolation compatibility gate to require and report the
  `0.53.0`-or-newer baseline. No pi-sandbox runtime or public API changes.

## 0.8.3 - 2026-08-20

- Update the exact `@erichll/pi-auto-review` dependency to `0.6.0`, inheriting
  the reviewer change to drop the host-side user-constraint overlay (allow/
  defer/deny judgments stay with the reviewer model).
- Update the dev-only `pi-subagents` baseline to `0.52.0`.
- No pi-sandbox runtime or public API changes.

## 0.8.2 - 2026-08-20

- Update the exact `@erichll/pi-auto-review` dependency to `0.5.0`, inheriting the
  reviewer token-usage optimization: request-aware evidence selection, independent
  compact reviewer requests, a tighten-only input token budget, typed bounded
  retries, and per-attempt usage telemetry.
- No pi-sandbox runtime or public API changes.

## 0.8.1 - 2026-08-19

- Update the exact `@erichll/pi-auto-review` dependency to `0.4.0`, inheriting its
  credential-exfiltration hardening and reviewer authentication-refresh safeguards.
- No pi-sandbox runtime or public API changes.

## 0.8.0 - 2026-08-18

- **Trusted network domain policies.** Persistent `network.allowedDomains` and
  `network.deniedDomains` arrays in the trusted global configuration
  (`~/.pi/agent/extensions/pi-sandbox/config.json`, with legacy fallback) now
  authorize matching connections statically, without the one-shot reviewer.
  Entries use Sandbox Runtime-compatible patterns: exact domains,
  strict-subdomain wildcards such as `*.example.com`, and an optional `:port`;
  a bare `*` (optionally with a port) is accepted only in `deniedDomains`.
  Values are trimmed and deduplicated, and malformed or unknown configuration
  fails closed. Precedence is deterministic — deny, then allow, then the
  existing one-shot reviewer — and empty arrays preserve the previous
  behavior (no persistent network authorization, with every eligible public
  connection reviewed once).
- **Policy parity across execution surfaces.** The same copied network policy
  is applied to main-agent Bash, built-in subagents, and outer-isolated
  `pi-subagents` workers. External workers receive policy only through their
  capability-bound supervisor registration; missing, malformed, or extra-field
  transport becomes deny-all without disabling dynamic review for valid
  policies.
- **Exfiltration-risk documentation.** The README now warns that domain
  allowlists are not a complete data-loss-prevention boundary, that
  multi-tenant or user-uploadable destinations (for example `github.com`) can
  themselves be exfiltration channels, and that pi-sandbox never infers or
  silently adds domains.
- Pin `@anthropic-ai/sandbox-runtime` to `0.0.73` (fixed version; its
  network-policy evaluation semantics are reused by the static allow/deny
  matching).

## 0.7.0 - 2026-08-17

- **Builtin `subagent` model fail-fast.** An explicit `model` on `start`/
  `handoff` is now validated against the host model registry before a child Pi
  spawns. Unknown models fail before any session/broker/process is created;
  ambiguous bare ids are rejected with a `provider/model` hint; a trailing
  `:thinking` suffix is preserved; `status`/`wait`/`stop`/`follow_up` are never
  intercepted.

- **FleetView external-worker display.** Declare `pi-subagents >=0.50.0` as an
  **optional** peer dependency (no forced install for builtin/off users) and
  mirror pi-sandbox's isolated external workers into pi-subagents' FleetView
  (caller-owned `external-runs`) whenever `subagents.provider ===
  "pi-subagents"` AND `externalWorkerIsolation === "enforce"`. Loading uses a
  dynamic import only; import/registry failures disable the display path
  without weakening fail-closed isolation or network approval. v1 records are
  `running`-only and cleaned up on worker unregister, session shutdown, and
  supervisor replacement.

- **`pi-subagents` capability baseline raised to `0.50.0`** (test/CI only;
  does not affect the published runtime). The dev dependency is pinned exactly
  to `0.50.0`, the capability boundary is redocumented, the compatibility-gate
  entry resolves through the package `exports["."]` via `import.meta.resolve`,
  and the external-isolation probe is generalized. Verified by
  `gate:external-isolation` and the model-backed `gate:pi-subagents`
  (`PASS`, `piSubagents: 0.50.0`).

## 0.6.2 - 2026-08-13

- Bump `@erichll/pi-auto-review` to `0.3.5` so consumers inherit the raised
  default model-review timeout (90s) and retries (2) through the broker.
- Update the documented `pi-subagents` capability boundary to `0.45.2` and relax
  the dev dependency to `^0.47.1` (test/CI only; does not affect the published
  runtime).

## 0.6.1 - 2026-08-09

- Upgrade `@anthropic-ai/sandbox-runtime` from `0.0.67` to `0.0.71` (path
  normalization, proxy abort and query-string redaction hardening, per-command
  violation attribution, network domain `:port` suffixes and per-entry deny
  reasons, compacted macOS Seatbelt profiles). No breaking contract changes.
- Give every sandboxed command (main-agent Bash and builtin subagents) a
  **private, writable temp directory**: each invocation creates an isolated
  `pi-sandbox-tmp-*` subdirectory of the host temp tree, adds it to the
  sandbox's read/write allowlists, and points the command's `TMPDIR`, `TMP`,
  and `TEMP` at it. The shared host temp root stays read-only to the sandbox;
  the directory is removed when the command exits. If the host temp directory
  is unavailable (e.g. a read-only `/tmp`), the command degrades to the
  previous denied-temp behaviour instead of failing. This mirrors the outer
  external-worker isolation and unifies the broker temp-dir env under
  `PI_SANDBOX_TMPDIR`.
- Add an injectable `createTempDir` test seam plus a broker probe fixture and
  runner coverage for the private-temp success and degrade paths.

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
