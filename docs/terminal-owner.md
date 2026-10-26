# Native desktop terminal ownership

Issue #25; draft #117. This implements the desktop owner path and its declared
non-detaching profile. M5 completion still requires current-source acceptance on
all three platforms and the separate restart/backoff and CEF shutdown work.
Historical Mac/Linux runs at `5ee4ff8` qualify only the previous opt-in protocol.

## Desktop integration and artifact identity

Trusted Bun application code uses:

```ts
const terminals = await backend.createTerminalService({ profile: 'non-detaching' })
```

`CefBackend.createTerminalDriver({ profile: 'non-detaching' })` supports runtime
instrumentation such as the real graphical terminal fixture. Both factories take
configuration from the native host's private readiness pipe. No renderer request
chooses an owner executable, descriptor, process identity or Job. The browser-only
package boundaries remain enforced. The generic `BunTerminalDriver` and generic
`TerminalService` default remain direct-child tools, explicitly **not** desktop
descendant supervision. `NativeTerminalDriver` is a low-level trusted-backend API;
its configuration is not a renderer authorization token.

The contributor native build produces `bunly-terminal-owner` (`.exe` on Windows).
`bunly-bundle` copies the matching prebuilt binary beside the native host. Its
`terminal-owner.json` records native package version, protocol 2, OS, CPU, byte
length and SHA-256. On macOS the metadata lives in `Contents/Resources`, not the
`Contents/MacOS` code directory; Linux/Windows keep it beside the executable. The native
host verifies discovery and identity before startup and again before starting Bun.
The driver verifies the captured digest before each spawn. macOS contributor
assembly signs this executable ad hoc before hashing it. Existing authenticated
whole-runtime artifact inventories cover both files; the adjacent digest is an
integrity check, not a replacement signature trust root. The cache/private-user
same-user mutation threat boundary is unchanged.

Missing, wrong-platform, wrong-protocol or modified owner artifacts fail closed.
Neither the application build nor runtime compiles or downloads a fallback.
The graphical terminal fixture now exercises this native driver.

## Unix ownership and host loss

Pinned Bun 1.4.3 owns PTY creation and reaping of the executable passed to
`Bun.spawn`. Its API cannot adopt a native-created PTY or transfer the child's wait
identity. Registering a numeric PID afterward races reaping, especially on macOS.
Therefore one bounded native guard per admitted PTY retains the real command's
parent/wait identity. It starts that command in a separate foreground group and
stays outside it. The runtime admits at most 64 guards per JS isolate across
services, in addition to TerminalService reservations. Each Unix guard uses one
blocking exit watcher; Windows uses overlapped I/O and process/event handles.
This is a documented process-cost exception, not a performance claim.

The GUI creates a fresh socketpair generation before spawning Bun. Only the GUI
retains the writer peer, which is CLOEXEC; only the reader peer is inherited into
Bun and then explicitly mapped into guard fd 4. Guard fd 3 is a separate private
Bun-owned per-terminal lease. Both are CLOEXEC before application commands start.
EOF on **either** lifetime stops the exact retained command group. Normal native
quit revokes the GUI peer before existing backend stop; hard GUI death closes it
in the kernel even while Bun remains alive or synchronously hung. There is no
registration gap after Bun reaping and no PID-bearing cleanup message.

Before every group signal, `waitid(WNOWAIT)` proves the leader remains an unreaped
child. Final SIGKILL precedes reaping, keeping the group identity reserved. Darwin's
zombie-only EPERM exception requires a bounded kernel query proving the only
member is the retained zombie; other denials stay failures. TERM has the existing
absolute two-second grace period. Lease loss and KILL clean immediately. Signal
validation is identical to TerminalService's Unix allowlist before any wire write.

## Windows Jobs and ConPTY

The existing GUI-owned kill-on-close Job is assigned to Bun before application
code. That outer Job is unchanged. The guard requires Job membership, then uses
`CreateProcessW(CREATE_SUSPENDED)`, assigns the returned **owned process handle**
to a new private kill-on-close terminal Job, and resumes its initial thread only
after assignment succeeds. Failure before assignment terminates the still-suspended
owned process; no user code runs in that gap. The guard is outside the terminal
Job but inside the GUI's outer Job. Closing one terminal targets its Job, not the
Bun process or an arbitrary numeric PID. Natural command exit also terminates
remaining members before reporting exit. Guard loss closes its terminal Job;
GUI loss closes the outer Job, including Bun and all nested terminal work.

Bun documents `socket-fd` caller ownership as POSIX-only; on Windows it behaves
like `pipe`, whose descriptor lifetime Bun owns. The Windows driver therefore
uses a fresh private per-terminal named-pipe connection instead of wrapping and
closing a Bun-owned CRT descriptor. Its random endpoint is backend-generated,
never renderer-supplied or logged, and removed from the command environment. It
is a lifetime/control channel, never process-identity registration. Native
non-inheritable pipe/Job handles prevent commands retaining either lease. Buffered
control writes are capped at 4 KiB. Windows TERM/KILL request immediate terminal
Job termination; arbitrary POSIX signals and a claim of graceful POSIX TERM
semantics are unsupported. Actual Windows standard-user execution is required;
cross-target checks do not establish ConPTY inheritance or cleanup.

## Protocol and failure accounting

Protocol 2 begins with `BTO` and byte 2. Only after matching it does Bun send
admission byte zero. The guard validates bounded argv (including valid empty
arguments), observes a live host lifetime, and launches. Ready is `[1]`; exit is
`[2, kind, u32le]`; owned failure is `[3, reason]`; attested failure before any
command was created is `[4, reason]`. Reason 1 is denial, 2 is supervision failure.
No command path, PID or endpoint arrives from renderer IPC.

Admission/readiness has an absolute five-second maximum, bounded further by the
service's spawn timeout and abort lifetime. Before admission, failure may kill
only the owned guard because it cannot have launched user work. After admission,
failure closes the lease and retains unknown ownership; it never kills a Unix
guard as a substitute for cleanup. Malformed, late, excessive or incomplete
receipts fail closed. Exact no-command receipts plus observed guard exit release
owner capacity. Unknown ownership retains both native and service reservations.
I/O errors and throwing observers produce fixed failures without an unhandled
promise rejection. PTY closure, command exit and acknowledged output drain remain
separate. No retries, restart policy or input replay are added here.

## Unsupported boundaries

- Unix descendants that leave the retained group through `setsid`/`setpgid`,
  including interactive-shell job-control groups, are not contained. Selecting
  `non-detaching` is mandatory; it does not advertise unrestricted shell containment.
- Unix guardian SIGKILL/crash cannot guarantee cleanup. The real qualifier records
  its observed outcome separately as unsupported, including any harness cleanup;
  an individual hangup-sensitive success does not establish universal containment.
- OS-denied termination, changed credentials and uninterruptible kernel work can
  prevent cleanup. Failure is not fabricated process exit. No privilege escalation,
  foreign-group signal, process-name scan or fallback cleanup is attempted.
- Managed replacement/adoption is M6; positive restart/backoff belongs to the
  separate service-supervisor work. This patch does not change CEF shutdown deadlines
  or claim a causal fix for CEF teardown intermittency.

## Qualification and provenance

The contributor-only `bunly-terminal-fixture-host` uses the same Unix lifetime
constructor as the GUI and the same Windows pre-application Job assignment pattern.
It runs the pinned Bun with a real shell and loopback server grandchild, while an
independent identical shell/server stays alive. Cases cover natural nonzero exit
and 8 KiB trailing output, close, cancellation, normal/SIGKILL Bun loss,
normal/hard native-host loss with Bun hung, and guardian loss. Empty argv and
private descriptor non-inheritance are checked. Exact process creation identities
are captured before signals in a private ignored ledger; public reports contain
no PIDs, ports, private paths or pipe names. Cleanup failures are failed results.

Receipt reads use bounded exact-byte framing and an absolute monotonic deadline;
partial data and stderr cannot block indefinitely. Reports include clean source
state before/after, tracked-source fingerprints and input owner/fixture binary
hashes before/after. Dirty or changed source cannot produce acceptance.

`hosted_cef.py run` executes the actual packaged owner before the unchanged eight
full CEF/provider stages. Automatic and manual paths share it, including the
Windows disposable standard-user gate. No personal credential-provider test is
part of the standalone fixture. Current-head hosted receipts remain a merge gate.

Design references, no source copied:
[Bun stdio ownership](https://bun.sh/reference/bun/Spawn/BaseOptions/stdio),
[Bun Terminal](https://bun.sh/reference/bun/Terminal),
[Microsoft Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects).
The local pinned `net.Socket({fd})` discriminator returned `ERR_SOCKET_CLOSED` on
write; the Unix driver retains the proven Bun fd-stream path. Failed fixture and
API trials are preserved in ignored `.bunly/supervision-evidence/`.

## Retained platform acceptance corrections

The protocol-2 hosted Mac build failed signing because an unsigned JSON manifest
was placed in the bundle executable directory. A fresh private copy reproduced
codesign rejecting `terminal-owner.json` as an unsigned code subcomponent. The
manifest now belongs to Resources on macOS; binary identity checks are unchanged.

The first Windows owner qualifier failed before any process ancestry receipt,
including its independent control shell. Its command combined Python CRT argument
quoting with cmd.exe command-string quoting. A fixed repository batch fixture now
launches the same Python descendant and preserves the empty argument and exit
status; a private explicit environment selects the existing Python executable.
Readiness diagnostics distinguish independent shell, native-owned shell and
lifecycle stages. This correction still requires actual Windows execution; a
startup failure is not a descendant-cleanup pass.

## Terminal-screen readiness receipts

The ownership fixture now consumes PTY output through the existing pinned
xterm-headless parser before interpreting its bounded readiness record or the
8-KiB trailing-output marker. Windows ConPTY output is a terminal stream, not
newline-delimited JSON: terminal setup, cursor repaint and line wrapping may
surround or split records. The independent non-PTY shell keeps its plain JSON
receipt. This changes only contributor evidence, not the native ownership
protocol or application output.

A fixed base64 frame survives terminal wrapping; readiness is emitted only after
actual parser completion. The parser rejects duplicate displayed records and
more than 128 KiB of callback output. Regression tests exercise split control
sequences, wrapping, incomplete records and the exact trailing-output length.
The earlier Windows native-owned-shell readiness failures remain recorded;
current Windows execution is required before attributing recovery to this change.

The next Windows checkpoint (`40271070165`) reached every normal lifecycle after
the parser correction, preserving eight failed outcomes rather than treating
readiness as full acceptance. It exposed additional fixture-specific assumptions:
console-mode Python expects carriage-return Enter, pinned psutil 7.0.0 injects
TerminateProcess with SIGTERM (15), and a 200-ms TCP connect timeout does not
establish an open or closed Windows listener. The fixture now uses the correct
Enter byte and exact injector-specific status. Windows port cleanup requires an
OS TCP-table snapshot with the owned listener absent **and the independently
owned control listener positively present**. Before cleanup that same provider
must identify both exact server PIDs. Unavailable/malformed/overfull observations
fail; a timeout is never relabeled successful cleanup. Ordinary process identity,
Job/group ownership and deadlines remain unchanged.

Reference semantics: Microsoft `GetConsoleMode` documents `ENABLE_LINE_INPUT`
returning on carriage return. Pinned psutil source is
`giampaolo/psutil@release-7.0.0`, `psutil/arch/windows/proc.c`; its kill operation
calls `TerminateProcess(hProcess, SIGTERM)`. No upstream implementation is copied.

Windows checkpoint `40272832729` passed all nine native ownership cases after the
terminal-consumption, console-input, exact-exit-status and TCP-table corrections.
The full run remained failed because its separate renderer-fault stage did not
observe the intended view's termination; provider setup correctly did not run.
A Windows-only synthetic Python test also required an explicit counterfactual
SIGKILL constant when simulating Unix. Both failures are retained. The current
fault-target binding is documented in [fault qualification](cef-fault-qualification.md);
current integrated-head platform acceptance is still required before merge.
