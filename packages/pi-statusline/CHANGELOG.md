# Changelog

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
