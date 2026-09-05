# @erichll/pi-sandbox

`pi-sandbox` is a Linux and macOS process sandbox for Pi backed by Anthropic's
`@anthropic-ai/sandbox-runtime`. It protects main-agent Bash commands and can
also run complete process-backed subagent trees inside independent sandboxes.

## Contents

- [Security model](#security-model)
- [Linux requirements](#linux-requirements)
- [Subagent provider](#subagent-provider)
  - [`pi-subagents` 0.65.0 native-background tool boundary](#pi-subagents-0650-native-background-tool-boundary)
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
    "provider": "builtin"
  }
}
```

Supported modes:

- `builtin` (default): register the process-backed `subagent` tool and sandbox
  each complete worker process tree.
- `pi-subagents`: let `pi-subagents 0.65.0` own orchestration under the required
  native-background tool boundary described below.
- `off`: protect Bash only.

### `pi-subagents` 0.65.0 native-background tool boundary

This provider is intentionally locked to exactly `pi-subagents 0.65.0` and
fails closed if its public ceiling API or internal discovery layout drifts.
Configure both the protection mode and a non-empty canonical whitelist:

```json
{
  "subagents": {
    "provider": "pi-subagents",
    "protection": "native-background-tools",
    "allowedNativeAgents": ["worker", "reviewer", "scout"]
  }
}
```

The `pi-subagents` config at
`~/.pi/agent/extensions/subagent/config.json` must also contain
`"scheduledRuns": { "enabled": false }`. Every launch must explicitly set
`async: true`. Only direct single-agent launches are supported. In 0.65.0,
public `workflowScript` / `workflowScriptPath` children disable ambient
extensions, so both are rejected along with named workflows, schedules,
configuration mutations, resume, nested subagents, and external runners.

Every child is constrained by the upstream capability ceiling to `bash`,
`read`, `grep`, `find`, and `ls`. The child loads ambient extensions and must
acknowledge `@erichll:pi-sandbox`; writes can therefore occur only through the
sandboxed Bash tool. `write`, `edit`, MCP, and other extension tools are not
available.

| Capability | `builtin` | `pi-subagents` 0.65.0 protected mode |
| --- | --- | --- |
| Outer worker sandbox | Yes | No |
| Bash sandbox | Yes | Yes |
| Persistent follow-up | Yes | Yes |
| Public async `workflowScript` | No | No (ambient extensions disabled upstream) |
| Schedules / named workflow resources | No | No |
| Child tools | Configured parent tools | Fixed five-tool ceiling |

Before a release, run the deterministic and model-backed portions of
`npm run gate:pi-subagents`. See
`docs/compat-notes.md` for the recorded compatibility seams and how each is
verified on upgrade.

The configuration parser rejects malformed JSON, unknown fields, and unknown
providers instead of silently weakening isolation. All legacy
`externalWorkerIsolation` configurations produce a migration error.

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
The same trusted arrays govern main-agent Bash, built-in subagents, and the
sandboxed Bash tool loaded by protected native `pi-subagents` children.

Domain allowlists are not a complete data-loss-prevention boundary. A
multi-tenant or user-uploadable destination such as `github.com` can itself be
an exfiltration channel; grant only the narrow domains and ports you intend.
Real package-manager traffic may require additional hosts—for example, PyPI
downloads commonly use `files.pythonhosted.org`. `pi-sandbox` never infers or
silently adds those domains.

Native background runner initialization itself is outside the OS sandbox.
Only the child's Bash modification channel is sandboxed. Select `builtin` when
the entire worker process tree must be contained by Sandbox Runtime.

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

`gate:pi-subagents` verifies the pinned package layout, discovery behavior,
capability ceiling, and protected launch policy in an isolated temporary agent
directory. It never reads or updates production Pi configuration. Model-backed
acceptance requires `PI_SUBAGENTS_GATE_MODEL` and an already-exported matching
credential; missing prerequisites are reported as `SKIP`.

The test suite covers real Linux Sandbox Runtime enforcement when its native
dependencies are installed, plus deterministic broker, network approval,
process cleanup, concurrency, and cross-platform orchestration tests.

## Upstream

Sandbox Runtime is an Apache-2.0 licensed research preview:
<https://github.com/anthropic-experimental/sandbox-runtime>.
