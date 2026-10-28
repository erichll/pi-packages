# @erichll/pi-statusline

A configurable native Pi footer with Git status, session usage, runtime/tool
activity and live configuration preview. Leaves the editor intact.

```text
  Example model(high)  󰆼 █░░░░░░░░░ 11.9%  󰉋 pi-packages   main ● *2 ↑2
 󱁤  ◐ bash npm test 12s · ✓ read ×5 · ✓ edit ×2
 󰗚  pdf-tools · docx
 󰐰  ● 5m 42s · avg 45 tok/s · cache 86% · turns 3 · compactions 1 · 󰥔 2h 6m · 󱁤 128 · 󰊄 49.4k
```

Rows, top to bottom: the main segments, tool activity for the current run
(only once it has used tools), the skills used in the session (only once one
is used), then run status, run metrics, session age, tool calls and tokens,
and other extensions' statuses. The last three rows start with a space, so their
labels (`󱁤`, `󰗚`, `󰐰`) sit under the main row's model icon, and two
spaces set each label off from the row contents (one in ASCII mode).

## Install

```sh
pi install npm:@erichll/pi-statusline
```

Requires Node.js >=22.19 and Pi >=1.4.0.
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
| `session` | Time since the session was created, on the bottom row | On |
| `toolTotal` | Tool calls recorded in the whole session (`󱁤 128`), on the bottom row; hidden at zero | On |
| `tokens` | Cumulative session tokens, on the bottom row | On |
| `cost` | Pi-recorded cumulative USD cost | Off |
| `input`, `output`, `cacheRead`, `cacheWrite` | Individual session token counters | Off |
| `statuses` | Other extensions' text, at the end of the bottom row | On |

`segments` is an ordered array of
`{ id, enabled, icon?, color?, iconColor?, background? }`. Omitted segments are
disabled, **except `quota`, `session` and `toolTotal`**: old configurations automatically
gain `quota` after `context`, and `session` and `toolTotal` before `tokens` (or at the end when
the anchor is absent). To keep one off, include it with `"enabled": false`.

Colors accept `#RRGGBB` or supported Pi theme tokens such as `accent`, `muted`,
`success`, `warning` and `error`; explicit colors override automatic thresholds.
An empty icon hides it; enter `:default` in the panel to restore its default.
The `thinking` entry controls the model suffix, not a standalone segment.

Invalid configurations retain the last working settings and show a warning.
Removing the file restores defaults on reload; panel saves are atomic.

## Subscription Usage (Pi 1.2+)

Codex quota appears after context when valid data is available:

```text
󰆼 █░░░░░░░░░ 4.6%  󰦖 5h ████░░░░░░ 40% 3h3m · 7d ██░░░░░░░░ 21% 4d9h
```

Bars show **used** percentages for the primary and secondary windows, with live
reset countdowns. Labels come from the reported window length (`5h`, `1d`,
`7d`, `30d` within 5%, otherwise exact such as `1h30m`); without one, the
window is unlabeled rather than guessed. Each window is colored on its own:
Pi's accent, warning above 70% and error above 90%; the segment icon follows
the higher of the two. A segment `color` overrides both. Narrow terminals omit countdowns, then bars, then the segment rather than
truncate a window; an unlabeled window keeps its countdown instead of its bar.

Data is observed passively through Pi's provider events:

- **SSE:** `x-codex-{primary,secondary}-{used-percent,reset-at,window-minutes}` response headers.
  CLIProxyAPI needs `requests.passthrough-headers: true`.
- **WebSocket:** native `codex.rate_limits` events with numeric `used_percent`,
  `reset_at` and optional `window_minutes` in `rate_limits.primary` / `secondary`. Other named metered
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
- The bottom row (`󰐰`, `∿` in Unicode and `run` in ASCII icon modes) starts
  with the run status (`●` running, `✓` done, `✗` failed, `⊘` cancelled) and its
  duration, which spans retries, tools, UI waits and compaction. `avg` is assistant output tokens / total run seconds, **not
  inference speed**; `cache` is cache-read / (input + cache-read + cache-write).
  `turns` counts Pi turns, not upstream requests; `compactions` counts
  successful session entries. The row stays muted; only a failed run, waits,
  compaction problems and cache below 50% are colored.
- The run duration (to the second) covers one run, from your message until the
  agent settles, across all its turns. The session age (`󰥔 2h 6m`, to the
  minute) counts from the session header's creation time: it survives reloads
  and resuming, restarts with `/new` or a fork, and is hidden when the header
  time is missing or invalid.
- `awaiting input` and `no content 10s` follow the duration while active. No
  content means no non-empty text, reasoning or tool-call delta was observed; it
  is not a server timeout and is suppressed during tools, UI waits and compaction.
- The tool row (`󱁤`, `⚒` in Unicode and `tools` in ASCII icon modes, like the
  session tool total) shows up to two running tools with what they work on (a
  shell command without `cd`/env prefixes, a file name or a search pattern), merging
  same-name calls as `×N`, then this run's completed (`✓`) and failed (`✗`)
  counts. `toolsMaxVisible` (1–8, default 4) completed kinds show before `+N`.
  Nested calls count but are represented by their parent while running; calls
  ended by a cancellation are not failures. Narrow rows fold kinds, then drop
  targets, then timers. The row stays quiet: running tools (`◐ bash`) use the
  text color, completed ones (`✓`) are dim, and only a tool running 30s or
  longer (its `◐` and timer turn warning) and failures (error) are colored. A read of a skill file shows its directory
  (`read pdf-tools/SKILL.md`).
- The skills row (`󰗚`, `❖` in Unicode and `skills` in ASCII icon modes) lists
  the loaded skills used in the session, in first-use order: `/skill:name`
  invocations and model reads of a loaded skill's file.
  Reads of skill files Pi did not load are ignored; a skill read only for
  reference, such as while writing another skill, still counts. Like tool calls,
  it is read from session entries, so it survives reloads and resuming.
  `skillsMaxVisible` (1–8, default 4) names show before `+N`; narrow rows fold
  names, then show only the count.

All runtime options default to enabled; `noContentSeconds` accepts 1–3600
(default 10). `tools: false` hides the tool row and `skills: false` the skills row. `retainSummary` keeps the last run until the next one;
`runtime.enabled: false` hides local runtime metrics. Reload/new session resets
in-memory runtime summaries, not persisted session totals.

Extension statuses remain display-only; a plain `tps` status of `Elapsed …`
supplies the duration. Git updates asynchronously; no repository
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
