# @erichll/pi-statusline

A configurable footer for Pi 1.1 with Git status, session usage, runtime/tool activity, themes, and live configuration preview. Uses Pi's native footer and leaves the editor intact.

```text
  Example model(high)  󰆼 [█░░░░░░░░░]11.9%  󰉋 pi-packages   main ● *2 ↑2  󰊄 49.4k
Elapsed 5m 42s · Avg 45 tok/s · Cache 86% · Turns 3 · Compactions 1
```

## Install

```sh
pi install npm:@erichll/pi-statusline
```

Requires Node.js >=22.19, Pi >=1.1.0, a Nerd Font for the default Powerline layout,
and optionally Git. Switch icons/separators in the panel for a font-independent
layout. The package has no
other runtime dependencies and makes no network requests or credential lookups.
Only one extension should own Pi's footer, so disable any other footer
extension in `pi config` before enabling this one.

## Local use

From this repository, try the extension for one invocation:

```sh
npm install
pi --no-extensions --extension ./packages/pi-statusline/src/index.ts
```

`--no-extensions` disables other auto-discovered extensions for this invocation.
To use your other extensions, disable `pi-powerline-footer` in `pi config`
before starting Pi with `--extension ./packages/pi-statusline/src/index.ts`.
Only one extension should own the footer. The previous package can remain
installed for rollback. Loading this repository as a whole also discovers the
security extensions; use the statusline entrypoint to try it on its own.

This checkout is for development only. For a persistent install use the
published package, `npm:@erichll/pi-statusline`.

## Commands

| Command | Behavior |
| --- | --- |
| `/statusline` | Open configuration and live preview |
| `/statusline on` | Enable for this session |
| `/statusline off` | Restore Pi's native footer for this session |
| `/statusline reload` | Reload saved configuration, including startup enablement |

The panel supports arrow navigation, Space to toggle a segment, Alt+Up/Down to
reorder it, and Enter to edit its properties. Choose **Save and apply globally**
to persist the draft. Esc backs out of a property editor or cancels the panel.
**Runtime options** edits the same draft; Space toggles booleans and Enter edits
the no-content threshold.
**Restore defaults in preview** changes only the draft until saved.
Preview uses the real footer renderer and current session data, or clearly
labelled example data for an empty session. A save error leaves the active
configuration unchanged and keeps the panel open.

## Configuration

Settings live in `extensions/pi-statusline/config.json` under Pi's agent directory,
normally `~/.pi/agent/extensions/pi-statusline/config.json`;
`PI_CODING_AGENT_DIR` is respected. The extension
does not write Pi's general `settings.json`. Configuration is global, with no
project override or file watcher. After manual changes use `/statusline reload`.
The configuration directory is created automatically when saving from the panel.
When upgrading from the previous `~/.pi/agent/statusline.json` location, move the
existing file to the new path before running `/reload`; the old path is no longer read.

```json
{
  "version": 1,
  "enabled": true,
  "preset": "powerline",
  "icons": "nerd",
  "separator": "powerline",
  "pathMode": "basename",
  "modelDisplay": "name",
  "contextDisplay": "bar",
  "spacing": 1,
  "segments": [
    {
      "id": "model",
      "enabled": true
    },
    {
      "id": "thinking",
      "enabled": true
    },
    {
      "id": "context",
      "enabled": true
    },
    {
      "id": "directory",
      "enabled": true
    },
    {
      "id": "git",
      "enabled": true
    },
    {
      "id": "cost",
      "enabled": false
    },
    {
      "id": "input",
      "enabled": false
    },
    {
      "id": "output",
      "enabled": false
    },
    {
      "id": "tokens",
      "enabled": true
    },
    {
      "id": "cacheRead",
      "enabled": false
    },
    {
      "id": "cacheWrite",
      "enabled": false
    },
    {
      "id": "statuses",
      "enabled": true
    }
  ],
  "runtime": {
    "enabled": true,
    "status": true,
    "tools": true,
    "noContent": true,
    "noContentSeconds": 10,
    "avg": true,
    "cache": true,
    "counts": true,
    "retainSummary": true
  }
}
```

- Layout: `powerline` is the only preset; there is no preset selector.
  Customize segments and styles directly, or restore defaults in preview.
  Pi's current light/dark theme supplies semantic colors; Powerline backgrounds
  adapt to its appearance.
- Icons: `nerd` (default; requires a Nerd Font), `unicode`, `ascii`. ASCII mode
  replaces built-in decorative glyphs, not user-provided names or custom icons.
  Both graphical modes use `` for the model by default; this glyph requires a
  Nerd Font. A custom model icon still overrides the default.
- Separators: `powerline` (default), `pipe`, `dot`, `space`. ASCII mode uses plain separators.
- Paths: `basename`, `abbreviated`, `full` (home directory abbreviated as `~`).
- Model display: `name` (default) uses the display name with full ID fallback.
  Choose `last` for the final non-empty `/`-separated component of the **model ID**,
  even when a display name is configured. For example, `provider/a/b/c/d` becomes `d`.
  Restoring defaults resets this preference to `name`.
- Context display: `bar` (default, `[██░░░░░░░░]20%`) or `text`
  (`12.7k/272k(4.7%)`). Choose **Context display: bar** in the panel or set
  `"contextDisplay": "bar"`.
  The ten-cell bar uses whole blocks to avoid gaps inside partial glyphs. Fill
  rounds to the nearest cell, with at least one filled cell for non-zero usage;
  the percentage retains the more precise value. ASCII mode uses `#` and `-`.
  Unknown usage shows `[??????????]?%`; values above 100% fill
  the bar completely and retain the reported percentage. Both modes use the
  existing context warning colors. Text mode includes token counts and capacity;
  bar mode shows progress and percentage.
- Spacing: `1` (default), `0`, `2` or `3` blank lines above the statusline.
  Pi renders the footer directly under the editor, so this is the only supported
  way to add breathing room between the input box and the statusline; the editor's
  own bottom border cannot be removed. Choose **Spacing above statusline** in the
  panel or set `"spacing": 0` for a flush footer.
- `segments`: optional ordered array of `{ id, enabled, icon?, color?, iconColor?, background? }`.
  An explicit list is authoritative: omitted segments are disabled but remain
  available in the panel. The `statuses` segment always occupies the second row.
  Preset layouts place context immediately after the model, before directory
  and Git. Explicit saved segment order is respected and can be changed in the panel.
- Thinking is appended to the model as `(level)`, with no separate icon or
  separator. In the panel, edit **model → Thinking level / Thinking color**.
  The existing `thinking` configuration entry controls suffix enablement and an
  optional color override; its position, icon and background are ignored. It
  does not render on its own when the model is hidden or non-reasoning.
  By default, `off`, `minimal`, `low`, and `medium` use their respective Pi theme
  colors; `high`, `xhigh`, and `max` use a fixed violet/pink/orange/yellow/green/cyan/blue
  palette independent of the Pi theme, distributed across the available characters.
  The color or rainbow covers the entire `(level)`, including parentheses, and
  the model's background covers the whole item.
- Icon `""` hides a glyph. In the panel, enter `:default` to restore its default.
  Color fields accept `#RRGGBB` or `text`, `accent`, `muted`, `dim`, `success`,
  `warning`, `error`, `border`, `borderAccent`, `borderMuted`, and Pi's
  `thinkingOff/Minimal/Low/Medium/High/Xhigh/Max` tokens. Empty color input in the
  panel restores the default. Explicit colors override automatic warning colors.

Available segments:

| ID | Data | Default |
| --- | --- | --- |
| `model` | Display name/full ID, or final ID component via `modelDisplay` | On |
| `thinking` | Controls the colored `(level)` suffix inside the model item | On |
| `context` | Text usage/capacity or a progress bar, followed by percentage | On |
| `directory` | Current working directory | On |
| `git` | Branch, clean/dirty/conflict, staged `+`, unstaged `*`, untracked `?`, ahead/behind | On |
| `cost` | Pi-recorded cumulative USD cost; enable in the panel when wanted | Off |
| `tokens` | Cumulative total tokens | On |
| `input`, `output` | Cumulative input or output tokens | Off |
| `cacheRead`, `cacheWrite` | Cumulative cache token counts | Off |
| `statuses` | Other extensions' `setStatus()` text on the runtime row, with terminal controls stripped | On |

The default Powerline preset enables model/thinking, context, directory, Git, total
tokens and extension statuses. Cost, input/output and cache token counters stay off.
See [examples/statusline.json](examples/statusline.json) for an explicit layout.
Unknown presets or versions, duplicate segments, invalid colors and malformed JSON are
rejected with a notification; reload retains the last working configuration.
Removing the file restores defaults on reload. Saves use an atomic file replacement.
Obsolete `runtime.untilCompact`, `providerMetrics` and `integrations` keys are
ignored and dropped on the next save; they do not require a configuration migration.

## Runtime row and compaction

Runtime metrics use Pi's public events and reported usage, without modifying the
provider. `Elapsed`
leads the second row; no additional `Running 342s` or `Done 342s` duration is
shown. A run starts at the first `agent_start` and ends at `agent_settled`, not
`agent_end`. Retries, tools, UI waits and compaction do not reset its monotonic
clock. `retainSummary` keeps the last run's footer summary until the next run
(disable it to hide the run summary at settlement). The idle
footer has no Idle label or leading separator.

- `Turns` counts Pi `turn_start` events, not upstream requests. Internal retries
  may make more than one request in a turn; no request count is inferred from
  turn events. Compaction does not increase the model-turn count.
- Tool activity is keyed by tool-call ID, including concurrent/nested calls and
  updates. It shows `Tool bash 26s` or `Tools 2 active`; tools cannot decide the
  model run's outcome. Pi UI prompts take precedence with `Awaiting input`.
- `No content 10s` means **no non-empty text, reasoning or tool-call delta has
  been observed** for ten seconds. It uses the same muted color as Avg.
  It is not a server timeout or request phase.
  Tools, compaction and UI waits suppress it. The integer threshold accepts
  1–3600 seconds. Empty deltas and usage-only updates do not reset it.
- Per-run usage includes only actual assistant messages. Streaming counters are
  replaced, not repeatedly added. `Avg = output tokens / total run seconds`,
  including tools, UI waits, retries and compaction; it is not inference speed.
  `Cache = cacheRead / (input + cacheRead + cacheWrite)`. Missing usage/invalid
  denominators are unavailable, not made-up zeroes. A genuinely reported zero
  remains zero. These values never replace cumulative session totals.
- `Compacting… 4s` suppresses rate/cache noise while
  compaction is active. Success restores the base row; failure/cancellation can
  show `Compaction failed` / `Compaction cancelled` while no model run is active,
  until subsequent activity.
- `Compactions` counts unique successful entries across the **whole session file**,
  including other branches, not merely the selected tree path. It is hidden
  while the count is zero, including during the first active compaction.
`runtime.enabled: false` hides the statusline's runtime metrics. Individual
options hide their corresponding items; `status` controls the local Elapsed
and compaction-result labels. The `statuses` segment independently controls other
extensions' text. If its `tps` entry is precisely a plain `Elapsed …` duration,
that display text is moved to the front and replaces the local Elapsed item.
All other statuses remain opaque text: they are never parsed into counters or
provider metrics. The provider's Elapsed may use its own pause
semantics; Avg always uses the independent monotonic run clock.

Runtime summaries are in-memory since extension load; reload/new session resets
them, unlike persisted usage/compaction totals.

## Existing provider statuses

The CLIProxyAPI provider already publishes an Elapsed footer status through
`setStatus("tps", ...)` and a TPS/token-summary notification at settlement. The
statusline can reuse the explicit Elapsed text; it does not parse the notification.
Its own Avg and Cache come from Pi-reported assistant usage and the local run clock.

No provider changes, adapter handshake or private network instrumentation are
required. Request counts, first-text/reasoning request latency, per-request duration,
transport reporting and retry associations are not exposed by this package. The
provider may implement transports/retries internally without exposing these metrics.

## Statistics and refresh behavior

Context comes from Pi's `getContextUsage()`. It is distinct from cumulative
token consumption. Unknown values, including immediately after compaction, show
`?` until Pi can provide an estimate. Yellow begins above 70%, red above 90%.
Pi 1.0 bases context estimates on persisted messages; in-flight usage updates
the cumulative token/cost segments while context refreshes after persistence.

Session totals include all usage already recorded in the current session file:
assistant messages, explicit usage entries, tool-result usage, compaction and
branch summaries, including pre-compaction and abandoned-branch consumption.
Streaming responses are provisional and counted once when persisted. The total
token segment sums input, output, cache-read and cache-write, matching Pi's
native session totals. Costs are **Pi-reported values, not provider invoices**;
zero means no cost recorded by Pi. No subscription-quota API or child-session
log is queried, and private `pi-subagents` result details are not parsed.

Git queries run asynchronously every two seconds and after tool/branch changes,
with a one-second timeout and optional index locks disabled. No repository hides
the segment; failures show `?`, never a false clean state. Large output above
8 MiB also falls back to unknown. Worktrees, detached HEAD, unborn branches and
filenames containing newlines are supported. Disabling the Git segment stops
its polling.

Rendering performs no file reads, Git queries or full-session scans. Streaming
refresh requests are coalesced to 100 ms. Narrow terminals shorten model/path
labels, then hide cost, cache/token counters, the thinking suffix, Git and directory in
that order, retaining model/context where possible. The secondary status row
drops extension text and cache/rate first, preserving
leading Elapsed and compaction status where possible, then truncates by terminal
cell width. Reload, session replacement, disabling and shutdown
release timers and subscriptions. RPC, JSON and print mode do not install UI
components or start polling.

## Development and rollback

```sh
npm run check --workspace @erichll/pi-statusline
npm test --workspace @erichll/pi-statusline
# Optional: POSIX PTY integration, using an offline simulated model
npm run smoke --workspace @erichll/pi-statusline
```

Tests cover rendering and panel interactions, configuration persistence, runtime
and extension-event wiring, compaction, session usage and real temporary Git
repositories. The POSIX PTY smoke runs **regular and fullscreen**, with isolated
agent/project directories and an entirely offline provider. It covers streaming, nested tools/UI waits,
no-content/cancellation, failed/successful compaction, model/theme changes,
40-column layout, draft cancel/save, off/on, reload and new session. It writes
`/tmp/pi-statusline-pty-<layout>.log` for diagnosis. To roll back a persistent
installation, disable this extension in `pi config`, re-enable the previous
footer and reload Pi. `/statusline off` restores the native footer, not another
extension's editor or widgets.

The initial implementation is independently written, with design references to
[pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer).

MIT licensed.
