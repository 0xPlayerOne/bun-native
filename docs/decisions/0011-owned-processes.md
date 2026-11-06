# ADR 0011 — Owned child processes

Status: accepted; Linux implementation verified locally in development and
inspected AOT with a development-profile host on an isolated Xvfb display.
Hosted release-host qualification runs in Native Linux. A macOS backend
(below) is compile-checked locally for `aarch64-apple-darwin` and runs only in
the hosted Native Platforms macOS 15 job; its evidence comes from that CI job
alone. A Windows backend (below) is type-checked and linted locally for
`x86_64-pc-windows-gnu`, and its command-line quoting and environment block
run in the Linux unit tests; its only Windows execution evidence is the hosted
Native Platforms `windows-2022` job.

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

`NativeWindow.spawnProcess(id, options, listener)` starts that executable with an
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

### macOS

macOS has no pidfd, eventfd, `openat2` or `/proc/self/fd`, so its backend keeps
the same supervisor and semantics with different primitives:

- **Wake.** A nonblocking close-on-exec pipe replaces the eventfd.
- **Exit.** A watcher thread per process blocks in
  `waitid(P_PID, WEXITED | WNOWAIT)` and closes a pipe the supervisor polls.
  `WNOWAIT` leaves the zombie unreaped, so the leader's PID and group ID stay
  reserved; the supervisor joins the watcher before it reaps, so no thread ever
  waits on a PID that could have been reused. `kqueue` `EVFILT_PROC
  NOTE_EXIT` would need no thread, but rustix's `kevent` is `unsafe` and the
  crate forbids `unsafe`. Exit codes and signals come from the reaping
  `waitpid` on both platforms, not from the `waitid` notification.
- **Groups.** Pipes mode uses `process_group(0)` and terminal mode uses
  `pty-process` 0.5.4, which supports macOS (`posix_openpt`, `setsid`,
  `TIOCSCTTY`). On exit the group is killed with `killpg` while the zombie
  leader still holds the group ID, exactly as on Linux. A signal racing the
  exit may find a group of only the zombie, which macOS can report as
  `ESRCH`; that is answered `invalid_state` ("the process has exited") on
  both platforms, and no other process can be reached.
- **Working directory.** The child runs `fchdir` on a duplicate of the grant's
  directory descriptor between `fork` and `exec`, so the descriptor, not a
  path, names the directory. std's `Command::current_dir` takes only a path,
  and recovering the grant's path with `F_GETPATH` would reintroduce the
  check-then-use race a grant descriptor exists to remove (a directory
  renamed or replaced by a link between the lookup and `chdir`). Registering
  the step needs `unsafe` `pre_exec`, so it lives in the small
  `bun-native-posix-services` crate (`deny(unsafe_code)` with two reviewed
  calls); the host keeps `forbid(unsafe_code)`. The step is a raw system call
  on a close-on-exec duplicate and allocates nothing. The directory is
  resolved beneath the grant without following links before the spawn, so a
  link or missing path is `path_denied` / `not_found` and no child is started.
  Without a `cwd` the child starts in the host's working directory.

### Windows

Windows has no process groups, signals, pidfds or PTYs. The backend keeps the
same supervisor contract (credit, ordering, release and exit last) with
Windows primitives. All Win32 calls live in the private
`bun-native-windows-services` crate, built on the `windows-sys` crate that
GPUI already depends on.

- **Executable.** Launch paths may be Windows drive paths (`C:\tools\x.exe`),
  never UNC or `\\?\` forms, and each host accepts only its own form. The
  host opens the granted file with read-only sharing and holds it until the
  child has started, so it cannot be written, replaced or renamed in between.
  Its normalized final path (`GetFinalPathNameByHandleW`) must equal the
  granted path, compared without case, so a policy entry that crosses a link
  or uses a short name is refused (`path_denied`). `CreateProcessW` runs that
  path as `lpApplicationName`: no search, no shell, and a file without an
  extension is refused (`wrong_kind`) because Windows would append `.exe`.
- **Arguments and environment.** The command line is built as the exact
  inverse of `CommandLineToArgvW` (the MSVC rules), so a program that parses
  its arguments that way receives the given vector. Programs that parse their
  own command line, notably `cmd.exe`, see that quoting literally; nothing is
  run through a shell. The environment block holds only the given variables,
  as on Linux, so a child that needs `SystemRoot` or `PATH` must be given them.
- **Tree.** Each child starts inside its own job object, attached with
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` before its first instruction, with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Descendants inherit the job. When the
  leader exits the host terminates the job, so descendants holding the output
  open end, then drains output to end of file and reports the exit last. The
  host's own exit or crash closes the job and ends the tree.
- **Pipes.** Anonymous pipes; `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` makes the
  child inherit exactly its three ends, and it runs on its own hidden console.
  One reader thread per output stream and one writer replace `poll`. Each
  reader holds the chunk it read until the delivery credit admits it, so the
  same four-chunk credit back-pressures the child.
- **Terminal.** A ConPTY pseudo-console (Windows 10 1809 or later), resized
  with `ResizePseudoConsole`. The output is ConPTY's rendered VT stream, not
  the child's raw bytes, and closing input types ^Z and Enter.
- **Signals.** `terminate` and `kill` terminate the job and the exit reports
  that signal. `interrupt` on a terminal types ^C, which the console delivers
  as `CTRL_C_EVENT`. `interrupt` on pipes types ^C into the child's hidden
  console. Windows delivers a console control event only to processes attached
  to that console, and a process has one console at a time, so the host does
  not attach itself (that would detach it from its own and race every other
  interrupt). It starts its own binary with `--bun-native-console-interrupt
  <pid>` and no console; that helper releases its fresh console, attaches to
  the child's, ignores ^C for itself, sends `CTRL_C_EVENT` to the console's
  processes (the child's own job) and exits. The call waits at most three
  seconds and then ends the helper. `hangup` has no Windows equivalent and
  returns `service_unavailable`. Other exit codes are reported modulo 256, as
  POSIX does (`STATUS_CONTROL_C_EXIT` is therefore code 58, not a signal).
- **Working directory.** `CreateProcessW` takes only a path. The host walks
  the grant with the ADR 0010 rules and holds the root and every directory
  down to the target open without delete sharing, so none of them can be
  renamed, removed or replaced by a link. The child starts at the target's
  final path while those handles are held. Only a rename above the grant root,
  which no grant can reach, could still change that path.

Errors are typed: `permission_denied` (policy), `not_found` (missing
executable or directory), `path_denied` (the directory crosses a link),
`wrong_kind` (not a runnable program, or a resize of a pipes process),
`access_denied` (the OS refused), `invalid_state` (an exited process, or input
already closed), `limit_exceeded` (eight live processes, 64 KiB of unread
input, or no OS capacity), `service_unavailable`, `native_failure` and
`cancelled` (a released process, or a host shutting down). The host answers
`invalid_handle` for a grant from another window or one already closed; the
core rejects such a grant with a `TypeError` before any request, so only a
direct wire client sees that code.

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
  lift the host's `forbid(unsafe_code)`; `pty-process` is pinned instead. The
  one exception is the macOS `fchdir` above, isolated in its own crate.
- **macOS `kqueue` for exit.** No watcher thread, but `kevent` is `unsafe` in
  rustix. A watcher thread per process (at most eight) is the safe cost.
- **macOS working directory through `F_GETPATH`.** A path again, with the race
  described above; rejected in favour of `fchdir` on the descriptor.

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
and release, close and shutdown stopping groups.

On macOS the same unit tests run on real children in the Native Platforms
macOS 15 job (session leadership is checked with `ps` group and state flags
because macOS `ps` has no session ID; the grant directory test is replaced by
a test that a `cwd` is refused), plus a test that a leader's exit stops a
descendant still holding its output open. The same native test runs in
development and inspected AOT there, without filesystem roots, checking group
teardown through `ps` and that a `cwd` is refused. None of this was run
locally: macOS behavior is claimed only from that CI evidence.

On Windows the Native Platforms `windows-2022` job runs the Windows unit tests
on real `cmd.exe` children: pipes with an explicit environment and exit code,
missing, extensionless, non-canonical and directory executables, a sized
ConPTY, output credit, a leader exit ending a descendant that holds its
output, `terminate`, a pipe `interrupt`, refused `hangup`, release, and a grant
working directory with junction and missing cases. The same native test runs
there in development and inspected AOT, with an NTFS junction as the escape,
descendants found through `Get-CimInstance Win32_Process`, and the terminal
size read back with `mode con`. None of this was run locally: Windows behavior
is claimed only from that CI evidence.
