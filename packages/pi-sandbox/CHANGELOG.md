# Changelog

## 0.4.2 - 2026-07-30

- Load trusted configuration from
  `~/.pi/agent/extensions/pi-sandbox/config.json`, with a read fallback to the
  legacy `~/.pi/agent/pi-sandbox.json` path when the new file is absent.
- Deny writes to common workspace secrets by default (`.env` variants,
  `secrets/` / `.secrets/`, and discovered `*.pem` / `*.key` / `*.p12` /
  `*.pfx`), while leaving template files such as `.env.example` writable.
- Protect `~/.pi/agent/extensions` (including the extension-local config) from
  sandboxed writes.
- On macOS, add git-style secret globs for nested create protection; Linux keeps
  literal absolute paths only because Sandbox Runtime drops globs there.

## 0.4.1 - 2026-07-29

- Republish to refresh the npm search index used by the pi.dev package gallery.
- Depend on `@erichll/pi-auto-review@0.3.2`.

## 0.4.0 - 2026-07-29

- Add an optional, approval-gated Host-IPC Bash backend for commands that need
  access to host Unix sockets.
- Support trusted preflight command prefixes without treating a prefix as
  authorization; every complete command still requires an exact one-shot
  approval.
- Support one non-recursive host retry after a narrowly detected Unix-socket
  `Operation not permitted` sandbox failure.
- Preserve the first attempt's output, apply only the original timeout's
  remaining duration, and never retry successful, timed-out, or aborted
  commands.
- Refuse Host-IPC forwarding for built-in subagents.
- Add deterministic execution and approval coverage plus a Linux tmux socket
  smoke test.

## 0.3.1 - 2026-07-29

- Add trusted global filesystem read-path extensions while keeping default
  write and configuration protections intact.

## 0.3.0 - 2026-07-28

- Initial public release.
