# @erichll/pi-auto-review

A model-backed boundary approval broker for the Pi coding agent.

`pi-auto-review` currently integrates with
`@gotgenes/pi-permission-system` as an authorizer-chain link. It also publishes
a small cross-extension broker service so an OS sandbox adapter can submit
filesystem and network boundary requests without creating a second approval
system.

The package name and model name are intentionally separate:

- npm package: `@erichll/pi-auto-review`
- Authorizer: `pi-auto-review`
- Default reviewer model: `codex-auto-review`

## Security model

The broker applies the following order:

1. Deterministic hard denies
2. Model review
3. Local terminal when the authorizer chain requires one
4. Exact, expiring, one-use grants for external sandbox adapters

Model approval cannot override `pi-permission-system`'s bounded-delegation
checkpoint. In version 24, an authorizer's `allow` on `path` or
`external_directory` is still downgraded to `defer`. In an interactive v24 TUI,
`autoConfirmBoundedAllows` can bind that exact model allow to the immediately
following local permission dialog and complete it as `auto_approved`. The
default enables this bridge only for `external_directory`; `path`, non-TUI
modes, UI mismatches, and reviewer defers still reach the human terminal.
Sandbox adapters should use concrete surfaces such as `filesystem-read`,
`filesystem-write`, and `network`.

The TUI bridge is request-ID-bound, expires after ten seconds, is consumed
once, and recognizes the v24 inline permission component before completing it.
Any event ordering, request, mode, component, or shared-UI wrapper mismatch
fails closed to the original dialog. This is a compatibility bridge around the
v24 delegation envelope, not permission-system authority-chain API.

The broker stops automatic review for a turn after three consecutive denials
or ten denials in the rolling last fifty reviews. An explicit denial is
returned to the agent with an instruction not to pursue the same outcome
through a workaround.

## User-facing feedback

In interactive UI sessions, the extension shows short operator feedback that is
separate from agent denial reasons:

1. Footer status while review is in flight:
   `auto-review: reviewing <surface> · <target>`
2. A toast when the decision lands:
   - allowed
   - allowed + auto-confirming the local dialog
   - allowed but local confirmation still required
   - deferred to you
   - denied
   - circuit-breaker stopped after repeated denials

These notices are best-effort UX only; missing or broken UI delivery never
changes the security decision.

## Exact human retry override

In interactive TUI mode, `/approve` shows up to ten recent model denials from
the current session. Selecting one authorizes exactly one unchanged retry and
automatically asks the agent to perform it. The authorization:

- is bound to the complete request hash, including cwd, command, requested and
  resolved paths, destination, tool input, and agent;
- expires after 60 seconds and is consumed once;
- is passed to the reviewer as a separate host-generated
  `trusted-user-override` evidence block;
- does not directly allow anything—the reviewer can still deny or defer; and
- is checked only after deterministic hard denies, so critical tenant and
  security-control policy cannot be overridden.

Changing any request field misses the override. An override that was consumed
cannot be issued again for the same request semantics in that session.

## Configure

Trusted configuration is resolved in this order:

1. Package defaults from the installed `src/config.json`
2. Optional user-global overlay at
   `~/.pi/agent/extensions/pi-auto-review/config.json`
3. Optional project tighten-only file at `.pi/pi-auto-review.json`

Prefer the user-global file for day-to-day overrides (same location style as
`pi-permission-system`). It may set any legal key, including `model` and
`autoConfirmBoundedAllows`. A partial file overlays the package defaults.

```json
// ~/.pi/agent/extensions/pi-auto-review/config.json
{
  "autoConfirmBoundedAllows": ["external_directory", "path"]
}
```

Package-shipped defaults live in `src/config.json`:

```json
{
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 45000,
  "maxTokens": 1600,
  "retries": 1,
  "maxUserTranscriptTokens": 1200,
  "maxToolTranscriptTokens": 1200,
  "maxRelevantResultTokens": 800,
  "failureMode": "deny",
  "grantTtlMs": 60000,
  "autoConfirmBoundedAllows": ["external_directory", "path"]
}
```

The configured provider must be registered in Pi and must support the
configured model. `failureMode: "deny"` is the fail-closed default;
`failureMode: "defer"` falls through to the normal human terminal.
Set `autoConfirmBoundedAllows` to `[]` to keep every bounded allow manual, or
include `"path"` as well to opt into the same TUI bridge for the cross-cutting
path surface.

Add the link to the permission-system configuration:

```json
{
  "authorizerChain": ["pi-auto-review"]
}
```

## Boundary broker service

The extension publishes a process-local service at:

```ts
Symbol.for("pi-auto-review:boundary-approval-broker")
```

Adapters should normally use the exported helper:

```ts
import {
  getBoundaryBroker,
  type BoundaryRequest,
} from "@erichll/pi-auto-review";

const request: BoundaryRequest = {
  id: "sandbox-runtime-query-id",
  source: "sandbox-runtime",
  surface: "network",
  operation: "connect",
  cwd: "/workspace/project",
  command: "npm install",
  destination: "registry.npmjs.org:443"
};

const service = getBoundaryBroker();
const decision = await service?.review(request, {
  sessionId: "pi-session-id",
  scopeKey: "pi-session-id:turn-id",
  issueGrant: true
});
```

When `decision.kind` is `allow`, an external sandbox adapter must consume the
returned grant before retrying:

```ts
if (
  decision?.kind === "allow" &&
  decision.grant &&
  service?.consumeGrant(request, "pi-session-id", decision.grant.token)
) {
  // Retry this exact operation once inside the OS sandbox.
}
```

Changing the command, path, destination, working directory, agent, or tool
call/input invalidates the grant. Grants expire after `grantTtlMs` and cannot
be reused.

## Relevant reviewer evidence

The reviewer always receives bounded user intent and assistant tool calls. It
may additionally receive only these bounded result classes:

- The exact result correlated by `toolCallId`.
- A read-only `stat`, `ls`, `find`, `test`, `readlink`, or `realpath` result for
  a pending deletion target.
- `git remote`, branch, status, revision, and remote configuration results for
  a pending Git push.
- The current structured Sandbox Runtime trap.

Unrelated tool results and assistant prose remain excluded. Selected results
have a separate `maxRelevantResultTokens` budget, common secret/token forms are
redacted, and markup characters are escaped before the evidence is sent to the
reviewer. Results remain explicitly labeled as untrusted and possibly
incomplete.

## Sandbox adapter status

The broker-facing contract is implemented, but this package does not intercept
OS sandbox events by itself. Adapters translate a concrete boundary into a
`BoundaryRequest` and must consume the exact grant before allowing the
operation.

This monorepo's `pi-sandbox` uses Anthropic Sandbox Runtime. Filesystem policy
is static and fails closed; unmatched public network destinations use the
broker for per-connection approval. Each Bash command or built-in subagent
session owns an independent Sandbox Runtime broker process. Adapters should use
the `./sandbox` export.

Do not implement the adapter by writing broad permanent rules to
`.pi/sandbox.json`.

## Trust boundary

The extension refuses to activate when its package directory is inside the
agent-writable workspace. Install production copies as a user-level npm
package, or as a Git package pinned to a reviewed tag or commit:

```bash
pi install npm:@erichll/pi-auto-review
```

Pi places user npm packages under `~/.pi/agent/npm/` and Git packages under
`~/.pi/agent/git/`, outside the project workspace. For local development only:

```bash
PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1 pi --approve
```

The trusted configuration (package defaults plus optional user-global overlay)
is copied and frozen at `session_start`. An optional workspace file at
`.pi/pi-auto-review.json` may only lower timeouts, token/evidence limits,
retries, and grant TTL, or set `failureMode` to `deny`. It may remove entries
from `autoConfirmBoundedAllows`, but cannot add a surface not enabled by the
trusted configuration. It cannot select a model, weaken fail-closed behavior,
or raise a trusted limit. Invalid user-global or project configuration disables
the reviewer for that session.

Writes to the installed reviewer package, the user-global reviewer config
directory (`~/.pi/agent/extensions/pi-auto-review/`), project security
configuration, global Pi security configuration, and the global audit directory
are deterministically denied.

## Real-model smoke test

For a controlled smoke test, disable unrelated extensions and explicitly load
only the model provider, broker, sandbox, and audit listener:

```bash
PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV=1 \
PI_AUTO_REVIEW_SMOKE_AUDIT_PATH=/tmp/pi-auto-review-smoke-audit.jsonl \
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  --no-builtin-tools --no-session --print \
  --extension /trusted/path/to/your-model-provider/extensions/index.ts \
  --extension ./packages/pi-auto-review/src/index.ts \
  --extension ./packages/pi-sandbox/src/index.ts \
  --extension ./scripts/real-model-smoke-audit.ts \
  --model provider/your-available-model \
  "Use bash once to write a fixed marker outside the workspace."
```

A successful boundary review emits `review_decision`, `grant_issued`, and
`grant_consumed` for the same request ID. `--no-builtin-tools` is important:
it ensures the `bash` implementation comes from `pi-sandbox` rather than
silently falling back to Pi's built-in Bash.
