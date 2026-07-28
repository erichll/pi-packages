# @erichll/pi-sandbox

`pi-sandbox` is a Linux and macOS process sandbox for Pi backed by Anthropic's
`@anthropic-ai/sandbox-runtime`. It protects main-agent Bash commands and can
also run complete process-backed subagent trees inside independent sandboxes.

## Security model

- Linux uses bubblewrap mount/network namespaces and seccomp.
- macOS uses generated Seatbelt profiles.
- Filesystem access is a static policy: reads outside the allowed regions and
  writes outside the workspace fail closed. Runtime filesystem denials are not
  converted into dynamic grants because Sandbox Runtime does not expose a
  trustworthy filesystem ask callback.
- Network access is denied by default. Each unmatched destination is sent to
  `pi-auto-review` as a concrete hostname and port. An approval applies only to
  that connection.
- Every Bash command and persistent subagent session owns a separate broker
  process and Sandbox Runtime manager. Concurrent workers therefore keep
  independent policy, proxy, approval, and cleanup lifecycles.
- Project and global Pi security configuration, the installed package, Git
  hooks, and other Sandbox Runtime mandatory paths remain write-protected.

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
`~/.pi/agent/pi-sandbox.json`:

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
- `pi-subagents`: let the external extension own orchestration. Main-agent and
  inherited Bash execution remains sandboxed, but the external worker process
  itself is not wrapped.
- `off`: protect Bash only.

The configuration parser rejects malformed JSON, unknown fields, and unknown
providers instead of silently weakening isolation.

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
```

The test suite covers real Linux Sandbox Runtime enforcement when its native
dependencies are installed, plus deterministic broker, network approval,
process cleanup, concurrency, and cross-platform orchestration tests.

## Upstream

Sandbox Runtime is an Apache-2.0 licensed research preview:
<https://github.com/anthropic-experimental/sandbox-runtime>.
