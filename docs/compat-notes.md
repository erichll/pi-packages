# Compatibility seams with `pi-subagents`

`@erichll/pi-sandbox` supports protected external orchestration on the
`pi-subagents >=0.79.0` line: the structural loader floor has no upper pin, and the
npm peer dependency is `>=0.80.0` (deterministically validated on 0.79.0 and
0.80.0).
The structural loader now shares that stable-version floor because it uses the
0.79 session-succession ownership seam. Source and compiled layouts remain
recognized, but old versions and prereleases are rejected. The loader validates
the `./capability-ceiling` export, API version, discovery/config functions,
run ownership and runtime paths; the version range alone is not proof of safety. Any mismatch disables the whole mode rather than
reducing protection.

## Security contract

The `pi-subagents` provider is a native-background **tool boundary**, not an OS
process sandbox. The trusted configuration must select
`protection: "native-background-tools"`, list canonical agents in
`allowedNativeAgents`, and set `scheduledRuns.enabled=false` in the upstream
pi-subagents config.

At session start and before every launch or steering operation, pi-sandbox uses the internal
`src/agents/agents.ts` discovery API to require that each name resolves uniquely
to the same canonical name, is enabled, uses the default or `pi` runner, keeps
ambient extensions enabled, and does not allow nested subagents. The public
`pi-subagents/capability-ceiling` API then restricts all dynamic children to the
validated names and the tools `bash`, `read`, `grep`, `find`, and `ls`.

Every launch must explicitly set `async: true`, and only direct single-agent
launches are allowed. Public workflow launches disable ambient extensions upstream
and are therefore rejected: since pi-subagents 0.73.0 the inline
`workflow: true` script, a `workflow` path, and a named workflow all arrive in
the single `workflow` parameter, and the loader rejects any call that sets it.
External runners, schedules, resume, and agent/workflow management mutations are
rejected too. Management uses an explicit allowlist: list/get/status/debug.run,
models/guide/validate, stop/interrupt/dismiss, and restricted steer. Unknown
future actions and append-step are denied.

Steer must explicitly disable `steeringRecovery` in `options` or its legacy
top-level field; otherwise upstream can internally resume a child. It requires
a complete run ID (no prefixes or caller-selected directory) and a host-owned,
non-symlinked status record for a running direct single-child run. Ownership
uses upstream same-process succession, but is checked separately from the
sandbox-origin five-tool ceiling and the child's own runtime acknowledgement.
An inherited unprotected child cannot be retroactively sandboxed: steering is
blocked, while read-only inspection and stop remain available. This is a
best-effort runtime evidence check, not cryptographic attestation. Any host-side
writer allowed to modify the upstream async directory (including a parent tool
with that filesystem access) can forge these JSON records. We retain
status-file-based recovery compatibility rather than requiring a process-local
launch-receipt registry; protect the runtime directory separately when that
stronger threat model matters.

Child runtimes emit the upstream-safe stable `subagent:acknowledge-extension` ID
`@erichll:pi-sandbox`; terminal child records returned by status/debug fail
closed without that proof.

Ambient extension initialization and the detached native runner are outside
Sandbox Runtime. The protected modification channel is sandboxed Bash; use the
default `builtin` provider for complete worker-process-tree isolation.

## Versioned seams

| Seam | Status on the `>=0.79.0` loader floor (validated on 0.79.0 and 0.80.0) | Verification |
| --- | --- | --- |
| package version | npm peer requires stable `>=0.80.0`; structural loader requires stable `>=0.79.0` on the 0.x line | npm peer + runtime loader + deterministic gate |
| `./capability-ceiling` export | public; expected path and API v1 | runtime loader + tests |
| module layout | `.ts` source (0.66.0-0.69.0) or compiled `.js`/`.d.ts` (0.70.0+) under `src/`, same relative paths | runtime loader + tests |
| host peer `@earendil-works/pi-tui` | supplied by Pi; filesystem alias on Node, host module object on Bun | runtime loader + isolated Node/Bun/compiled-Bun tests |
| `src/agents/agents.<ext>` | internal discovery and canonical resolution; 0.72.0 adds an optional `options.globalNpmRoot` argument and leaves the 3-argument form unchanged | runtime loader + tests |
| `src/extension/config.<ext>` | internal config loader | runtime loader + tests |
| `src/runs/shared/run-ownership.<ext>` | `ownsRun` includes in-process predecessor sessions | runtime loader + real succession tests |
| `src/shared/types.<ext>` | `DIRS.async` supplies the host-owned run root | runtime loader + path/symlink/malformed-status tests |
| child acknowledgement | event `subagent:acknowledge-extension` | unit/model gate |
| `bg_wait` completion details | must carry runtime acknowledgement | result guard/model gate |

## Module layout

The npm package changed shape in 0.70.0: instead of publishing the TypeScript
source checkout, the release is built into `dist-pkg` (the repository package is
now `private: true`) and ships compiled `.js` plus `.d.ts` modules. The
`./capability-ceiling` export is therefore a `{ types, default }` condition map
pointing at `./src/api/capability-ceiling.js` where 0.69.0 published the bare
string `./src/api/capability-ceiling.ts`.

The loader accepts exactly those two shapes and derives both the module
extension and the internal module paths from the capability-ceiling export, so
the source and compiled lines are validated by the same code path. Unknown
export targets still fail closed instead of probing the filesystem. Extension
loading stays on `jiti`, which handles the `.ts` source layout and the plain
ESM `.js` layout identically.

The `PI_SUBAGENT_PARENT_SESSION` marker also changed behavior in 0.70.0: the
root session deletes its self-referential copy during `session_start` while
detached runners still receive the marker from their exact launch. Protected
mode requires `async: true` children (detached runners), so forwarded-permission
routing is unaffected; `scripts/pi-subagents-parent-forwarding-adapter.ts`
remains only as a no-op shim for the 0.69.0-and-earlier line.

Host requirement: these packages now require Pi 1.3.0 or newer, with
permission-system 41.0.0 and typebox 1.4.2 development/peer baselines.
Historically the Pi floor was 1.1.0 (then 1.2.0 was tested), 1.0.0, before that 0.87.1, 0.86.0, and 0.85.1: Pi 0.85.0
does not ship `@earendil-works/pi-server`, which 0.68.0 stopped bundling, so
background children fail to launch there with an explicit error. The `builtin`
provider is unaffected.

The old `PI_SUBAGENT_PI_BINARY`, external launcher/supervisor, external network
transport, and FleetView seams were removed because the native-background
children they targeted no longer use that process-launch contract.

## Host peer resolution

`pi-subagents` imports `@earendil-works/pi-tui` from the internal modules this
loader loads (`src/extension/config.<ext>` among them) but, as a host peer, does
not ship it. Pi's own extension loader aliases that specifier to the copy inside
the running Pi package, and the protected-mode loader creates its own `jiti`
instance. On Node, it computes the same alias from the host package root discovered
through `process.argv[1]` (or `PI_PACKAGE_DIR`, which Pi honors for Nix/Guix
store paths), then falls back to plain Node resolution from the extension tree.
Without it, installs where the peer is not hoisted next to the extension - for
example `~/.pi/agent/npm/node_modules` - fail to load with `pi-subagents
compatibility failure: Cannot find module '@earendil-works/pi-tui'`. An
unresolvable host peer leaves resolution to `jiti` and keeps that explicit
failure. On Node, the alias therefore requires `@earendil-works/pi-tui` to be
reachable from either the running Pi install or the extension tree.

On Bun, filesystem resolution cannot reliably find Pi's embedded peers. The
adapter statically imports `pi-tui` and `typebox` through Pi's outer extension
loader, then supplies those module objects to its own jiti instance through
`virtualModules`, with `tryNative: false`. Static imports matter for plain Bun:
deferring the imports until after extension loading can leave them running
through Bun's native resolver outside Pi's host alias handling. Pi's own
compiled loader supplies its embedded modules to these imports. Our adapter
remains an on-disk extension and can use the normal jiti entry; it does not need
to import Pi's private `virtual-modules.js` or compiled loader internals.

Revalidated on Pi 1.1.0 with a copied pi-subagents 0.76.1 package in
an isolated directory containing neither `pi-tui` nor `typebox`. Node Pi,
plain Bun Pi, and compiled Bun Pi all load the protected adapter. The test reads
the inner loader's capability ceiling through the host-loaded public API and
verifies disposal, the five-tool limit, unknown-agent rejection, and enabled
schedule rejection. This covers module loading and the ceiling contract.

Model-backed acceptance was run on 2026-10-03 against the same pin: the gate's
native baseline and the protected native-background whitelist both pass, with
parent model `cliproxyapi/codex-auto-review` and child model
`cliproxyapi/gpt-5.6-luna`, reporting `baseline: native-host-readable` and
`protected: sandboxed-bash-blocked-host-read`. Model-backed native child
acceptance remains part of the release gate below.

Release preparation for auto-review / sandbox 0.25.0 revalidated the same
deterministic and model gates on 2026-10-07, with permission-system 40.0.2 and
Pi 1.0.0. Both phases passed using the same parent/child models and reported
`baseline: native-host-readable`, `protected: sandboxed-bash-blocked-host-read`,
and `acknowledgement: @erichll:pi-sandbox`.

The 2026-10-08 upgrade to Pi 1.1.0 / pi-subagents 0.76.1 passes the
deterministic gate and the isolated Node, Bun, and compiled-Bun tests. The
capability-ceiling and config modules are byte-identical to 0.75.0; discovery
changes add settings-file leases without changing the loader's read seams.
The copied-package test now locates regular dependencies through their
exported entry because the new Temporal polyfill does not export package.json.
Release preparation for auto-review / sandbox 0.26.0 additionally passed
model-backed acceptance on 2026-10-08, using parent
`cliproxyapi/codex-auto-review` and child `cliproxyapi/gpt-5.6-luna` with Pi
1.1.0 / pi-subagents 0.76.1. Both phases report
`baseline: native-host-readable`, `protected: sandboxed-bash-blocked-host-read`,
and `acknowledgement: @erichll:pi-sandbox`.

Since 0.72.0 `typebox` is the same kind of host-provided dependency: it moved
from `pi-subagents`' `dependencies` to an optional `peerDependencies` entry, so
the extension no longer ships a copy. The loader's module graph does reach it -
`src/extension/schemas`, `src/watchdog/*`, and
`src/intercom/native-supervisor-channel` import it. Bun uses the host module
object described above. Node retains ordinary package resolution for these
imports. The importing module set is unchanged
from 0.71.0, in a global `~/.pi/agent/npm` install the hoisted copy comes from
Pi's own `@earendil-works/pi-ai`. The current sandbox peer floor is
`typebox >=1.4.2`; install that version separately when the host's embedded
or hoisted copy is older. The development workspace uses 1.4.2 and Pi 1.3.0.
The isolated host-peer tests cover Node, Bun and compiled-Bun loading.

## 2026-10-21 pi-subagents 0.80.0 verification

The sandbox peer dependency is raised to `pi-subagents >=0.80.0` and the
development pin to `^0.80.0`; the structural loader floor stays at
`>=0.79.0`. Upstream 0.80.0 keeps the `./capability-ceiling` export, agent
discovery, ownership and runtime-path seams unchanged from 0.79.x (its changes
are the Pi 1.2.0 floor, per-child `cwd`/`model` in workflow args,
`enableSlashCommands`, dropped source maps and the `*-codex-responses`
tool-call-id fix, none of which touch the validated seams).

`npm run check` passes, the sandbox suite reports 118 passed plus the same
native-runtime temp-environment skip, and both gate phases pass against
0.80.0 with parent `cliproxyapi/codex-auto-review` and child
`cliproxyapi/gpt-5.6-luna`: `baseline: native-host-readable`,
`protected: sandboxed-bash-blocked-host-read`,
`acknowledgement: @erichll:pi-sandbox`.

## 2026-10-18 baseline verification

The security packages now use Pi 1.3.0, permission-system 41.0.0,
pi-subagents 0.79.0, typebox 1.4.2, Node types 26.6.5 and TypeScript 7.0.2
as their development/peer baselines. The upstream ceiling, discovery and config
implementations are unchanged from 0.78.0; ownership now includes same-process
session succession, so steering separately verifies live protection provenance.

`npm run check` passes. The complete workspace suite reports auto-review
256/256, sandbox 118 passed plus one native-runtime temp-environment skip, and
statusline 99/99. New deterministic tests exercise upstream's real succession
registry, protected versus unprotected inherited targets, aliases, disabled
recovery, missing/corrupt status and symlink rejection.

The deterministic gate and model-backed native baseline/protected-child gate
both pass with parent `cliproxyapi/codex-auto-review` and child
`cliproxyapi/gpt-6-luna`: `baseline: native-host-readable`,
`protected: sandboxed-bash-blocked-host-read`,
`acknowledgement: @erichll:pi-sandbox`. The model gate also validates that real
emitted child metadata has the shape required by the steering-proof checker;
this metadata-shape check is not an end-to-end live steering test.

The install audit separately reports a high-severity advisory in node-forge,
via the unchanged sandbox-runtime dependency. npm's proposed remediation is a
runtime downgrade, not a fixed compatible release; no forced downgrade or
automatic audit fix is applied as part of the dev/peer upgrade.

## Upgrade procedure

1. Audit the candidate package source and exports before moving the floor or the
   development pin.
2. Update the compatibility loader, the deterministic gate, and the tests for
   every intentional structural change. Keep the explicit export/layout checks
   as the gate instead of relying on the version range.
3. Revalidate against the published package and record the version and date in
   the loader comment and this file.
4. Run `npm run check && npm test`.
5. Run the gate: `npm run gate:pi-subagents` (equivalently `node
   --experimental-strip-types scripts/pi-subagents-compat-gate.ts`). A
   credential-related `SKIP` is not a model acceptance pass.
6. Run `git diff --check`.

On any mismatch, keep the provider unavailable or select `builtin`; never fall
back to an unprotected native or external worker.
