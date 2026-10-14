# @erichll/pi-statusline

A configurable native Pi footer with Git status, session usage, runtime/tool
activity and live configuration preview. Leaves the editor intact.

```text
  Example model(high)  󰆼 █░░░░░░░░░ 11.9%  󰉋 pi-packages   main ● *2 ↑2  󰊄 49.4k
Elapsed 5m 42s · Avg 45 tok/s · Cache 86% · Turns 3 · Compactions 1
```

## Install

```sh
pi install npm:@erichll/pi-statusline
```

Requires Node.js >=22.19 and Pi >=1.1.0; subscription Usage requires Pi >=1.2.0.
Git is optional. The default Powerline layout requires a Nerd Font; choose
ASCII icons and plain separators for a font-independent layout.
Disable other footer extensions in `pi config`: only one should own the footer.
No extra network requests or credential lookups are made.

## Commands

| Command | Behavior |
| --- | --- |
| `/statusline` | Open configuration and live preview |
| `/statusline on` | Enable for this session |
| `/statusline off` | Restore Pi's native footer for this session |
| `/statusline reload` | Reload saved configuration |

In the panel: arrows navigate, Space toggles, Alt+Up/Down reorders segments,
Enter edits, and Esc backs out or cancels. **Save and apply globally** persists
changes; **Restore defaults in preview** only changes the draft until saved.
Thinking settings are under **model**; runtime settings are under **Runtime options**.

## Configuration

Settings are global, stored at
`~/.pi/agent/extensions/pi-statusline/config.json` (`PI_CODING_AGENT_DIR` is
respected). After manual edits, run `/statusline reload`; after source edits,
run Pi's `/reload` instead. The old `~/.pi/agent/statusline.json` path is no
longer read—move an existing file to the new location when upgrading.

Use the panel or start with a partial configuration:

```json
{
  "icons": "ascii",
  "separator": "pipe",
  "modelDisplay": "last",
  "contextDisplay": "text",
  "spacing": 0
}
```

See [examples/statusline.json](examples/statusline.json) for the complete defaults.

| Setting | Values (default first) |
| --- | --- |
| `enabled` | `true`, `false` (startup enablement) |
| `preset` | `powerline` only; colors adapt to Pi's light/dark theme |
| `icons` | `nerd`, `unicode`, `ascii` |
| `separator` | `powerline`, `pipe`, `dot`, `space` |
| `pathMode` | `basename`, `abbreviated`, `full` |
| `modelDisplay` | `name` (display name/ID), `last` (final model ID component) |
| `contextDisplay` | `bar` (`██░░░░░░░░ 20%`), `text` (`12.7k/272k(4.7%)`) |
| `spacing` | `1`, `0`, `2`, `3` blank lines above the footer |

Available segments:

| ID | Data | Default |
| --- | --- | --- |
| `model`, `thinking` | Model and colored `(level)` suffix | On |
| `context` | Current context usage | On |
| `quota` | Subscription Usage and reset countdowns; hidden without data | On |
| `directory` | Current directory | On |
| `git` | Branch, dirty/conflict state, staged/unstaged/untracked counts, ahead/behind | On |
| `tokens` | Cumulative session tokens | On |
| `cost` | Pi-recorded cumulative USD cost | Off |
| `input`, `output`, `cacheRead`, `cacheWrite` | Individual session token counters | Off |
| `statuses` | Other extensions' text on the second row | On |

`segments` is an ordered array of
`{ id, enabled, icon?, color?, iconColor?, background? }`. Omitted segments are
disabled, **except `quota`**: old configurations automatically gain it after
`context` (or at the end if context is absent). To keep it off, include
`{ "id": "quota", "enabled": false }`.

Colors accept `#RRGGBB` or supported Pi theme tokens such as `accent`, `muted`,
`success`, `warning` and `error`; explicit colors override automatic thresholds.
An empty icon hides it; enter `:default` in the panel to restore its default.
The `thinking` entry controls the model suffix, not a standalone segment.

Invalid configurations retain the last working settings and show a warning.
Removing the file restores defaults on reload; panel saves are atomic.

## Subscription Usage (Pi 1.2+)

Codex quota appears after context when valid data is available:

```text
󰆼 █░░░░░░░░░ 4.6%  󰦖 ████░░░░░░ 40%[3h3m] | ██░░░░░░░░ 21%[4d9h]
```

Bars show **used** percentages for the primary and secondary windows (usually
5 hours and 7 days), with live reset countdowns. The default color is Pi's
accent, changing to warning above 70% and error above 90%. Narrow terminals
omit countdowns, then bars, then the segment rather than truncate a window.

Data is observed passively through Pi's provider events:

- **SSE:** `x-codex-{primary,secondary}-{used-percent,reset-at}` response headers.
  CLIProxyAPI needs `requests.passthrough-headers: true`.
- **WebSocket:** native `codex.rate_limits` events with numeric `used_percent`
  and `reset_at` in `rate_limits.primary` / `secondary`. Other named metered
  buckets are ignored. The proxy must forward these events.

For CLIProxyAPI v8.0.28, each eligible Codex credential needs `websockets: true`
for the **proxy-to-upstream** WebSocket leg. A downstream WebSocket alone is
not enough: upstream SSE headers do not become quota frames. This setting is
separate from `ws-auth` and Pi's transport setting.

Missing, malformed or expired windows are hidden; a reported 0% remains visible.
Each response/event replaces the snapshot without merging credentials' windows.
Model/provider/API/endpoint changes, reload, new session and footer disable clear
old data. This is the responding upstream's quota, **not a proxy-pool aggregate**
or RPM/TPM rate limit.

## Statistics

- Context is Pi's current estimate, not cumulative consumption; unknown values
  show `?`. Session totals include recorded usage across the whole session file,
  including compaction and abandoned branches. Cost is Pi-reported, not an invoice.
- `Elapsed` spans retries, tools, UI waits and compaction. `Avg` is assistant
  output tokens / total run seconds, **not inference speed**;
  `Cache` is cache-read / (input + cache-read + cache-write). `Turns` counts Pi
  turns, not upstream requests; `Compactions` counts successful session entries.
- Tool activity and `Awaiting input` appear while active. `No content 10s`
  means no non-empty text, reasoning or tool-call delta was observed; it is not
  a server timeout and is suppressed during tools, UI waits and compaction.

All runtime options default to enabled; `noContentSeconds` accepts 1–3600
(default 10). `retainSummary` keeps the last run until the next one;
`runtime.enabled: false` hides local runtime metrics. Reload/new session resets
in-memory runtime summaries, not persisted session totals.

Extension statuses remain display-only; a plain `tps` status of `Elapsed …`
replaces the local Elapsed label. Git updates asynchronously; no repository
hides the segment, and query failures show `?`. Narrow layouts prioritize model
and context. RPC, JSON and print mode do not install the footer or start polling.

## Development

From this repository, load only the statusline for one invocation:

```sh
npm install
pi --no-extensions --extension ./packages/pi-statusline/src/index.ts

npm run check --workspace @erichll/pi-statusline
npm test --workspace @erichll/pi-statusline
npm run smoke --workspace @erichll/pi-statusline
```

The POSIX PTY smoke uses an offline provider in regular and fullscreen layouts.
For a persistent install, use the published npm package.

Independently implemented with design references to
[pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer). MIT licensed.
