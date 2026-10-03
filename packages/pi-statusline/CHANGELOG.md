# Changelog

## Unreleased

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
