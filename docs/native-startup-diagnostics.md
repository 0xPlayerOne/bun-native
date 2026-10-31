# Native first-window startup diagnostics

The opt-in startup trace records where a native request stops progressing without
changing the request deadline, scheduler, FileSink, renderer or acceptance test.
The transport default remains **5,000 ms**. The real five-window lifecycle smoke
retains its **45-second** outer ceiling and every existing assertion.

## Failure motivating the trace

The hosted release-host job [124648082336 in run 41238544825, attempt
2](https://github.com/0xPlayerOne/bun-native/actions/runs/41238544825/attempts/2)
failed with `Native open request 3 timed out` before running the added Solid
scenarios. This is the **first** open: hello is request 1 and the expected invalid
close is request 2. No previous window had been opened or closed.

The [original evidence](../tests/native/evidence/open-timeout-linux.json) retains
the exact failure log, runner/toolchain metadata, host hashes and source
comparison. The relevant native, runtime, protocol, Cargo and lifecycle sources
are identical to the earlier passing hosted commit. The first artifact had no
native phase trace or retained stderr tail, so it does not distinguish a stalled
stdin continuation, UI dispatch, window/GPU initialization or response delivery.
It does not establish a Solid regression or a close/reopen ownership defect.
The unresolved runner failure is tracked in
[#296](https://github.com/0xPlayerOne/bun-native/issues/296); adding diagnostics or
obtaining a passing rerun does not close that investigation.

In the pinned [GPUI `App::open_window`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/app.rs),
window creation, the root-view constructor and the first draw happen before the
call returns. The [X11 client](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/client.rs)
starts with an empty GPU context; [first-window creation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs)
constructs its WGPU renderer synchronously. A successful protocol hello therefore
does not by itself establish GPU readiness. This is a reason for the phase
instrumentation, not a diagnosis of the recorded failure.

## Activation and scope

Tracing requires `BUN_NATIVE_STARTUP_TRACE=1`, an absolute
`BUN_NATIVE_EVIDENCE_LOG`, and a nonempty, control-free
`BUN_NATIVE_EVIDENCE_NONCE` of at most 128 UTF-8 bytes. Without the explicit flag,
the transport adds no diagnostic file writes. The existing Linux session enables
these variables **only** for `tests/native/lifecycle.ts`, with a new nonce and
`lifecycle-events.jsonl` inside that run's owned evidence directory. Other native
scenarios and performance measurements do not inherit the startup flag.

Each JSONL diagnostic contains the nonce, source (`transport` or `native`), PID,
per-source record index, phase and request ID. `elapsed_ns` is a decimal string
from each trace writer's **process-relative monotonic clock**. Transport records
also identify their owned `host_pid`. Compare durations within the same
source/PID/host identity; the writers have different clock origins. File append order is
not a cross-process timestamp or a display-presentation measurement.

| Phase                                                  | Boundary actually observed                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_queued`                                       | The original request timer exists and its command is pending.                                                                                           |
| `stdin_write_enter` / `stdin_write_returned`           | The direct `FileSink.write` call begins/returns; this is not an OS-read acknowledgement.                                                                |
| `stdin_flush_enter` / `stdin_flushed`                  | The unchanged `FileSink.flush` call begins and its returned value/promise completes.                                                                    |
| `open_dispatched`                                      | The native foreground session enters the open handler, including rejected opens.                                                                        |
| `open_window_enter`                                    | Validated creation is about to call GPUI `open_window`.                                                                                                 |
| `root_constructor_enter` / `root_constructor_returned` | Platform window creation reached the supplied root-view constructor, which then returned.                                                               |
| `open_window_returned`                                 | GPUI window creation and its initial draw returned, successfully or with an error.                                                                      |
| `activation_returned` / `opened_submit_returned`       | Native activation and the existing `EventSink.send` call returned. This records the submission attempt, not successful queue insertion or stdout flush. |
| `response_received`                                    | The application decoded a response; original ID/type/revision validation still applies.                                                                 |
| `transport_failed` / `transport_finished`              | The original failure/teardown boundary, with the bounded stderr tail available to that reader.                                                          |

The existing renderer record occurs inside the root constructor; the existing
rendered revision-zero record establishes initial native paint traversal. These
records further localize a missing open response without adding another native
rendering or input implementation. A response may arrive before the application
observes its stdin flush promise resolve; the test does not impose a false order
between those two independent observations.

## Bounds, errors and verification

The transport records at most 256 ordinary records, including one limit marker,
plus its at-most-once failure and final teardown records. The native open trace
has a separate 256-record cap. No command payload, title or text value is logged.
The error message is bounded to 1,024 UTF-16 units; stderr uses the existing
4,096-unit tail, including the final available tail after reader cleanup. This
is diagnostic output already received from the owned child, not a claim that
every stderr byte before termination was captured.

Logging uses direct bounded append operations and adds no transport proxy,
request retry or asynchronous event queue. An append failure is reported once
and disables that writer rather than replacing the original request result.
The native lifecycle smoke also requires all seven expected native phases for
each of its five successful opens, complete transport teardown and no exhausted
trace budget. Missing evidence cannot silently qualify that diagnostic smoke.

The focused headless tests use the real runtime and an explicitly headless
subprocess peer. They verify normal direct I/O phases, disabled mode, payload
omission, a deliberately unanswered open with retained stderr, bounded trace
exhaustion, invalid nonce rejection and an unwritable log that preserves
transport behavior. These tests do not establish native window behavior.

The [final local native trace record](../tests/native/evidence/startup-trace-linux.json)
retains source hashes and both raw traces. One development run and one inspected
Bun machine-code AOT run each passed five actual GPUI window cycles, all 35
valid-open phase markers and exit zero against the same development-profile
host. Both retained the 5-second request and 45-second fixture bounds. The AOT
artifact has compiled-program metadata and 27 removed JIT ranges; its interpreter
remains present. The renderer was Mesa llvmpipe in isolated X11. These are native
diagnostic correctness checks, not release-host, input-latency or presentation
measurements. The controlled hosted run remains necessary to investigate the
original runner failure; a passing rerun alone will not explain or erase it.

The subsequent [main-integration control](../tests/native/evidence/solid-main-integration-linux.json)
uses main's newer serde, serde_json and unicode-segmentation pins with a separately
built development host. Its current-source development and inspected AOT runs
each pass the same five-window/35-marker assertions and a separate actual caret
input control. The earlier diagnostic record and raw traces remain byte-identical
to their original older-lock source. These local controls do not establish the
cause of #296 or substitute for the controlled hosted release run.

## Existing GPUI log points

The later required native job in [run 41245052851](https://github.com/0xPlayerOne/bun-native/actions/runs/41245052851)
retained hello and expected invalid-close responses, the completed open-request
flush, and native `open_dispatched` / `open_window_enter`. It timed out before
`root_constructor_enter`; stderr was empty. The first draw in GPUI's
`App::open_window` follows that constructor, so this failure precedes both the
application view constructor and that draw. The trace does not identify which
operation inside platform-window creation stalled. The GPUI log facade had no
backend; empty stderr does not prove that its logging sites were not reached.

`BUN_NATIVE_STARTUP_LOG=1` additionally installs a narrow native logger, but only
when the existing startup flag, absolute evidence path and valid nonce are also
present. It is default-off. Only the affected Linux workflow's development
first-window step enables the new flag; the session's existing startup flag is
scoped to its lifecycle subprocess, so later input cases and benchmarks do not
activate the logger. It never writes to protocol stdout and ignores `RUST_LOG`.
No upstream source or GPUI/compiler revision is changed. The host directly
depends on the same `log` 0.4.35 already present in `Cargo.lock`.

The exact Info-or-higher target allowlist is:

- `gpui_linux::linux::x11::window`: existing visual/colormap and X11 diagnostics.
- `gpui_wgpu::wgpu_context`: existing adapter enumeration, selection, device and
  surface-configuration diagnostics.
- `gpui_wgpu::wgpu_renderer`: existing renderer error and recovery diagnostics.

These are the pinned [X11 window](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs),
[WGPU context](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_wgpu/src/wgpu_context.rs)
and [renderer](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_wgpu/src/wgpu_renderer.rs)
log points, not newly inserted phase boundaries. A missing log cannot distinguish
an operation not reached from a path that does not log, truncation, an I/O failure
or exhausted capture. GPU selection precedes synchronous pipeline creation and
does not establish a completed window or frame.

Records use `stage: "startup-log"`, `source: "native-log"`, a separate logger
clock origin, process ID, index, target, level and source line. Installation
records declare the allowlist and limits. The logger writes at most **64 records,
2,048 bytes per JSONL line and 65,536 bytes total**, reserving space for one
explicit record/byte-limit marker. Message formatting stops at 512 UTF-8 bytes;
truncation and formatting errors are explicit. If JSON escaping exceeds the line
budget, the message is replaced by an explicit omission. No command, window
title, input value or application object is added by this backend.

When enabled, the logger serializes selected records under a mutex and performs
synchronous bounded file appends/flushes. Its formatting, locking and filesystem
work can perturb startup; the record/byte bounds are not a filesystem latency
guarantee. The facade's Info level is enabled globally while the backend rejects
other targets before message formatting. These runs are diagnostic controls,
not uninstrumented startup/performance measurements. Disabled mode installs no
backend or file handle. Registration/open/write failures produce one bounded
stderr notice per failed setup or writer and leave the native protocol,
5-second request deadline, immediate failure cleanup and renderer unchanged.

Focused native unit controls cover opt-in configuration, exact target/level
filtering, UTF-8 truncation, JSON expansion, total/record budgets and failed
formatting/writes. The opt-in Linux lifecycle fixture additionally requires the
installation record and actual X11 visual / selected-GPU records after its
unchanged five successful window cycles. A passing diagnostic run does not
explain the historical stall or close #296.
