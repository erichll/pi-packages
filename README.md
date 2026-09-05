# pi-packages

An npm workspaces monorepo for Pi security extensions:

| Package | Purpose |
| --- | --- |
| [`pi-auto-review`](packages/pi-auto-review) | Model-backed boundary approval broker and permission-system authorizer |
| [`pi-sandbox`](packages/pi-sandbox) | Anthropic Sandbox Runtime-backed Bash sandbox, with an optional process-backed subagent provider |

The layout follows the package-per-directory structure used by
[`gotgenes/pi-packages`](https://github.com/gotgenes/pi-packages). The
extensions are published to npm as `@erichll/pi-auto-review` and
`@erichll/pi-sandbox`; the matching unscoped names are owned by unrelated
projects. The repository can also be installed as one Git-backed Pi package.

## Platform status

- Linux: bubblewrap filesystem/network isolation and end-to-end sandbox paths
  are tested.
- macOS x64/arm64: Sandbox Runtime uses native Seatbelt profiles; deterministic
  broker orchestration is covered on Linux, while native smoke coverage is
  still pending.
- Windows: not supported.

## Requirements

- Node.js 22.19 or newer
- npm 11
- Pi 0.82.1 or newer
- `@gotgenes/pi-permission-system` 28.x or 29.x
- Linux: `bubblewrap`, `socat`, and `ripgrep`

## Development

```bash
npm install
npm run check
npm test
```

Start Pi from this repository root to load the local package through
`.pi/settings.json`. Local source is agent-writable, so development runs must
explicitly opt in with
`PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1 pi --approve`.

## Installation

Install both public npm packages at user scope. Load `pi-auto-review` first so
its broker service is available when `pi-sandbox` starts:

```bash
pi install npm:@erichll/pi-auto-review
pi install npm:@erichll/pi-sandbox
```

Alternatively, install a reviewed, immutable repository tag or commit as one
Git-backed package:

```bash
pi install git:github.com/erichll/pi-packages@v0.1.1
```

Do not pass `-l` with either installation method: project-local installation
would put the security controls back under the agent-writable workspace. Pi
installs user npm packages under `~/.pi/agent/npm/` and Git packages under
`~/.pi/agent/git/`. The packaged sandbox denies writes to its installed package
root and global Pi security configuration.

Production runs must not set `PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV`; that escape
hatch is only for loading this repository directly during development.

For a private repository, use the SSH form and make sure the host has a GitHub
SSH key with read access:

```bash
pi install git:git@github.com:erichll/pi-packages@v0.1.1
```

Enable the authorizer in the permission-system configuration:

```json
{
  "authorizerChain": ["pi-auto-review"],
  "permission": {
    "bash_escalated": "ask",
    "external_directory": "ask"
  }
}
```

`pi-auto-review` publishes a cross-extension broker service. The local
`pi-sandbox` package consumes that service, owns Bash execution, and routes
network connections through Sandbox Runtime's reviewed proxy. Its default
`builtin` provider also owns process-backed subagent execution, including
persistent background RPC sessions, follow-up, and nested handoff. Set the
trusted global provider to `pi-subagents` to let that extension own
orchestration under the required 0.65.0 native-background protection mode.
That mode validates a canonical agent whitelist and restricts children to
`bash`, `read`, `grep`, `find`, and `ls`; writes go through sandboxed Bash. It
is not whole-worker process isolation. Keep the default `builtin` provider for
that guarantee. Do not load another extension that also replaces Pi's Bash
tool. See the package READMEs for provider, platform, and trust-boundary details.

## Development and release verification

Run deterministic checks with `npm run check` and `npm test`. The external
provider peer and dev dependencies are both pinned exactly to `pi-subagents
0.65.0`. The compatibility gate verifies package layout, discovery, ceiling
registration, launch guards, and child acknowledgement. Its model portion uses
only already-exported credentials and prints `SKIP` rather than claiming
success when model setup is absent.

A GitHub Actions workflow (`.github/workflows/compat-latest.yml`) runs the
deterministic `check` + test suite against the pinned dependency on every push
and nightly. Newer upstream releases must be audited and deliberately adopted;
they are expected to fail closed until then. The optional model job activates
only when `PI_SUBAGENTS_GATE_MODEL` and a matching credential secret are
configured.
