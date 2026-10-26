# Unix terminal group ownership prerequisite

Issue #25, based on `a89949f` (#113/#114). This is an opt-in native implementation
for **non-detached command groups**, not completion of M5 process supervision.
The default `BunTerminalDriver` retains its documented direct-child behavior.

## Decision and supported boundary

The pinned Bun 1.4.3 PTY creates a different process group from its backend. The
retained macOS discriminator proved that both a SIGHUP-ignoring PTY child and its
server grandchild survive normal and SIGKILL backend loss. Backend-group cleanup
and closing the PTY therefore cannot establish descendant cleanup.

Bun owns PTY creation and reaping of the process passed to `Bun.spawn`. Its pinned
`Terminal` interface has no API for adopting a native-created PTY slave/master or
transferring the child wait identity to another owner. Registering a numeric PID
with the host after spawn would race Bun's reaping. Linux pidfds do not provide a
portable macOS process-group handle; Windows Jobs need a separate implementation.

The selected prerequisite puts a small prebuilt native owner in the real Bun PTY.
It launches the requested executable directly, without shell interpolation, in its
own foreground group. The owner stays outside that group, owns its direct child's
wait identity, and watches a dedicated socketpair lease from Bun. One blocking
`waitid(WNOWAIT)` thread notifies the owner's `poll` loop. Idle operation has no
polling timer. Runtime admission allows at most **64 owners per runtime JS isolate**,
shared across driver/service instances, in addition to TerminalService's global,
per-owner and byte reservations. Each admitted PTY adds one process and one exit
watcher thread; no owner is created per callback or application service.

This exception to the preferred shared-owner design is necessary to keep Bun's
real PTY API and an actual Unix parent/wait identity together without a Bun fork.
It is not a process-count or performance win. A shared native PTY broker would
require a different PTY-handle transfer API and packaging/lifecycle design.

Explicit use with the matching prebuilt binary:

```ts
const terminals = new TerminalService({
  driver: new NativeTerminalDriver(absoluteInstalledOwnerPath),
})
```

The application never compiles or downloads the owner. Shipping bundle discovery,
artifact provenance/signing and automatic native-host wiring are still prerequisites
for making this the default. Windows rejects this driver explicitly; the existing
native backend Job Object is unchanged and is not evidence for this terminal API.

## Identity, events and failure

A fresh private socketpair is the owner/generation identity. Its protocol accepts
only admission and bounded signal bytes, never a PID, group ID, renderer identifier
or executable name. A stale terminal handle cannot obtain a replacement descriptor.
The descriptor is close-on-exec before the application starts, so shell/server
children cannot keep the backend lease alive. The owner ignores terminal hangup;
EOF on the lease, including abrupt Bun death, invokes owned group cleanup.

The actual child remains unreaped through every group signal. Each signal first
checks the still-owned child with `waitid(WNOWAIT)`. Once reaped, `ECHILD` prevents
any further group signal. PID reuse cannot authorize a replacement. On Darwin,
`kill(-pgid, ...)` can return `EPERM` for a group containing only its zombie leader.
Only a bounded two-slot `proc_listpgrppids` query proving that the retained, exited
child is the **sole** member permits that special empty-live-group outcome. The
query never supplies a signal target. Any other denial remains a failure.

The private response distinguishes native launch readiness, command exit status,
and failure. Readiness means the native command was successfully spawned, not that
an application-specific server is ready. `SIGTERM` arms one absolute two-second
native grace interval; repeated requests do not extend it. `SIGKILL`, lease loss,
protocol failure and natural command exit use immediate group cleanup. Only after
that cleanup and direct-child wait does the owner report the command's exit code
or signal. A successful group signal proves signal delivery, **not independent exit
observation for every descendant**. The maintained fixture separately observes the
shell and server identities and the server's listening port.

Native denial becomes `TERMINATION_DENIED`; missing/malformed responses or owner
failure become `SUPERVISION_FAILED`. Both settle an unobserved process failure,
retain terminal and native-owner capacity, and do not fabricate process exit or
release. There is no retry loop and no automatic restart: the restart budget is zero.
No input or non-idempotent request is replayed. Explicit replacement creates a new
handle/lease; cross-generation adoption and managed backend replacement remain M6.

Bun still owns terminal input, resize and byte callbacks. The control channel never
carries terminal output. Actual process observation, actual PTY closure and ACKed
output drain remain independent; natural process exit does not discard trailing
output. Native launch failure may conservatively retain admission when actual
command ownership cannot be established.

## Remaining unsupported cases

- Descendants that leave the command group with `setpgid`/`setsid`, including
  interactive-shell job-control groups, are not contained. This driver is currently
  for non-detaching command groups, not unrestricted interactive shells.
- SIGKILL/crash of the native terminal owner itself can orphan its group. The owner
  cannot run cleanup after its own death; this is not an OS kill-on-close container.
- Native GUI-host crash while Bun survives does not close the Bun-owned lease.
  Full host-crash supervision and a host-owned shared lease remain open in #25.
- Changed credentials/OS termination denial and uninterruptible kernel operations
  can prevent cleanup. Failure remains explicit; retaining admission is not proof
  that the OS terminated the group. A denied owner may exit with descendants still
  alive. No privileged escalation or global cleanup is attempted.
- Windows terminal job assignment, detached-session containment, full CEF fault
  acceptance, positive restart/backoff policy, and packaging are not implemented.

## Validation

The native binary's unit regression retains a real exited shell, cleans its group,
reaps it, and proves stale signalling fails with `ECHILD`. TerminalService tests
prove denial/unknown ownership retains reservations even after actual PTY closure.
The real Python/Bun fixture covers natural exit with an 8 KiB trailing output record,
graceful close of TERM-ignoring descendants with escalation, cancellation, normal
Bun exit and SIGKILL Bun loss. Every case records exact creation identities and
ancestry before signals, verifies the fixed server port closes, and leaves a
concurrently running identical shell/server untouched. Fixture alarms and finally
cleanup are separate from supervision success. Harness cleanup of supervised
children makes a case fail; cleanup of the unrelated control is expected.

Contributor commands (no CEF browser is linked into this standalone binary):

```sh
CARGO_TARGET_DIR=.bunly/terminal-native cargo +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --bin bunly-terminal-owner --features cef/dox -- -D warnings
CARGO_TARGET_DIR=.bunly/terminal-native cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --bin bunly-terminal-owner --features cef/dox
CARGO_TARGET_DIR=.bunly/terminal-native cargo +1.91.0 build --locked --manifest-path native/cef-host/Cargo.toml --bin bunly-terminal-owner --features cef/dox
python scripts/qualify_terminal_owner.py --bun /absolute/pinned/bun --owner .bunly/terminal-native/debug/bunly-terminal-owner --output .bunly/terminal-owner-evidence/qualification.json
```

The maintained `cef-runtime.yml` manual native hook executes the actual owner and pinned Bun
on macOS and Linux, through non-portable manual dispatch while the PR stays draft. Windows is
unsupported rather than a no-op passing platform. Exact commit/run receipts belong
in the PR; a cross-compile does not count as execution.

Design references, no source copied: pinned `bun-types@1.4.3` `SpawnOptions.stdio`
(`socket-fd`) and `Terminal`; [Bun process API](https://bun.sh/docs/runtime/child-process);
[Apple group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
(`killpg1` zombie filter); the macOS SDK `libproc.h` group enumeration API.
