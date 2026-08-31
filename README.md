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
orchestration while `pi-sandbox` continues protecting Bash; whole-worker
isolation for external subagents is opt-in through the trusted
`externalWorkerIsolation: "enforce"` setting. Its default remains off. Do not
load another extension that also replaces Pi's Bash tool. See the package
READMEs for provider, platform, and trust-boundary details.

## Development and release verification

Run deterministic checks with `npm run check` and `npm test`. The external
provider runtime floor published by `pi-sandbox` is `pi-subagents 0.50.0+`; its
devDependency is pinned exactly to `0.61.0`, the version the suite and gate are
exercised against. The model gate uses `bg_wait` with `0.61.0+` and retains
`subagent_wait` for older compatible installations. Run
`npm run gate:external-isolation` to verify the external-worker-isolation
(`PI_SUBAGENT_PI_BINARY`) contract seam without any model credential. Before a
release, run `npm run gate:pi-subagents` with `PI_SUBAGENTS_GATE_MODEL` and its
normal Pi credential environment. It uses an isolated temporary agent directory
and prints `SKIP` (rather than pass) when the required model setup is absent.

A GitHub Actions workflow (`.github/workflows/compat-latest.yml`) runs the
deterministic `check` + test suite against the pinned dependency on every push
and against the **latest** published pi-subagents on a nightly schedule, so
drift surfaces as an early CI signal without a manual bump. An opt-in
`model-gate` job runs the end-to-end `gate:pi-subagents` against latest; it only
activates when `PI_SUBAGENTS_GATE_MODEL` and a matching model credential secret
are configured.

The gate waits for returned child results, with provider-latency budgets of 10
minutes for the direct child, 15 minutes for the multi-stage workflow, and 15
minutes for the async background-workflow completion payload. Set
`PI_SUBAGENTS_GATE_DIRECT_TIMEOUT_MS`,
`PI_SUBAGENTS_GATE_WORKFLOW_TIMEOUT_MS`, or
`PI_SUBAGENTS_GATE_ASYNC_TIMEOUT_MS` to positive millisecond values when a
dedicated test provider needs different bounds.
