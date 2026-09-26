# pi-sandbox subagent provider examples

Candidate configs for **manual copy**. Pi does not read this directory automatically.

## Background: why this is a three-way choice

With `subagents.provider` set to `builtin`, pi-sandbox registers its own tool named
`subagent` (`pi.registerTool({ name: "subagent", ... })` in `src/index.ts`). The
`pi-subagents` extension registers a tool with the same name. Once Pi's resource loader
detects the duplicate name across extensions, it fails to load the **entire** pi-subagents
extension:

```
Error: Failed to load extension ".../pi-subagents/index.js":
  Tool "subagent" conflicts with ".../@erichll/pi-sandbox/src/index.ts"
```

`provider` is therefore bound to "do we load the pi-subagents extension": if you load
pi-subagents, `builtin` is not an option.

## Files

| File | Copy to |
| --- | --- |
| `pi-sandbox.config.provider-builtin.json` | `~/.pi/agent/extensions/pi-sandbox/config.json` |
| `pi-sandbox.config.provider-off.json` | `~/.pi/agent/extensions/pi-sandbox/config.json` |
| `pi-sandbox.config.provider-pi-subagents.json` | `~/.pi/agent/extensions/pi-sandbox/config.json` |
| `pi-subagents.config.scheduled-runs-disabled.json` | `~/.pi/agent/extensions/subagent/config.json` (does not exist yet; create the directory) |

The three `pi-sandbox.config.provider-*.json` files differ only in `subagents.provider`
(plus the `protection` / `allowedNativeAgents` fields that `pi-subagents` requires). Pick one.

## Option A: `provider: "off"`

Copy the first file only. pi-sandbox sandboxes Bash, registers no `subagent` tool, and
pi-subagents provides the tool.

- Pros: full pi-subagents functionality, smallest change
- Cons: **no outer worker process isolation**. Subagent Bash is still sandboxed (the child
  process loads the pi-sandbox extension), but the subagent process itself is not in its
  own sandbox
- Prerequisite: the pi-subagents entry in `~/.pi/agent/settings.json` must no longer be
  excluded via `-index.js`

## Option B: `provider: "pi-subagents"`

Copy both files. pi-sandbox registers no tool and instead applies a capability ceiling to
pi-subagents child processes.

- Preconditions (any one missing fails closed and refuses to start):
  - `subagents.protection` must be `"native-background-tools"` (enforced by the config parser)
  - `subagents.allowedNativeAgents` must be non-empty and must contain **canonical** names
    (aliases are rejected by `resolveAgentName`)
  - Every listed agent must be: not `disabled`; `runner.type` either `pi` or unset; free of
    an explicit `extensions` override (ambient extensions are required); and free of
    `allowNestedSubagents: true`
  - The pi-subagents config must contain `"scheduledRuns": { "enabled": false }`
- Every child launch must explicitly set `async: true`
- Cons: child tools are fixed to `bash` / `read` / `grep` / `find` / `ls`. `write`, `edit`,
  MCP, and other extension tools are unavailable; workflowScript, nested subagents, resume,
  and scheduled runs are all disabled
- After changing the agent list, run `npm run gate:pi-subagents` to verify

Canonical names currently accepted in `allowedNativeAgents` (taken from the `name`
frontmatter of the installed package's `agents/*.md`): `worker`, `reviewer`, `scout`,
`researcher`, `delegate`, `oracle`, `evidence-auditor`.

The following names resolve to a canonical agent but are **rejected** by protected mode, so
do not put them in the allowlist:

| Name | Rejection reason |
| --- | --- |
| `claude-code` | `runner.type` is `external-cli`, not `pi` |
| `codex-exec` | same |
| `cursor-agent` | same |

`claude-code-writer` / `codex-exec-writer` / `cursor-agent-writer` carry the same external runner.

Also note that some agents declare their own `tools:` field (for example `researcher` grants
only `read` / `write` / `web_search`). Under protected mode the ceiling overrides it with the
fixed five tools.

## Option C: `provider: "builtin"`

Copy the first file. pi-sandbox registers its own `subagent` tool and sandboxes each complete
worker process tree.

- Pros: the only mode where the subagent **process itself** is sandboxed; every child `pi`
  process tree gets its own bubblewrap / Seatbelt namespace
- Cons: the `pi-subagents` extension cannot be loaded at all (see the background section).
  That means no named agents, no per-agent system prompts or `tools:` frontmatter, no
  workflowScript, no parallel fan-out, no scheduled runs. Each session is one undifferentiated
  worker running the same model with the parent's full active tool list
  (`pi.getActiveTools().filter((name) => name !== "subagent")`)
- Limits: concurrency 4, nesting depth 3 (enforced via the `PI_SANDBOX_SUBAGENT_DEPTH`
  environment variable)
- Prerequisite: keep the pi-subagents entry excluded in `~/.pi/agent/settings.json`
  (currently `-index.js` / `-index.ts`), and make sure no project-level settings file in any
  directory re-enables it

Keep `builtin` only if you want delegation *and* hard process isolation, and do not need
per-agent roles. If your use case is "send this to a reviewer with read-only tools", builtin
cannot express it.

## Option D: pi-subagents resources without the extension

Not a `provider` value, but worth knowing: pi-subagents' skills and prompt templates are
separate resources that register no `subagent` tool. They keep working under every provider
above, including `builtin` — you lose orchestration, not the prompt library.

## Project config overrides the global one

`./.pi/extensions/pi-sandbox/config.json` takes precedence over
`~/.pi/agent/extensions/pi-sandbox/config.json`. If the target directory has that file, update
it too or the global change has no effect. Project scope only allows scalar overrides
(`provider`, `hostIPC.mode`, `hostIPC.retryOnUnixSocketError`).
