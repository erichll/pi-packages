# pi-sandbox Local Binding and Unix Socket Considerations

## Status

This document records the current `pi-sandbox` design position on the following
Sandbox Runtime network settings:

- `allowLocalBinding`
- `allowUnixSockets`
- `allowAllUnixSockets`

These settings are not currently exposed through
`~/.pi/agent/extensions/pi-sandbox/config.json`. This is a design and security
note, not a guide for supported configuration, and it does not promise a
specific implementation timeline.

The analysis is based on the version of `@anthropic-ai/sandbox-runtime`
currently pinned by `pi-sandbox`. Any Sandbox Runtime upgrade should revalidate
the platform behavior and security assumptions documented here.

## Why these settings are separate from domain policy

`allowedDomains` and `deniedDomains` control which Internet destinations a
sandboxed process may contact. Connections still pass through Sandbox
Runtime's controlled proxy and are matched by hostname, optional wildcard, and
optional port.

Local ports and Unix sockets instead cross host inter-process communication
(IPC) boundaries:

- A local port may reach a database, debugger, or administrative service that
  listens only on the host loopback interface.
- A Unix socket may directly expose Docker, SSH Agent, D-Bus, database, or
  desktop-service capabilities.
- Some sockets provide capabilities close to host command execution and
  therefore carry substantially more risk than access to an ordinary public
  domain.

Adding static domain allow/deny rules should not implicitly expose these IPC
capabilities. They require a separate threat model, explicit cross-platform
semantics, and dedicated tests.

## Configuration overview

| Setting | Purpose | macOS behavior | Linux behavior | Current decision |
| --- | --- | --- | --- | --- |
| `allowLocalBinding` | Permit binding local IP ports and local client/server communication | Seatbelt permits bind, inbound, and loopback outbound operations | The current Linux sandbox path does not use this setting; network-namespace behavior differs | Not exposed |
| `allowUnixSockets` | Permit Unix sockets at selected paths | Supports a path allowlist | The path list is ignored because seccomp cannot filter by socket path | Not exposed |
| `allowAllUnixSockets` | Permit all Unix sockets | Permits all Unix socket creation, binding, and connections | Disables the seccomp filter that blocks `AF_UNIX` socket creation | Not exposed as ordinary configuration |

The three settings retain their secure defaults:

```json
{
  "network": {
    "allowLocalBinding": false,
    "allowUnixSockets": [],
    "allowAllUnixSockets": false
  }
}
```

This example describes internal defaults only. These fields are not currently
valid in `pi-sandbox/config.json`.

## `allowLocalBinding`

### Purpose

This option serves commands that need to start a local service inside the
sandbox, for example:

```bash
npm run dev
python -m http.server 8000
```

Its name may suggest that it only permits `bind()`. In the current macOS
implementation, supporting practical local client/server workflows also
permits:

- binding local IP addresses and arbitrary ports;
- accepting inbound connections;
- connecting to services on `127.0.0.1` and `::1`.

Sandbox Runtime also applies a compatibility setting for Java dual-stack
sockets. The option therefore represents a platform-specific collection of
behaviors, not a precise single-port grant.

### Risks

The macOS sandbox does not give the workload a separate Linux-style network
namespace. The sandbox shares host loopback, so permitting loopback outbound
connections may expose:

- local databases and caches;
- unauthenticated administrative or debugging ports;
- browser remote-debugging endpoints;
- services protected only by listening on localhost.

Permission to listen may also expose a development server unintentionally. The
actual reachability depends on the selected bind address, system firewall, and
host network configuration, but `pi-sandbox` should not describe a broad
boolean as though it were a single-port authorization.

### Current decision

Do not expose `allowLocalBinding` yet. Any future support should at least:

- document the complete bind, inbound, and loopback-outbound semantics;
- test Linux and macOS behavior independently;
- evaluate whether listening and connection ports can be constrained;
- remain disabled by default and configurable only through trusted global
  configuration;
- preserve the existing domain policy and dynamic review for public egress.

## `allowUnixSockets`

### Purpose

This option attempts to allow selected Unix domain sockets by filesystem path,
for example:

```json
{
  "allowUnixSockets": [
    "/path/to/specific.sock"
  ]
}
```

Unix sockets commonly provide local IPC for Docker, containerd, SSH Agent, GPG
Agent, D-Bus, tmux, databases, and IDE background services.

### Platform differences

On macOS, Seatbelt can apply rules to Unix socket bind/connect paths, allowing
Sandbox Runtime to enforce a path allowlist.

On Linux, the current implementation blocks creation of new `AF_UNIX` sockets
with seccomp. Filtering occurs at `socket(AF_UNIX, ...)`, before a destination
path exists. Seccomp cannot safely inspect the userspace path later passed to
`connect()`. Consequently:

- the `allowUnixSockets` path list is ignored on Linux;
- the default policy blocks creation of new Unix sockets;
- inherited socket file descriptors and descriptors received through
  `SCM_RIGHTS` are residual cases that this protection does not fully address.

### Risks

A socket path may look like an ordinary file path while representing a
high-privilege capability:

- Docker or containerd sockets may enable host-level code execution or
  privilege escalation;
- an SSH Agent socket may allow use of loaded keys for signing;
- D-Bus, desktop-service, or IDE sockets may trigger operations outside the
  sandbox;
- a local database socket may have no additional authentication.

Exposing the field directly would also create a misleading cross-platform
security expectation. A user could configure one precise path and reasonably
assume that Linux permits only that path, although the current runtime cannot
provide that guarantee.

### Current decision

Do not expose `allowUnixSockets` yet. Reconsideration requires at least one of
the following:

- upstream provides a verifiable path-level Unix socket policy on Linux; or
- `pi-sandbox` makes the capability explicitly macOS-only and fails closed on
  unsupported platforms instead of silently ignoring it.

Any implementation must also warn about high-risk sockets, include dedicated
tests, and ensure that project-controlled content cannot modify the trusted
socket allowlist.

## `allowAllUnixSockets`

### Purpose and effective behavior

This setting is a compatibility escape hatch, not a fine-grained permission:

- on macOS, it permits Unix socket creation and binding or connection to every
  Unix socket path;
- on Linux, it prevents installation of the seccomp filter that blocks
  `AF_UNIX` socket creation.

On Linux architectures unsupported by the current seccomp helper, upstream
also presents it as a way to explicitly accept weaker isolation.

### Risks

Enabling this setting removes an entire host IPC isolation layer. If a socket
is visible to the sandbox and other permission checks permit access, the
workload may attempt to connect to it. This can reconnect an otherwise
filesystem- and network-restricted agent to a service carrying host
privileges.

It should therefore not be treated as equivalent to an ordinary domain
allowlist or used as the first solution to a single tool compatibility issue.

### Current decision

Do not expose `allowAllUnixSockets` as ordinary user configuration. Keep it
fixed at `false` unless a concrete requirement cannot be met by a narrower
mechanism. Any future support must:

- require an explicit and conspicuous weaker-isolation opt-in;
- display a security warning during startup;
- document platform differences and residual risks;
- test that defaults and failure paths remain fail closed;
- never use it as an automatic fallback for missing dependencies or invalid
  configuration.

## Relationship to `hostIPC`

`pi-sandbox` already provides the optional `hostIPC.mode: "ask"` mechanism. It
does not let a sandboxed process access a Unix socket directly. Instead, it
runs a complete command outside the sandbox only after one-shot approval from
`pi-auto-review` or a human.

This is still a high-risk capability, but it has several auditable properties
compared with permanently opening a socket:

- approval binds to the complete command and working directory;
- each grant is consumed once;
- configured prefixes trigger review but do not authorize execution;
- the mechanism is disabled by default;
- execution is denied when the reviewer is unavailable or the grant is
  invalid.

For the small set of commands such as `tmux` that require a host Unix socket,
the current preference is this explicit approval path rather than general
socket access. High-privilege operations such as Docker should still be
strictly constrained by deterministic permission rules or human approval even
when routed through `hostIPC`.

## Principles for future evaluation

Before adding support in response to a feature request, identify the actual
requirement:

1. Start a temporary development server used only for testing.
2. Connect to a service on host loopback.
3. Connect to one specific Unix socket.
4. Accept weaker isolation on a platform without seccomp support.
5. Execute one known command that requires host IPC.

These requirements should not be solved with one broad switch. Prefer the
narrowest mechanism with auditable behavior, a disabled default, and explicit
cross-platform semantics. A new capability must never silently degrade or
expand permissions when configuration parsing fails, a platform is
unsupported, or the reviewer is unavailable.

## Related implementation

- `packages/pi-sandbox/src/policy.ts` fixes these settings at secure defaults.
- `packages/pi-sandbox/src/host-ipc.ts` implements approval-gated host command
  execution.
- `packages/pi-sandbox/src/approval.ts` implements one-shot approval and
  fail-closed behavior.
- Sandbox Runtime's `README.md` documents platform-specific Unix socket
  configuration and security limitations.
