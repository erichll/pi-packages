# @erichll/pi-statusline

A configurable footer for Pi 1.0 with Git status, session usage, themes, and live configuration preview. Uses Pi's native footer and leaves the editor intact.

```text
 Model(high) | ◉ [█░░░░░░░░░]11.9% | ▸ pi-packages | ⑂ main ● *2 ↑2
extension status text, when available
```

## Install

```sh
pi install npm:@erichll/pi-statusline
```

Requires Node.js >=22.19, Pi >=1.0.0, and optionally Git. The package has no
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
  "preset": "cometix",
  "icons": "unicode",
  "separator": "pipe",
  "pathMode": "basename",
  "modelDisplay": "name",
  "contextDisplay": "bar"
}
```

- Presets: `cometix` (default), `minimal`, `powerline`. Choosing a preset in the
  panel resets segment order and style overrides. Pi's current light/dark theme
  supplies semantic colors; Powerline backgrounds adapt to its appearance.
- Icons: `unicode` (default), `nerd` (requires a Nerd Font), `ascii`. ASCII mode
  replaces built-in decorative glyphs, not user-provided names or custom icons.
  Both graphical modes use `` for the model by default; this glyph requires a
  Nerd Font. A custom model icon still overrides the default.
- Separators: `pipe`, `dot`, `space`, `powerline`. ASCII mode uses plain separators.
- Paths: `basename`, `abbreviated`, `full` (home directory abbreviated as `~`).
- Model display: `name` (default, display name with full ID fallback) or `last`
  (the final non-empty `/`-separated component of the **model ID**, even when a
  display name is configured). For example, `provider/a/b/c/d` becomes `d`.
  Set `"modelDisplay": "last"` or select **Model display: last** in the panel.
  Switching presets preserves this preference; restoring defaults resets it.
- Context display: `bar` (default, `[██░░░░░░░░]20%`) or `text`
  (`12.7k/272k(4.7%)`). Choose **Context display: bar** in the panel or set
  `"contextDisplay": "bar"`. Switching presets preserves this preference.
  The ten-cell bar uses whole blocks to avoid gaps inside partial glyphs. Fill
  rounds to the nearest cell, with at least one filled cell for non-zero usage;
  the percentage retains the more precise value. ASCII mode uses `#` and `-`.
  Unknown usage shows `[??????????]?%`; values above 100% fill
  the bar completely and retain the reported percentage. Both modes use the
  existing context warning colors. Text mode includes token counts and capacity;
  bar mode shows progress and percentage.
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
| `input`, `output`, `tokens` | Cumulative input, output, or total tokens | Off |
| `cacheRead`, `cacheWrite` | Cumulative cache token counts | Off |
| `statuses` | Other extensions' `setStatus()` text, with terminal controls stripped | On |

The minimal preset enables directory, Git, context, and extension statuses.
See [examples/statusline.json](examples/statusline.json) for an explicit layout.
Unknown versions, duplicate segments, invalid colors and malformed JSON are
rejected with a notification; reload retains the last working configuration.
Removing the file restores defaults on reload. Saves use an atomic file replacement.

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
is truncated to fit. Reload, session replacement, disabling and shutdown
release timers and subscriptions. RPC, JSON and print mode do not install UI
components or start polling.

## Development and rollback

```sh
npm run check --workspace @erichll/pi-statusline
npm test --workspace @erichll/pi-statusline
# Optional: POSIX PTY integration, using an offline simulated model
npm run smoke --workspace @erichll/pi-statusline
```

Tests cover rendering and panel interactions, configuration persistence, session
usage/lifecycle, and real temporary Git repositories. To roll back a persistent
installation, disable this extension in `pi config`, re-enable the previous
footer and reload Pi. `/statusline off` restores the native footer, not another
extension's editor or widgets.

The initial implementation is independently written, with design references to
[pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer).

MIT licensed.
