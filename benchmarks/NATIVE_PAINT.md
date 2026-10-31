# Native input command to paint-record observation

The Linux native input driver now observes a complete expected GPUI paint record
**while the OS input command is running**. This is a diagnostic upper bound from
input-command start to validated record observation. It is not a timestamp of OS
input delivery, GPU completion or display presentation.

The collector is shared by core, Solid and React fixtures that use the existing
driver with a complete `--expect-render` tree. It does not create another native
host, renderer, input path or process supervisor. The app still receives real
XTest input through `xdotool`; complete native state, application events,
screenshots, OS close and owned-process cleanup remain independent assertions.

## Clock and observation boundary

`measurements.native_paint_file_observation` records these boundaries using one
Python `time.monotonic_ns` clock:

1. The existing driver verifies its owned window, focuses it and captures the
   initial screenshot. Pointer geometry and movement occur before a click's
   measured interval.
2. The observer opens the evidence file and arms an inotify watch and bounded
   reader thread before input. Immediately before the **first actual input
   command**, it snapshots the eligible byte offset and records the start time.
3. The reader wakes on file events and parses complete appended JSONL records
   concurrently with input injection. It records the time after validating a
   matching nonce, window, revision and complete expected native tree.
4. The driver records when the last input command returns, then joins and closes
   the observer. The report states whether the paint was observed before that
   return, and binds the matched raw record with its SHA-256 hash.

The interval includes command/process startup, X server delivery, application and
native scheduling, GPUI paint instrumentation, log I/O, reader scheduling and
validation. For a key sequence or typed string, it also includes the offered
input schedule and any preparation between subsequent commands. It does not
provide per-keystroke latency. A final text update may paint after the type
command returns; the collector records that outcome without changing the metric.

The older `input_start_to_matching_paint_report_observed_ms` field remains a
separate coarse driver observation. It begins before the original preparation
sequence and is checked after input commands return. Startup, window discovery,
RSS and application-event checks still use the reported 100 ms polling interval.
Use the explicitly named concurrent field for the new boundary; do not combine
the two methods into one time series or call the observer change an application
speed improvement.

Native paint instrumentation runs inside GPUI's paint traversal. It does not
establish when a compositor or monitor presents the frame. The
[Linux inotify API](https://man7.org/linux/man-pages/man7/inotify.7.html) supplies
file-event readiness, not producer timestamps. It may coalesce notifications, so
notification counts are not frame or write counts.

## Bounds and failure handling

The observer accepts only a regular, non-symlink file, retains its open descriptor
and verifies that the pathname still identifies the same device/inode. It
detects observed shrinkage, replacement and changed bytes at the read boundary.
The producer must append records; this is not a signed attestation or a forensic
guarantee against an adversarial truncate-and-regrow sequence hidden between
observations. A record already in progress before input is ineligible, including
its later newline.

The limits are 4 MiB for the whole log, 65,536 UTF-8 JSON bytes per record excluding
the newline (matching the native writer), 32,768 file notifications, and the
remaining bounded fixture deadline, at most 60 seconds. No record queue grows
with the number of edits. Complete malformed JSON, duplicate fields, non-finite
numbers, foreign nonces, queue overflow, moved/deleted watches and deadline
expiration fail the observation. Boolean IDs cannot match numeric expectations.
Omitted large-tree records cannot satisfy a complete-tree expectation.

Cancellation wakes the reader through an owned pipe, joins the thread and closes
all descriptors before existing application-process cleanup. Driver and observer
source fingerprints are recorded before the scenario and checked afterward.
The native baseline also includes the observer's fingerprint. A failure in
collection never becomes a passing native-paint check.

## Verification and reproducible evidence

`tests/quality/test_native_paint_observer.py` uses real inotify descriptors and
temporary owned files. A bounded real writer process stays alive until the reader
has observed its complete record, demonstrating observation before command return.
Tests also cover partial records and the exact native byte boundary, predicates,
invalid JSON, file replacement/truncation/rewrite, log limits, real notification
budget failure, deadlines, injected input failure and SIGTERM interruption of a
separate blocked reader process. The kernel-format overflow notification decoder
has an explicit negative control; that control does not claim a real kernel-queue
saturation test. These are headless safety tests, not native rendering tests.

```sh
python3 -W error::ResourceWarning -m unittest discover \
  -s tests/quality -p 'test_native_paint_observer.py' -v
```

Actual native qualification uses the existing core and React fixtures in development
and inspected machine-code AOT modes. The
[local evidence record](../tests/native/evidence/paint-observer-linux.json) binds
the exact source, compiler, host, screenshots and raw reports. It uses a
development-profile protocol-2 host on Linux X11 with Mesa llvmpipe. The required
native workflow uses the same collector automatically with its independently
built release host; local development-host evidence must not be relabeled as that
hosted result.

For example, run the existing React click fixture inside a fresh isolated session:

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/paint-observer.XXXXXX")
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/session" -- python3 tests/native/react-window.py \
  --scenario counter-click --mode development --output "$run_dir/result" -- \
  bun examples/react-counter/main.tsx
```

Use the shared AOT helper's `react` entry and the emitted executable for the AOT
case; retain its inspection manifest. The driver's declared mode alone does not
prove AOT. Run both click and input cases when qualifying a changed harness.
These bounded observations do not establish a cross-framework ranking, a release
latency budget, physical input, hardware GPU performance or macOS/Windows support.
