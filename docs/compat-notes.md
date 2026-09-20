# Compatibility seams with `pi-subagents`

`@erichll/pi-sandbox` supports protected external orchestration on the
`pi-subagents >=0.66.0` line: the peer dependency is a floor with no upper pin,
and the development dependency is pinned to `^0.69.0`. The real gates are the
`./capability-ceiling` export path and the capability-ceiling API version,
which the loader checks at load time; the version range only rejects old lines
and guards against blind accept-on-drift. Any mismatch disables the whole mode
rather than reducing protection.

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
launches are allowed. Public inline/path `workflowScript` children disable
ambient extensions upstream and are therefore rejected, as are named workflows,
external runners, schedules, resume, and agent/workflow management mutations.
Child runtimes emit the upstream-safe stable `subagent:acknowledge-extension` ID
`@erichll:pi-sandbox`; terminal child records returned by status/debug fail
closed without that proof.

Ambient extension initialization and the detached native runner are outside
Sandbox Runtime. The protected modification channel is sandboxed Bash; use the
default `builtin` provider for complete worker-process-tree isolation.

## Versioned seams

| Seam | Status on the `>=0.66.0` line (validated on 0.69.0) | Verification |
| --- | --- | --- |
| package version | must be `>=0.66.0`; below it the loader fails closed | runtime loader + deterministic gate |
| `./capability-ceiling` export | public; expected path and API v1 | runtime loader + tests |
| `src/agents/agents.ts` | internal discovery and canonical resolution | runtime loader + tests |
| `src/extension/config.ts` | internal config loader | runtime loader + tests |
| child acknowledgement | event `subagent:acknowledge-extension` | unit/model gate |
| `bg_wait` completion details | must carry runtime acknowledgement | result guard/model gate |

Host requirement: these packages require Pi 0.86.0 or newer (the
`peerDependencies` floor), which is therefore also the floor for protected mode
with pi-subagents 0.68.0 or newer. Historically the floor was 0.85.1: Pi 0.85.0
does not ship `@earendil-works/pi-server`, which 0.68.0 stopped bundling, so
background children fail to launch there with an explicit error. The `builtin`
provider is unaffected.

The old `PI_SUBAGENT_PI_BINARY`, external launcher/supervisor, external network
transport, and FleetView seams were removed because the native-background
children they targeted no longer use that process-launch contract.

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
