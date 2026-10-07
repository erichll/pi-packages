# Compatibility seams with `pi-subagents`

`@erichll/pi-sandbox` supports protected external orchestration on the
`pi-subagents >=0.66.0` line: the peer dependency is a floor with no upper pin,
and the development dependency is pinned to `^0.75.0` (validated on 0.75.0). The real gates are the
`./capability-ceiling` export and the capability-ceiling API version, which the
loader checks at load time; the version range only rejects old lines and guards
against blind accept-on-drift. Any mismatch disables the whole mode rather than
reducing protection.

## Security contract

The `pi-subagents` provider is a native-background **tool boundary**, not an OS
process sandbox. The trusted configuration must select
`protection: "native-background-tools"`, list canonical agents in
`allowedNativeAgents`, and set `scheduledRuns.enabled=false` in the upstream
pi-subagents config.

At session start and before every launch, pi-sandbox uses the internal
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
rejected too.
Child runtimes emit the upstream-safe stable `subagent:acknowledge-extension` ID
`@erichll:pi-sandbox`; terminal child records returned by status/debug fail
closed without that proof.

Ambient extension initialization and the detached native runner are outside
Sandbox Runtime. The protected modification channel is sandboxed Bash; use the
default `builtin` provider for complete worker-process-tree isolation.

## Versioned seams

| Seam | Status on the `>=0.66.0` line (validated on 0.75.0) | Verification |
| --- | --- | --- |
| package version | must be `>=0.66.0`; below it the loader fails closed | runtime loader + deterministic gate |
| `./capability-ceiling` export | public; expected path and API v1 | runtime loader + tests |
| module layout | `.ts` source (0.66.0-0.69.0) or compiled `.js`/`.d.ts` (0.70.0+) under `src/`, same relative paths | runtime loader + tests |
| host peer `@earendil-works/pi-tui` | supplied by Pi; filesystem alias on Node, host module object on Bun | runtime loader + isolated Node/Bun/compiled-Bun tests |
| `src/agents/agents.<ext>` | internal discovery and canonical resolution; 0.72.0 adds an optional `options.globalNpmRoot` argument and leaves the 3-argument form unchanged | runtime loader + tests |
| `src/extension/config.<ext>` | internal config loader | runtime loader + tests |
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

Host requirement: these packages require Pi 1.0.0 or newer (the
`peerDependencies` floor, validated 2026-10-02). Historically the floor was
0.87.1, before that 0.86.0, and before that 0.85.1: Pi 0.85.0
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

Validated on Pi 1.0.0 / Bun 1.3.14 with a copied pi-subagents 0.75.0 package in
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

Since 0.72.0 `typebox` is the same kind of host-provided dependency: it moved
from `pi-subagents`' `dependencies` to an optional `peerDependencies` entry, so
the extension no longer ships a copy. The loader's module graph does reach it -
`src/extension/schemas`, `src/watchdog/*`, and
`src/intercom/native-supervisor-channel` import it. Bun uses the host module
object described above. Node retains ordinary package resolution for these
imports. The importing module set is unchanged
from 0.71.0, in a global `~/.pi/agent/npm` install the hoisted copy comes from
Pi's own `@earendil-works/pi-ai`, and `@erichll/pi-sandbox`'s `typebox >=1.0.0`
peer is satisfied by that same hoisted copy.

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
