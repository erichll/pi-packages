# Changelog

## 0.8.0 - 2026-10-18

### Added

- Add a skills row, enabled by default, between the tool row and the runtime
  row: the loaded skills used in the session, in first-use order
  (`󰗚  pdf-tools · docx +1`; `❖` in Unicode and `skills` in ASCII icon modes).
  It counts `/skill:name` invocations and model reads of a loaded skill's file,
  is read from session entries so it survives reloads and resuming, and is
  hidden until a skill is used. `runtime.skills` toggles it and
  `runtime.skillsMaxVisible` (1–8, default 4) sets how many names show before
  `+N`; narrow rows fold names, then show only the count.
- Show the skill directory for reads of a skill file on the tool row
  (`read pdf-tools/SKILL.md` instead of `read SKILL.md`).

### Changed

- Give the lower rows dim row icons aligned with the main row: each starts with
  a space, so its icon sits under the model icon, and two spaces set the icon
  off from the row contents (one in ASCII mode). The tool row leads with the
  tool total's icon (`󱁤`; `⚒` in Unicode and `tools` in ASCII icon modes) and
  the runtime row with a pulse (`󰐰  ● 5m 42s`; `∿` and `run`).
- Quiet the tool row like the runtime row: running tools (`◐ bash`) use the
  text color instead of warning and accent, and completed calls (`✓`) are dim
  instead of success. Only a tool running 30s or longer (its `◐` and timer turn
  warning) and failures (`✗`, error) stay colored.

## 0.7.0 - 2026-10-17

### Added

- Add a `toolTotal` segment on the runtime row, enabled by default: the number
  of tool calls recorded in the whole session (`󱁤 128`; `⚒` in Unicode and
  `tool:` in ASCII icon modes), between session age and tokens. Unlike the tool
  row, which counts the current run, it is read from session entries, so it
  survives reloads and resuming and covers every run. It is hidden at zero and
  is the first of these three segments to fold on narrow rows. Existing segment
  lists gain it before `tokens` unless they list it explicitly.

## 0.6.1 - 2026-10-16

### Changed

- Mute the runtime row so it no longer competes with the editor: the duration,
  run metrics, session age and tokens use Pi's muted color, and the running
  (`●`) and done (`✓`) symbols are muted too. Only problems stay colored: a
  failed run (`✗`), `awaiting input`, `no content`, `compacting…`, compaction
  failures and cache below 50%. Cache is no longer green from 80%. Explicit
  `session`/`tokens` segment colors still apply.
- Show run counts label first, like `avg` and `cache`: `turns 4` and
  `compactions 1` instead of `4 turns` and `1 compaction`.

## 0.6.0 - 2026-10-16

### Added

- Add a tool activity row between the main line and the runtime row, shown
  once the current run has used tools: `◐ bash npm test 12s · ✓ read ×5 ·
  ✗ bash ×1 · +2`. Up to two running tools show their target (shell command
  without `cd`/env prefixes, file name, search pattern or directory) and timer;
  same-name calls merge as `×N`. Completed (`✓`) and failed (`✗`) calls are
  counted per run and kept in the last-run summary.
- Count nested calls (`parentToolCallId`) but represent them by their parent
  while running. Calls ended by a user cancellation are not counted as failures.
- Add a `session` segment on the runtime row, enabled by default: the time
  since the session was created (`󰥔 2h 6m`; `◷` in Unicode and `ses:` in ASCII
  icon modes), to the minute and before session tokens. It is read once per
  session from Pi's session header, survives reloads and resuming, restarts with
  `/new` or a fork, and is hidden when the header time is missing or invalid.
  Existing segment lists gain it before `tokens` unless they list it explicitly.
- Add `runtime.toolsMaxVisible` (1–8, default 4) for completed tool kinds shown
  before `+N`, editable in the panel. Narrow rows fold kinds, then drop targets,
  then timers.
- Label quota windows from the reported length (`x-codex-*-window-minutes`
  headers and WebSocket `window_minutes`): `5h`, `1d`, `7d` or `30d` within 5%,
  otherwise exact (`1h30m`). Without a reported length a window stays unlabeled
  rather than guessed; a malformed length drops only the label.
- Add tool target, tool counting, window label, per-window color and session age
  tests, and extend the offline PTY smoke with the tool row, completed counts
  and session age.

### Changed

- Render quota as `5h ███░░░░░░░ 27% 4h8m · 7d ████░░░░░░ 44% 6d1h`: dim labels
  and `·` separators, muted countdowns without brackets, and each window colored
  by its own usage (accent, warning above 70%, error above 90%). An explicit
  segment `color` still applies to both. Unlabeled windows keep their countdown
  instead of their bar on narrow terminals.
- Restyle the runtime row and move it to the bottom of the footer. A run status
  symbol (`●` running, `✓` done, `✗` failed, `⊘` cancelled) precedes the
  duration in place of `Elapsed`; labels are dim and lowercase
  (`avg 39 tok/s · cache 100% · 11 turns · 1 compaction`); cache is green from
  80% and warning below 50%. ASCII mode uses `*`, `ok`, `x` and `-`.
- Keep average speed and cache visible while tools run or input is awaited.
  `awaiting input`, `no content` and `compacting…` follow the duration in the
  warning color; `no content` was previously muted.
- Move the session token total (`tokens`) from the main line to the runtime row,
  before other extensions' statuses. It keeps its icon, color and enablement.
- `runtime.tools` now controls the tool row. Existing configurations with
  `"tools": true` show it after upgrading; set it to `false` to hide it.

### Removed

- Remove `Tool X 3s` / `Tools N active` from the runtime row; the tool row
  replaces them.

## 0.5.0 - 2026-10-14

### Added

- Add Codex subscription Usage (`quota`) with primary/secondary progress bars,
  used percentages and live reset countdowns. Passively observe SSE response
  headers and native WebSocket `codex.rate_limits` events on Pi 1.2+, with no
  extra requests or credential lookups. Existing statusline features retain
  Pi 1.1 support.
- Enable quota after context by default, including in existing configurations
  that omit it. Explicit quota settings preserve enablement and order;
  the panel supports disabling, reordering and styling it.
- Use accent/warning/error colors at the 70%/90% usage thresholds, with ASCII
  support and narrow-screen fallback to bars, percentages or hiding the segment.
- Hide missing, malformed and expired quota windows; replace snapshots rather
  than merge credentials' data. Clear old samples on model/provider/API/endpoint
  changes, reload, new session, footer disable and no-quota WebSocket streams.
- Add quota parser, lifecycle, countdown and rendering tests, plus offline
  regular/fullscreen PTY coverage for both headers and WebSocket events.

### Changed

- Simplify context bars from `[██░░░░░░░░]20%` to `██░░░░░░░░ 20%`.
- Condense the README around installation, configuration, quota setup and
  statistics; link to the complete example configuration instead of duplicating it.

## 0.4.1 - 2026-10-13

- Upgrade the Pi 1.2.0 development baseline (`pi-ai`, `pi-coding-agent`,
  `pi-tui`) and Node types (`^26.6.5`); TypeScript (`^7.0.2`) already matches
  the latest stable version.
- Keep peer floors at `>=1.1.0`: verified against Pi 1.2.0 (type check clean,
  all 59 tests pass) while 1.1.0 remains supported.

## 0.4.0 - 2026-10-08

- Upgrade Pi AI, coding-agent, and TUI development dependencies to `^1.1.0`
  and replace wildcard peers with the same tested baseline. Node types
  (`^26.6.4`) and TypeScript (`^7.0.2`) already match the latest stable versions.

## 0.3.0 - 2026-10-04

- Add `spacing` (0–3 blank lines, default 1) to control the gap between the input box and the statusline; configurable in the panel and persisted in the configuration.
- Hide the `Compactions` count while it is zero, including the first active compaction.

## 0.2.0 - 2026-10-04

- Use the same muted color for No content and Avg; default modelDisplay to name while preserving explicit last preferences.
- Remove Minimal and the preset selector; support only Powerline, without migration for retired preset values.
- Make Powerline the default with Nerd icons, Powerline separators, model display name, basename paths, context bar and total tokens enabled; ship the layout as the example configuration.
- Omit the startup/idle footer label and its separator.
- Lead the second row with one Elapsed duration; reuse explicit `tps` Elapsed display text without an extra Running/Done duration.
- Track monotonic runs through retries, tools, UI waits and compaction until `agent_settled`; retain the final run's footer summary.
- Add ID-based concurrent/nested tool activity, UI-wait precedence and configurable non-empty-content observation warnings (ten seconds by default).
- Add assistant-only per-run usage, whole-run average output rate and cache-read ratio without changing cumulative session totals.
- Add compaction activity/result and whole-session successful compaction counts.
- Remove the Until compact metric, its runtime setting and compaction-capacity calculation.
- Add runtime settings with draft preview, numeric validation and backward-compatible version-1 partial configuration.
- Keep statistics limited to existing provider statuses and Pi public events/usage; do not expose unsupported request-level metrics or require provider changes. Ignore and drop obsolete experimental request/integration configuration on save.
- Remove the read-only run details command/panel; retain footer statistics, configuration and live preview.
- Expand lifecycle/configuration/render tests and isolated offline PTY smoke across regular/fullscreen layouts.

## 0.1.0 - 2026-10-03

- Make bar mode the default and use whole cells to avoid visual gaps from partial glyphs; non-zero usage fills at least one cell.
- Place context immediately after the model in preset layouts and add a configurable context progress bar (`contextDisplay: "bar"`).
- Hide the cost segment by default in every preset; it can still be enabled in settings.
- Use an independent rainbow palette so themes with repeated semantic colors still display distinct thinking-level hues.
- Use `` as the default model glyph and append the thinking level in parentheses, coloring the entire `(level)` with per-level colors and rainbow high/xhigh/max.
- Move thinking controls into the model settings; retain existing `thinking` enablement/color settings for compatibility.
- Move configuration to `extensions/pi-statusline/config.json` under Pi's agent directory.
- Compact context usage to `used/capacity(percent%)`, removing separator padding.
- Add `modelDisplay: "last"` to show only the final component of a slash-separated model ID, configurable in the preview panel.
- Add a native Pi footer with configurable presets.
- Add configurable segments, Unicode/Nerd Font/ASCII icons, colors and path display.
- Add a keyboard-driven configuration panel using the same renderer as the live footer.
- Add asynchronous Git state, native session usage accounting and extension-status display.
- Handle narrow terminals, session replacement, compaction and non-interactive modes.
