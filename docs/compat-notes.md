# Compatibility seams with `pi-subagents`

`@erichll/pi-sandbox 0.16.0` supports protected external orchestration only
with exactly `pi-subagents 0.65.0`. Both the peer dependency and development
dependency are exact pins. Version or internal-layout drift disables the whole
mode rather than reducing protection.

## Security contract

The `pi-subagents` provider is a native-background **tool boundary**, not an OS
process sandbox. The trusted configuration must select
`protection: "native-background-tools"`, list canonical agents in
`allowedNativeAgents`, and set `scheduledRuns.enabled=false` in the upstream
pi-subagents config.

At session start and before every launch, pi-sandbox uses the pinned internal
`src/agents/agents.ts` discovery API to require that each name resolves uniquely
to the same canonical name, is enabled, uses the default or `pi` runner, keeps
ambient extensions enabled, and does not allow nested subagents. The public
`pi-subagents/capability-ceiling` API then restricts all dynamic children to the
validated names and the tools `bash`, `read`, `grep`, `find`, and `ls`.

Every launch must explicitly set `async: true`, and only direct single-agent
launches are allowed. Public inline/path workflows disable ambient extensions
in 0.65.0 and are therefore rejected, as are named workflows, external runners,
schedules, resume, and agent/workflow management mutations. Child runtimes emit
the upstream-safe stable `subagent:acknowledge-extension` ID
`@erichll:pi-sandbox`; terminal child records returned by status/debug fail
closed without that proof.

Ambient extension initialization and the detached native runner are outside
Sandbox Runtime. The protected modification channel is sandboxed Bash; use the
default `builtin` provider for complete worker-process-tree isolation.

## Versioned seams

| Seam | Status in 0.65.0 | Verification |
| --- | --- | --- |
| package version | must equal `0.65.0` | runtime loader + deterministic gate |
| `./capability-ceiling` export | public; expected path and API v1 | runtime loader + tests |
| `src/agents/agents.ts` | pinned internal discovery and canonical resolution | runtime loader + tests |
| `src/extension/config.ts` | pinned internal config loader | runtime loader + tests |
| child acknowledgement | event `subagent:acknowledge-extension` | unit/model gate |
| `bg_wait` completion details | must carry runtime acknowledgement | result guard/model gate |

The old `PI_SUBAGENT_PI_BINARY`, external launcher/supervisor, external network
transport, and FleetView seams were removed because 0.65.0 native children no
longer use that process-launch contract.

## Upgrade procedure

1. Audit the candidate package source and exports before changing either exact
   pin.
2. Update the compatibility loader and tests for every intentional structural
   change; do not broaden version ranges.
3. Run `npm run check && npm test`.
4. Run `npm run gate:pi-subagents`. A credential-related `SKIP` is not a model
   acceptance pass.
5. Run `git diff --check`.

On any mismatch, keep the provider unavailable or select `builtin`; never fall
back to an unprotected native or external worker.
