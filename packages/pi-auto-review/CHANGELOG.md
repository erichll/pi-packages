# Changelog

## 0.3.2 - 2026-07-29

- Load an optional user-global trusted config from
  `~/.pi/agent/extensions/pi-auto-review/config.json` as a full overlay on the
  package defaults (model, `autoConfirmBoundedAllows`, and other legal keys).
- Keep project `.pi/pi-auto-review.json` tighten-only on top of that trusted
  layer.
- Deterministically deny writes to the user-global reviewer config directory.
- Default reviewer model is the bare id `codex-auto-review`; `provider/model`
  remains supported. Bare ids resolve against registered available models.
- Show user-facing review feedback in interactive UI: a footer status while the
  model is reviewing, then a short toast for allow / deny / defer / auto-confirm
  / circuit-breaker outcomes (separate from agent denial reasons).

## 0.3.1 - 2026-07-29

- Bind one-shot approval grants to matched policy evidence as well as the
  command, working directory, destination, paths, and other request fields.
- Prevent a grant issued for one Host-IPC trigger from authorizing a request
  with different trigger evidence.

## 0.3.0 - 2026-07-28

- Initial public release.
