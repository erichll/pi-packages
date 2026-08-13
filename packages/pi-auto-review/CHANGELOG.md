# Changelog

## 0.3.5 - 2026-08-13

- Raise the default model-review `timeoutMs` from 45s to 90s and the default
  `retries` from 1 to 2. Approval now tolerates real-world model latency better
  while keeping the same bounded transcript surface.

## 0.3.4 - 2026-08-08

- Normalize direct and permission-system v24 forwarded evidence before policy
  checks, model review, grant hashing, and audit logging. Forwarded Bash
  commands, canonical path boundaries, agent names, and requester session IDs
  now remain bound to the exact reviewed request.
- Add an opt-in `PI_AUTO_REVIEW_AUDIT_FILE` JSONL sink for isolated release
  verification without changing the normal event-based audit surface.

## 0.3.3 - 2026-08-06

- Fix config validation rejecting multi-segment model ids (`provider/group/model`).
  `validateConfig` no longer restricts a model to exactly one `/`; it only rejects
  ids with empty segments. Segments are resolved as before: the first segment is
  the provider and the rest is the model id.

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
