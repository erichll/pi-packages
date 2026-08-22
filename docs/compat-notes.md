# Compatibility seams with `pi-subagents`

This document records every point at which `pi-packages` (specifically
`@erichll/pi-sandbox` and its dev/CI tooling) couples to the external
`pi-subagents` package. The goal is to keep each seam visible, versioned, and
verifiable on upgrade so that a `pi-subagents` release cannot silently break
the outer worker isolation boundary or the compatibility gates.

Current pinned baseline: `pi-subagents 0.54.0` (exact pin in
`packages/pi-sandbox` `devDependencies`, test/CI only). The `0.53.0 → 0.54.0`
upgrade was verified: every seam below was diffed between the two published
releases and found byte-identical (`pi-spawn.ts`, `api/external-runs.ts`,
`api/external-job-provider.ts`, and `package.json` `exports`), and
`gate:external-isolation` passes against the installed `0.54.0`.

## Seam registry

| Seam | Type | First-introduced | Current status | Verified by | Depends on |
| --- | --- | --- | --- | --- | --- |
| package root `exports["."]` | Public | `0.45.0` | compat gate loads entry | `import.meta.resolve` + model gate | `pi-subagents` root entry |
| `src/runs/shared/pi-spawn.ts` | Internal | `0.47.x` | probe single-point dependency | `gate:external-isolation` probe + upstream D1 | — |
| `PI_SUBAGENT_PI_BINARY` | Env contract | `0.47.x` | external isolation requires it | `gate:external-isolation` probe | — |
| `subagent_wait` / `details.completions` | Tool-result contract | `0.45.0` | model gate enforces | model-backed compat gate | `>=0.45.0` |
| `pi-subagents/external-runs` | Public, `0.50+` | `0.50.0` | active runtime seam (C1 landed) | unit + supervisor integration tests | C1 (FleetView) |

The seam registry lists `pi-subagents/external-runs` as a public `0.50+`
subpath; with C1 implemented it is now an active runtime seam.

## Detail

### 1. Package root `exports["."]`

- **First introduced:** `0.45.0` (the `subagent`/`subagent_wait` coexistence
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

### 4. `subagent_wait` / `details.completions` (tool-result contract)

- **First introduced:** `0.45.0`.
- **Local files:** `scripts/pi-subagents-compat-gate.ts` (async probes assert
  `subagent_wait` surfaces and that `details.completions` carries the completion
  payload).
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
3. On an isolated branch/commit, restore `0.49.0` (`pi-subagents` pinned) and
   re-run to determine whether the failure is upstream version drift. Do not
   clobber unrelated workspace changes.
