# @erichll/pi-sandbox

`pi-sandbox` is a Linux and macOS process sandbox for Pi backed by Anthropic's
`@anthropic-ai/sandbox-runtime`. It protects main-agent Bash commands and can
also run complete process-backed subagent trees inside independent sandboxes.

## Contents

- [Security model](#security-model)
- [Linux requirements](#linux-requirements)
- [Subagent provider](#subagent-provider)
  - [`pi-subagents` 0.64.0 capability boundary](#pi-subagents-0640-capability-boundary)
- [Network domain policy](#network-domain-policy)
- [Optional host IPC fallback](#optional-host-ipc-fallback)
- [Additional trusted read paths](#additional-trusted-read-paths)
- [Installation](#installation)
- [Development](#development)
- [Upstream](#upstream)

## Security model

- Linux uses bubblewrap mount/network namespaces and seccomp.
- macOS uses generated Seatbelt profiles.
- Filesystem access is a static policy: reads outside the allowed regions and
  writes outside the workspace fail closed. Runtime filesystem denials are not
  converted into dynamic grants because Sandbox Runtime does not expose a
  trustworthy filesystem ask callback.
- Network policy is evaluated as static deny, then static allow, then dynamic
  review. Each unmatched public destination is sent to `pi-auto-review` as a
  canonical hostname and concrete port. An approval applies only to that
  connection.
- Every Bash command and persistent subagent session owns a separate broker
  process and Sandbox Runtime manager. Concurrent workers therefore keep
  independent policy, proxy, approval, and cleanup lifecycles.
- Each sandboxed command is given a **private, writable temp directory**: a
  fresh `pi-sandbox-tmp-*` subdirectory of the host temp tree that is added to
  the sandbox's read/write allowlists, with the command's `TMPDIR`, `TMP`, and
  `TEMP` pointed at it. Only that isolated directory is writable — the shared
  host temp root (e.g. `/tmp` itself) stays read-only to the sandbox — and it
  is removed when the command exits. If the host temp directory is unavailable
  (e.g. a read-only `/tmp`) the command degrades to the previous denied-temp
  behaviour rather than failing.
- Project and global Pi security configuration, the trusted extensions tree,
  the installed package, Git hooks, and other Sandbox Runtime mandatory paths
  remain write-protected.
- Common workspace secrets are write-denied by default: root-level `.env`
  variants, `secrets/` / `.secrets/`, plus a shallow scan for nested `.env*`,
  `*.pem`, `*.key`, `*.p12`, and `*.pfx`. Template files such as
  `.env.example` stay writable. On macOS, additional globs also block nested
  creates; Linux Sandbox Runtime only enforces literal paths, so nested creates
  of new secret files remain a residual risk outside the scanned set.
- Optional host IPC execution is disabled by default. When enabled, every
  complete host command still requires a one-shot `pi-auto-review` or human
  approval and runs outside the OS sandbox.

Windows is not supported by this Pi adapter.

## Linux requirements

Install the native helpers before loading the extension:

```bash
sudo apt-get install bubblewrap socat ripgrep
```

Unprivileged user namespaces must be available. On Ubuntu 24.04+, either
configure an AppArmor profile for bubblewrap or disable
`kernel.apparmor_restrict_unprivileged_userns`.

macOS uses built-in Seatbelt support but still requires `ripgrep`.

## Subagent provider

The provider is selected only from the trusted global file
`~/.pi/agent/extensions/pi-sandbox/config.json`:

If that file is missing, `pi-sandbox` still loads the legacy path
`~/.pi/agent/pi-sandbox.json` when present. Prefer the extension-local path for
new installs.

```json
{
  "subagents": {
    "provider": "builtin",
    "externalWorkerIsolation": "off"
  }
}
```

Supported modes:

- `builtin` (default): register the process-backed `subagent` tool and sandbox
  each complete worker process tree.
- `pi-subagents`: let the external extension own orchestration. Main-agent and
  inherited Bash execution remains sandboxed, but the external worker process
  itself is not wrapped while `externalWorkerIsolation` is `off`.
- `off`: protect Bash only.

### `pi-subagents` 0.64.0 capability boundary

`pi-sandbox` verifies the following combination in its test suite and release
gate. This version boundary is pinned exactly (see the package
`devDependencies`) and additionally exercised against the latest published
`pi-subagents` on a nightly CI schedule. The `PI_SUBAGENT_PI_BINARY` seam
(`externalWorkerIsolation: "enforce"`) is re-checked deterministically by the
`gate:external-isolation` probe on the pinned and latest dependency. The
published peer range remains `>=0.50.0`; this documents the current tested
development baseline, not a runtime minimum.

| Capability | `builtin` | `pi-subagents` 0.64.0 |
| --- | --- | --- |
| Outer worker sandbox | Yes | Opt-in (`externalWorkerIsolation: "enforce"`) |
| Bash sandbox | Yes | Yes |
| Persistent follow-up | Yes | Yes |
| `workflowScript`, missions, schedules | No | Yes |
| Named workflow resources | No | Yes |
| permission-system parent forwarding | Not required | Verified by compatibility gate |

Moving the tested baseline requires re-running `npm run gate:external-isolation`
and, before a release, the model-backed `npm run gate:pi-subagents`. See
`docs/compat-notes.md` for the recorded compatibility seams and how each is
verified on upgrade.

The 0.64.0 baseline also exercises tasks passed as an `@task.md` argument,
standard Git worktree metadata (`.git` pointer plus `commondir`), and the
read-only `watchdog_diff` tool through the real outer-sandbox launcher. Its
watchdog `action: "block"` launch rule is checked before worker spawn planning,
and the model-backed gate verifies that a blocked child creates no transcript
before running the normal isolated-worker probes. Worktrunk itself is not a
dependency; provider selection remains upstream behavior.

For the external provider, `off` leaves the worker process outside the outer
Sandbox Runtime boundary. Do not treat inherited Bash sandboxing as complete
worker isolation unless the trusted global configuration explicitly enables
`enforce`.

Note on the external provider's public execution surface: pi-subagents 0.43.0
removed the old static multi-agent controls; `workflowScript` remains the
public multi-agent orchestration surface. Current releases also accept a direct
single-child `{ agent, task }` launch. The compatibility gate deliberately uses
`return runs.run('main', { agent, task })` so the single-child probe continues
to exercise the workflow executor and its isolation seam.

The configuration parser rejects malformed JSON, unknown fields, and unknown
providers instead of silently weakening isolation.

## Network domain policy

Persistent domain authorization is accepted only from the trusted global
`~/.pi/agent/extensions/pi-sandbox/config.json` (or its legacy trusted fallback
when the new file is absent). Project configuration cannot override it.

```json
{
  "network": {
    "allowedDomains": [
      "github.com",
      "*.github.com",
      "registry.npmjs.org:443"
    ],
    "deniedDomains": [
      "uploads.github.com",
      "*:22"
    ]
  }
}
```

Entries support exact domains, strict-subdomain wildcards such as
`*.example.com`, and an optional `:port` restriction. A bare `*` (optionally
with a port) is accepted only in `deniedDomains`. Values are trimmed and
deduplicated, and malformed or unknown configuration fails closed.

The precedence is deterministic:

1. A matching `deniedDomains` entry rejects the connection.
2. Otherwise, a matching `allowedDomains` entry permits it without review.
3. Otherwise, the canonical public hostname and port enter the existing
   one-shot auto-review or human approval flow.

Both arrays default to empty. That preserves the prior behavior: no persistent
network authorization, with every eligible public connection reviewed once.
The same trusted arrays are copied into main-agent Bash, built-in subagents,
and external `pi-subagents` workers when outer isolation is enforced. Missing
or malformed external-worker policy transport hard-denies network access.

Domain allowlists are not a complete data-loss-prevention boundary. A
multi-tenant or user-uploadable destination such as `github.com` can itself be
an exfiltration channel; grant only the narrow domains and ports you intend.
Real package-manager traffic may require additional hosts—for example, PyPI
downloads commonly use `files.pythonhosted.org`. `pi-sandbox` never infers or
silently adds those domains.

To opt in to outer worker isolation for the external provider, use:

```json
{
  "subagents": {
    "provider": "pi-subagents",
    "externalWorkerIsolation": "enforce"
  }
}
```

`enforce` installs a session-scoped `PI_SUBAGENT_PI_BINARY` wrapper which
starts the real Pi worker under a dedicated Sandbox Runtime broker. Bootstrap
failure is terminal for that worker; it never falls back to host execution.
The wrapper is preserved for nested child launches. This is opt-in while the
permission-forwarding supervisor and managed-worktree gate continue to mature.

Managed worktrees receive their own writable checkout plus the smallest known
Git metadata paths as read-only access so `git status` works. The main
repository `.git` is never made writable by this policy; Git mutation from an
outer-sandboxed external worker is therefore intentionally unsupported for
now.

## Optional host IPC fallback

Some host services expose only a Unix socket that the OS sandbox cannot use.
The trusted global configuration can enable an approval-driven local Bash
backend for those commands:

```json
{
  "hostIPC": {
    "mode": "ask",
    "preflightCommandPrefixes": ["tmux", "/usr/bin/tmux"],
    "retryOnUnixSocketError": true
  }
}
```

`mode` is `off` by default and only accepts `off` or `ask`. Prefixes are
trimmed, deduplicated, and must be non-empty. A prefix matches only at the
start of the trimmed command and must end at whitespace or the end of the
command. Prefixes select commands for review; they never authorize execution.
The reviewer and one-shot grant are bound to the full command and working
directory.

With `retryOnUnixSocketError` enabled, commands not selected for preflight
still run in Sandbox Runtime first. A single host retry is considered only
after a nonzero exit whose stderr identifies both `Operation not permitted`
and a socket/connect/IPC operation. The original output is retained, and the
approval warns that the first attempt may already have had partial side
effects. Successful, timed-out, or aborted commands are never retried.

Host forwarding is intentionally unavailable inside built-in subagents in
this version.

## Additional trusted read paths

The trusted global configuration may append absolute paths to the sandbox's
default read allowlist. This is useful for executables installed below the
otherwise-denied home directory:

```json
{
  "subagents": {
    "provider": "builtin"
  },
  "filesystem": {
    "additionalAllowRead": [
      "/home/user/.local/bin/rtk"
    ]
  }
}
```

`filesystem.additionalAllowRead` must be an array of absolute paths. These
paths extend the defaults; they do not replace the workspace, Node.js, or
Sandbox Runtime read permissions. Keep entries as narrow as possible and
prefer an exact executable path over allowing an entire bin directory.

Persistent built-in sessions support `start`, `follow_up`, `wait`, `status`,
`stop`, and nested `handoff` operations. At most four sessions are live at
once, and nesting depth is capped at three.

## Installation

Load `pi-auto-review` first so its broker is available:

```bash
pi install npm:@erichll/pi-auto-review
pi install npm:@erichll/pi-sandbox
```

Do not install security packages project-locally. Development loading from
this repository requires `PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1`.

## Development

From the monorepo root:

```bash
npm install
npm run check
npm test
npm run gate:pi-subagents
```

`gate:pi-subagents` is a release/manual integration check, not a default CI
test. Set `PI_SUBAGENTS_GATE_MODEL` to a configured test model and provide its
normal Pi credential environment. The command creates a dedicated temporary
agent directory, never reads or updates your production Pi config, and prints
`SKIP` when those prerequisites are absent.

It allows 10 minutes for the direct-child phase and 15 minutes for the
multi-stage workflow, and exits only after the parent reports returned child
results. Override those bounds with positive millisecond values in
`PI_SUBAGENTS_GATE_DIRECT_TIMEOUT_MS` and
`PI_SUBAGENTS_GATE_WORKFLOW_TIMEOUT_MS` when needed for a dedicated provider.

The test suite covers real Linux Sandbox Runtime enforcement when its native
dependencies are installed, plus deterministic broker, network approval,
process cleanup, concurrency, and cross-platform orchestration tests.

## Upstream

Sandbox Runtime is an Apache-2.0 licensed research preview:
<https://github.com/anthropic-experimental/sandbox-runtime>.
