# Native OS-close diagnostics

[Issue #358](https://github.com/0xPlayerOne/bun-native/issues/358) tracks the
public-core AOT lifecycle failure preserved in
[the original evidence summary](../../tests/native/evidence/public-lifecycle-aot-close-timeout.json).
The hosted application completed all 1,000 cycles and the full native paint at
revision 3002, then did not exit within the existing five-second OS-close wait.
The same-run development case and saved main AOT case exited about 36 ms after
their close requests. Those separate passes do not identify the failure's cause
or clear its failed gate.

The original artifact contains no native close or public shutdown phase records.
Source review found independent native-event ingestion and cancellation of
unresolved callbacks; it did not establish a callback deadlock. The observations
below locate a future failure without changing the close operation.

## Existing boundaries that now leave evidence

The existing `BUN_NATIVE_EVIDENCE_LOG` and `BUN_NATIVE_EVIDENCE_NONCE` opt-in
enables these records. The Linux driver already supplies both variables in its
owned evidence directory.

| Observation                                                | What it establishes                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os_close_requested_ms` and `os_close_command_returned_ms` | The driver invoked Alt+F4 and the xdotool command returned. These do not establish WM delivery.                                                                                    |
| `native_close_requested`, stage `native-lifecycle`         | GPUI received the window manager's close request (`WM_DELETE_WINDOW` on X11) for an owned window. The callback still allows the close. It does not establish who sent the request. |
| `native_window_closed`, stage `native-lifecycle`           | The host's existing GPUI window-closed callback reached its evidence hook. It does not establish protocol transmission or receipt, and does not identify who requested close.      |
| `waiting_for_os_close`                                     | The public fixture completed its workload and reached the deliberately unresolved callback.                                                                                        |
| `launch_callback_aborted`                                  | The existing listener's cancellation signal fired. An abort alone does not identify OS close as its cause.                                                                         |
| `public_window_closed`                                     | The fixture's existing `window.closed` await resolved.                                                                                                                             |
| `shutdown_requested` / `shutdown_resolved`                 | The fixture entered and returned from its existing `app.shutdown()` call.                                                                                                          |
| `application_closed`                                       | Its existing `app.closed` await resolved.                                                                                                                                          |
| `final_report_ready`                                       | The fixture constructed its final report; the following report write may still fail.                                                                                               |

Fixture phase records include the seven scalar public ownership counters. They
retain no nodes, callbacks, windows or application work. There are seven fixed
record sites, with no polling or new event subscriptions. Diagnostic write
errors do not replace the original lifecycle outcome.

Native records reuse the existing maximum 65,536-byte record writer, one record
per close request and per window-closed callback. With `BUN_NATIVE_POINTER_TRACE=1`
the host also records up to 64 `key_trace` records for key downs that GPUI
received with Control, Alt or the platform modifier; plain typing is never
recorded. The driver retains its 4 MiB event-log
limit. Fixture records share its existing 1 MiB application-evidence limit.
The driver's result includes at most 32 close-phase records
(`native_close_requested`, `native_window_closed`, `lifecycle_phase` and
`key_trace`) in `close_diagnostics.phases` and marks truncation in
`phases_truncated`; the original JSONL file remains available.

## One observation after the close decision

After the unchanged five-second wait determines the existing close result, the
driver makes one read-only `xdotool getwindowpid` query for the previously owned
X11 window ID and records a read-only snapshot of previously observed process
identities before cleanup. The snapshot includes only PID/start-ticks matches;
missing and reused PIDs are listed separately. It never discovers new descendants
or extends cleanup ownership after the root process may have exited. The query uses
the driver's existing three-second subprocess bound and is reaped by
`subprocess.run`, including on timeout. It never sends another close command,
retries the application, or grants additional time to satisfy the close gate.

The observation distinguishes an existing window whose PID and process start
ticks still match, a foreign owner, an unverified owner, and an explicit X11
`BadWindow` response. Display connection errors, missing PID properties,
malformed responses and query timeouts remain `unknown`. Window IDs and PID
properties are observations at that instant; they do not prove the history of
WM message delivery or exclude window-ID reuse by the same process. No action
is taken against a foreign or unverified owner. Existing identity-checked
process cleanup remains authoritative.

Each clock's origin is explicit: driver start, fixture initialization, or native
evidence initialization. Timestamps describe observation, not OS delivery or
display presentation. Correlate records using nonce, process and window
identities and phase order; do not subtract timestamps from different clocks.

The 45-second fixture deadline, five-second close wait, native request timeout,
workload, GC checkpoints, paint assertions and zero-resource checks remain
unchanged. These diagnostics do not resolve #358. Completion still requires
capturing and explaining a failure, fixing the responsible path, and passing
the unchanged real development/AOT lifecycle gates.
