# ADR 0011 — Owned child processes

Status: accepted; Linux implementation verified locally in development and
inspected AOT with a development-profile host on an isolated Xvfb display.
Hosted release-host qualification runs in Native Linux. Other platforms report
the service unavailable.

Date: 2026-11-05.

Related: [#305](https://github.com/0xPlayerOne/bun-native/issues/305),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[Adea port #250](https://github.com/0xPlayerOne/bun-native/issues/250),
[filesystem grants](0010-filesystem-grants.md),
[trust boundary](0003-bridge-security.md) and
[service policy](0005-native-service-policy.md).

## Context

The Adea workspace runs terminals and tool processes on behalf of parts of an
application that are less trusted than the application itself: model tools,
rendered content and remote controls. Those parts must be able to start a
known program, stream its output and stop it, without being able to name an
arbitrary executable, inherit secrets from the application's environment, run
in a directory they were never granted, or leave processes behind when their
window goes away. Bun's own `Bun.spawn` remains the trusted application's
authority and is outside this broker.

The risks are shell injection through command strings, environment leakage,
working directories chosen by path text, unbounded output buffered in either
process, descendants that outlive their leader, and signals or events that
reach a process after its owner released it.

## Decision

Protocol 10 adds an immutable `processes` launch permission: up to eight
`{ id, executable }` entries, each an absolute normalized path. The runtime
passes each as a reserved `--bun-native-process=<id>:<path>` argument and
readiness must report the identical ordered list. No wire command names an
executable path; `spawn_process` names a policy ID.

`NativeWindow.spawnProcess(id, options)` starts that executable with an
explicit argument vector (no shell) and a complete environment: the host
clears the inherited environment and sets only the given variables. The
working directory must come from a file grant owned by the same window, plus
an optional relative path resolved beneath it with the grant rules of ADR 0010;
the child starts in that opened directory, never a path string.

Pipes mode connects stdin, stdout and stderr and starts the child in its own
process group. Terminal mode allocates a PTY and makes the child a session
leader with the PTY as its controlling terminal, so job control, resizing and
terminal signals behave as in a real terminal. The crate forbids `unsafe`, so
both modes use safe wrappers (`process_group(0)` and `pty-process`) instead of
a hand-written `pre_exec`.

Each process has one supervising thread that polls a wake eventfd, a pidfd,
the output descriptors and the input descriptor. Output is sent in sequenced
chunks of at most 16,384 bytes with at most four unacknowledged chunks; the
core acknowledges a chunk only after the listener settles, so a slow listener
back-pressures the child instead of growing a buffer. Pending input is bounded
at 64 KiB.

When the leader exits, the host observes it with
`waitid(P_PIDFD, WEXITED | WNOWAIT)`, kills the whole group while the zombie
leader still holds the group ID, drains output to end of file, reaps the
leader and emits `process_exited` last. Releasing the process, closing its
window or shutting down kills the group and reaps it on the supervising
thread; no event is delivered after release, and signals are refused once the
leader is reaped, so a recycled PID is never signalled.

Errors are typed: `permission_denied` (policy), `not_found` (missing
executable or directory), `invalid_handle` (a grant from another window or
already closed), `invalid_state` (a finished or released process),
`limit_exceeded` and `service_unavailable`.

## Alternatives

- **Shell command strings.** Quoting is the classic injection point; an
  argument vector against a policy executable has none.
- **Inheriting and editing the environment.** An allowlist of removals misses
  new secrets; starting from empty makes every variable explicit.
- **A working directory path.** The same check-then-use races as path
  allowlists; a grant descriptor is the authority.
- **A subreaper or cgroup per window.** Stronger containment of daemonizing
  descendants, but it changes process-wide behavior or needs privileges.
  Process groups cover ordinary descendants; a process that calls `setsid` to
  escape is documented as out of scope.
- **`unsafe` `pre_exec` for session setup.** Equivalent at runtime but would
  lift the crate's `forbid(unsafe_code)`; `pty-process` is pinned instead.

## Consequences and verification

Applications that run tools declare their executables at launch and pin the
packages and host together. The service gives no protection from the trusted
application itself, and a granted executable runs with the application's user
authority.

Rust unit tests cover pipes and environment, grant directories with link and
missing cases, terminal session leadership, output credit, group signals,
release and missing executables on real processes. A shared fixture of 41
command and 19 event cases runs through both parsers. Headless core tests
cover argument mapping, ordering, credit acknowledgement, late events and
policy mismatch. The native test
[`tests/native/processes.ts`](../../tests/native/processes.ts) runs the real
host in development and AOT on an isolated display and checks default denial,
pipes with environment and grant directory, typed failures, terminal size,
resize and input, group signals stopping descendants, complete credited output
and release, close and shutdown stopping groups. macOS and Windows remain
unavailable until they have equivalent descriptor-based spawning.
