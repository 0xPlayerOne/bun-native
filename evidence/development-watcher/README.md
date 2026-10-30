# macOS watcher notification-loss observation

This bounded diagnostic capture starts from source
`f2437361b8c58e1b35b8036ef5df7af1c62c1744` with only the two-file
[instrumentation patch](instrumentation.patch.gz) applied. Bun is the pinned 1.4.4.
The patch records at most 128 in-memory events and prints them only after the
existing assertion wait; it changes no write, reload, or test deadline.
[The normalized receipt](notification-loss.json) identifies its patch digest.
Only relative monotonic times, fixed event labels and fixture counters are kept.

The native-metafile case registers its external watcher, returns from startup,
and completes the controlled write. No filesystem callback or second build is
observed through the unchanged 15-second assertion window. The worker remains
at 20, with one build and one replacement. This distinguishes an undelivered
notification from a later rebuild/readiness failure in this invocation. It does
not, by itself, identify the exact upstream FSEvents scheduling instant.
The malformed-cross-drive control receives a callback and reloads to 21.

The focused instrumented file passed all 15 tests. The subsequent instrumented
whole-suite run retained 1,591 passed, three skipped and 12 failed. It omitted
the project's contributor Python selection and also had 11 other failures;
that diagnostic invocation is **not** a passing portable gate. The watcher
trace above is explicit regardless of those other outcomes. The separate,
properly configured original portable gate on PR #201 retained 1,602 passed,
three skipped and the same single watcher failure. No passing retry erases it.

The pinned Bun watcher queues stream recreation and starts a new stream using
`SinceNow`: `oven-sh/bun@38afee6c84fcf48c0edb2466aa4b27d287a59c30`,
`src/runtime/node/fs_events.rs`, lines 604–768. Its public FSWatcher contract has
no readiness acknowledgment. The application correction reconciles the bounded
known backend input graph on macOS; it does not fork Bun or claim all filesystem
notifications are reliable. The ordinary deadline and original regression remain
unchanged. Deterministic missing-notification tests separately exercise recovery,
scan bounds, stale graph rejection and cleanup.

The patch is gzip-compressed to retain byte-exact unified-diff context lines.
Decompress it before applying it to the stated baseline; it is evidence only,
not an additional change to apply to the corrected runtime.
