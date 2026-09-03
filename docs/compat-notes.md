# Compatibility seams with `pi-subagents`

This document records every point at which `pi-packages` (specifically
`@erichll/pi-sandbox` and its dev/CI tooling) couples to the external
`pi-subagents` package. The goal is to keep each seam visible, versioned, and
verifiable on upgrade so that a `pi-subagents` release cannot silently break
the outer worker isolation boundary or the compatibility gates.

Current pinned baseline: `pi-subagents 0.64.0` (exact pin in
`packages/pi-sandbox` `devDependencies`, test/CI only). The published 0.64.0
package leaves both the Linux/macOS `PI_SUBAGENT_PI_BINARY` spawn seam and
`api/external-runs.ts` byte-identical to 0.63.0. The active wait seam remains
`bg_wait` with completion data in `details.completions`; `subagent_wait` is a
historical name. The deterministic gate, type checks, package tests, launch
rule block probe, temp-file launcher test, standard Git worktree isolation
check, and sandboxed `watchdog_diff` execution verify the 0.64.0 development
baseline.

## Seam registry

| Seam | Type | First-introduced | Current status | Verified by | Depends on |
| --- | --- | --- | --- | --- | --- |
| package root `exports["."]` | Public | `0.45.0` | compat gate loads entry | `import.meta.resolve` + model gate | `pi-subagents` root entry |
| `src/runs/shared/pi-spawn.ts` | Internal | `0.47.x` | probe single-point dependency | `gate:external-isolation` probe + upstream D1 | — |
| `PI_SUBAGENT_PI_BINARY` | Env contract | `0.47.x` | external isolation requires it | `gate:external-isolation` probe | — |
| `bg_wait` / `details.completions` | Tool-result contract | `details.completions` in `0.45.0`; `bg_wait` in `0.61.0` | active; `subagent_wait` is legacy history only | model-backed compat gate | installed version |
| `pi-subagents/external-runs` | Public, `0.50+` | `0.50.0` | active runtime seam (C1 landed) | unit + supervisor integration tests | C1 (FleetView) |
| watchdog launch `action: "block"` | Launch-order contract | `0.64.0` | must stop before worker spawn | deterministic + model gates | `PI_SUBAGENT_PI_BINARY` |
| `watchdog_diff` Git reads | Sandbox capability | `0.64.0` | works in managed worktrees | real outer-launcher test | `.git` + `commondir` read policy |

The seam registry lists `pi-subagents/external-runs` as a public `0.50+`
subpath; with C1 implemented it is now an active runtime seam.

## Detail

### 1. Package root `exports["."]`

- **First introduced:** `0.45.0` (the `subagent` plus wait-tool coexistence
  contract).
- **Local files:** `scripts/pi-subagents-compat-gate.ts` resolves the gate
  entry via `import.meta.resolve("pi-subagents")` and asserts it lives inside
  the installed package root.
- **Failure impact:** the model gate cannot load the extension
  ("Extension path does not exist") or loads a differently-pinned copy.
- **Rollback:** revert the gate-edit commit; the gate falls back to the prior
  resolution strategy.

### 2. `src/runs/shared/pi-spawn.ts` (internal path)

- **First introduced:** with the first external-worker-isolation probe.
- **Local files:** `scripts/external-isolation-probe.mts` is the **only**
  consumer; it imports `getPiSpawnCommand` from
  `node_modules/pi-subagents/src/runs/shared/pi-spawn.ts` behind the
  `PI_SUBAGENTS_PI_SPAWN_INTERNAL_PATH` constant.
- **Failure impact:** probe fails to import; external-isolation gate reports
  `FAIL`, which blocks release acceptance.
- **Mitigation:** tracked upstream as D1 (request a public `./pi-spawn`
  subpath). After upstream publishes it, migrate to
  `import { getPiSpawnCommand } from "pi-subagents/pi-spawn"` and delete the
  last internal source-path import.
- **0.63.0 drift:** resolution began trying explicit/package-root candidates,
  validating the package name, and treating Windows JavaScript launchers and
  unresolved CLI paths specially.
- **0.64.0 drift:** none; the packaged `pi-spawn.ts` is byte-identical to
  0.63.0. The external-isolation probe still verifies the Linux/macOS override
  and verbatim-argument behavior.

### 3. `PI_SUBAGENT_PI_BINARY` (environment contract)

- **First introduced:** with external worker isolation.
- **Local files:** `packages/pi-sandbox/src/index.ts` injects it when
  `subagents.externalWorkerIsolation === "enforce"`;
  `scripts/external-isolation-probe.mts` verifies `getPiSpawnCommand` honors it.
- **Failure impact:** `enableExternalWorkerIsolation` no longer effectively
  wraps the worker process tree (isolation silently weakens). The probe catches
  this without a model credential.
- **Rollback:** if a provider release breaks this, keep `pi-sandbox` pinned to
  the previous `pi-subagents` version (revert upgrade commit, then re-run
  `npm ci`).

### 4. `bg_wait` / `details.completions` (tool-result contract)

- **History:** completion details landed with the old `subagent_wait` tool in
  `0.45.0`; `bg_wait` became primary in `0.61.0`, and 0.63.0 no longer
  registers the deprecated alias.
- **Local files:** `scripts/pi-subagents-compat-gate.ts` selects `bg_wait` for
  `0.61.0+` (using `subagent_wait` only when testing an older compatible
  release), then asserts that `details.completions` carries the completion
  payload.
- **Failure impact:** the model gate reports `FAIL` on the async-completion
  checks; release acceptance is blocked.
- **Rollback:** revert upgrade commit and re-run the gate against the prior
  version to determine whether the failure is an upstream drift.

### 5. `pi-subagents/external-runs` (public, `0.50+`) — C1 implemented

- **First introduced:** `0.50.0` (public subpath).
- **Local files:** `packages/pi-sandbox/src/external-runs-view.ts` mirrors
  supervised external workers; `packages/pi-sandbox/src/external-supervisor.ts`
  exposes `registered`/`unregistered` lifecycle callbacks;
  `packages/pi-sandbox/src/index.ts` wires them under
  `provider === "pi-subagents"` AND `externalWorkerIsolation === "enforce"`
  and cleans up on unregister, session shutdown, and supervisor replacement.
- **Reach:** only through an **optional peer dependency** (`pi-subagents
  >=0.50.0`, `peerDependenciesMeta.optional`) and a **dynamic import** — never
  a top-level static import.
- **Failure impact:** import/registry failure disables only FleetView
  registration (v1 is running-only and cleaned up on exit); it must not roll
  back or bypass established external worker isolation. Unit + supervisor
  integration tests verify `registered`/`unregistered` flow, duplicate and
  registry-full handling, import failure, and that snapshots carry no
  secrets/prompts.

### 6. Watchdog launch blocking (`0.64+`)

- **Local files:** `scripts/external-isolation-probe.mts` loads the upstream
  launch-rule evaluator and verifies `action: "block"` prevents spawn planning;
  `scripts/pi-subagents-compat-gate.ts` exercises the public subagent tool and
  requires zero child transcripts and zero forwarded child Bash approvals.
- **Failure impact:** a denied child could start an outer broker/manager process
  before the launch rule resolves, weakening policy and risking process leaks.
- **Rollback:** restore the prior exact pin until launch ordering is verified.

### 7. `watchdog_diff` Git reads (`0.64+`)

- **Local files:** `packages/pi-sandbox/test/external-supervisor.test.ts` runs
  the real upstream `watchdog_diff` implementation under the external worker
  launcher in a Git worktree and requires its tracked diff output.
- **Failure impact:** watchdog reviewers lose their intended read-only evidence
  inside enforced outer isolation even though ordinary child execution works.
- **Rollback:** keep 0.63.0 pinned or adjust only the narrow read policy proven
  necessary by a failing test; never make repository Git metadata writable.

## Upgrade procedure (applies whenever the pinned version changes)

1. Bump the exact `devDependency`; `npm install`; confirm installed version with
   `node -e "console.log(require('./node_modules/pi-subagents/package.json').version)"`.
2. Run `npm run check` and `npm test`.
3. Run `npm run gate:external-isolation` — must print `RESULT: PASS` with the
   correct `pi-subagents` and `pi-sandbox` versions.
4. Before a release, run `npm run gate:pi-subagents` with
   `PI_SUBAGENTS_GATE_MODEL` and matching credentials — must print a JSON result
   with `"status": "PASS"`.
5. `git diff --check`.

`SKIP` in any gate is **not** acceptance; a real `PASS` is required to close the
Phase.

## Failure triage

If an upgrade gate fails:

1. Preserve evidence with `PI_SUBAGENTS_GATE_KEEP_ARTIFACTS=1` (model gate).
2. Record the failure symptoms, versions, command, and key error here.
3. On an isolated branch or worktree, restore the immediately previous exact
   pin and re-run to determine whether the failure is upstream version drift.
   Do not clobber unrelated workspace changes.
