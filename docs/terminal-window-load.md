# Native window-state terminal load

This separately identified `graphical-pty-window-load-v3` profile extends the
maintained two-PTY graphical workload to **foreground, inactive-visible,
hidden and minimized** windows. It is not a relabeling of the earlier
visible/hidden results, and a request to activate/minimize is never evidence
that the operating system completed that transition.

```sh
bun run qualify:terminal-window-load cef PREPARED_APP --functional
bun run qualify:terminal-window-load electron --functional
```

Every mode executes the same 700 batches per terminal, 32 numbered Unicode
records plus completion per batch, 30-second sustained phase and unchanged
source/stream/consumer budgets. The outer per-launch observation allowance is
90 seconds; operation and native teardown deadlines are unchanged. Both adapters
keep ordinary browser background throttling and graphical xterm callbacks.
The `standard` and 120-second `soak` selectors retain their original workloads.

## Evidence rather than intent

CEF operations use an opaque live window handle and native owner-thread
readback. `activateWindow` requests CEF activation and returns the actual five
boolean states; it does not promise OS focus. The native activation callback is
only a hint to re-read that exact handle. One coalesced read is outstanding per
waiter, notifications cannot create unbounded promises, and no periodic state
poll is installed. The existing 10-second transition deadline is not renewed.
Cancellation or action failure removes listeners and cancels the pending read.

A small second owned window supplies inactive-visible/background execution
without covering the load view or changing any global desktop preference.
Foreground requires `active && visible && !minimized`; background requires
`!active && visible && !minimized`. Hidden and minimized are separate native
states, even though both require an independently authenticated hidden-page
receipt. Minimized native `visible` differs by platform and is not fabricated.

Each batch verifies its renderer visibility, complete exact bytes/checksum and
consumer acknowledgment. Actual native state is recorded before admission,
at every phase boundary and after the complete output drain. Restoration must
then establish an active visible nonminimized window and an actual visible page.
A checkpoint is not continuous physical focus attestation; user focus changes
can invalidate a foreground trial. Physical input/paint latency is not measured.

The Electron addon uses actual BrowserWindow focus/minimize/restore events and
readbacks with the same mode predicates and renderer work. It retains sandbox,
context isolation, Node-disabled pages and the pinned Electron version. Its
Node-main/Bun-controller/direct-PTY topology and different Chromium version
remain explicit: no matched-engine performance ratio or native-guardian parity
is inferred from equal workload execution. Workload identity is passed explicitly
so a soak cannot be reported as a standard-profile launch.

## Maintained acceptance

The automatic/manual `full` native suite adds `terminal-load` after the original
graphical terminal/service stage and before credential fixtures. On Linux it
reuses the owned disposable Xvfb/Openbox runner, never an existing desktop.
Each of the four mode trials must pass; missing/incorrect state, omitted phase
checkpoints, late restoration, shortened output, hash mismatch, outstanding
reservation, failed process exit or native shutdown failure rejects the run.
Bounded raw workload rows are retained in the hosted report for independent
replay, not replaced by a single claimed success boolean.

This source increment still requires current-head actual platform execution and
coordinator review. Historical failures and shutdown watchdogs remain failures.
M5 #26/#27 are not closed by introducing a profile. Memory quarter trends and
latency distributions require a measured interpretation; this change introduces
no invented plateau, hard millisecond gate, release approval, or causal CEF
shutdown fix. The original functional fixture remains required for paused
consumers, cancellation/navigation, resize and bounded overload.

## Retained first-windowed execution

Source `3e4ede0` executed all four local native workloads. Foreground, hidden and
inactive-visible trials passed. Minimized completed all 700 batches per terminal,
exact bytes/checksums, actual restore and clean native shutdown, but its final
in-process snapshot retained an 85-byte RPC reply. The fixed zero-byte acceptance
correctly rejected it. Raw report/run-kAki2e remains unchanged.

The follow-up uses the reviewed native-reply drain from #119 before retiring RPC
and disposing the view; it does not add sleeps, counter polling, ignored bytes or
looser shutdown acceptance. The actual native delivery completion drives release.
All four modes require new combined-head execution after this correction.
