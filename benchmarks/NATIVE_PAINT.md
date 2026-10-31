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
with the number of edits. Watcher setup, input preparation and measurement start
retain the original absolute deadline; they cannot restart its remaining interval.
Complete malformed JSON, duplicate fields, non-finite
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
invalid JSON (including overflowing numeric exponents), file
replacement/truncation/rewrite, log limits, real notification budget failure,
deadlines, injected input failure and SIGTERM interruption of a
separate blocked reader process. The kernel-format overflow notification decoder
has an explicit negative control; that control does not claim a real kernel-queue
saturation test. These are headless safety tests, not native rendering tests.
The fixed-clock deadline regression rejects expiry before input starts and a
complete matching record received after the original deadline. Both controls
failed against the earlier interval-restarting implementation.

```sh
python3 -W error::ResourceWarning -m unittest discover \
  -s tests/quality -p 'test_native_paint_observer.py' -v
```

The [original local evidence record](../tests/native/evidence/paint-observer-linux.json)
binds eight core and React cases to their exact source, compiler, host,
screenshots and raw reports. It uses a development-profile protocol-2 host on
Linux X11 with Mesa llvmpipe. This historical record remains unchanged; it does
not qualify later protocol or framework build changes. The required native
workflow uses the same collector automatically with its independently built
release host. Local development-host evidence must not be relabeled as that
hosted result.

The [protocol-4 qualification](../tests/native/evidence/paint-observer-protocol4-linux.json)
adds 12 cases on the current combined core, Solid and React source: one click and
one complete text-input case per adapter in development and AOT execution. All
passed on their first execution with the same prebuilt development-profile GPUI
host, Linux X11 and Mesa llvmpipe. The record binds 84 source and harness files,
the three inspected AOT executables, generated framework modules, native build
inputs, matched raw paint records, screenshots and cleanup results. The Solid
and React source maps establish production framework distribution selection in
both execution modes.

All six click paints were observed before the corresponding input command
returned: the observed intervals were 16.41–49.55 ms, while command returns were
104.66–111.53 ms. Five of the six text cases completed their final paint after
the input command returned. That outcome remains in the record; the collector
does not require an artificially early paint. These single cases qualify the
measurement boundary and exact native behavior, not adapter performance: the
core and framework fixtures have different trees and no repeated matched
comparison was run. All 12 application processes exited normally, no observed
descendants remained running or unreaped, and every observer stopped with zero
open descriptors.

The 63-test native harness safety suite passed with resource warnings treated
as errors. Two retained negative controls identify corrections to the original
collector: JSON exponents overflowing to infinity now fail, and preparation can
no longer restart the fixture's original remaining deadline. Neither correction
changes application acceptance or increases a timeout.

For example, run the existing React click fixture inside a fresh isolated session:

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
package_dir=$(mktemp -d "$PWD/.bun-native/paint-package.XXXXXX")
bun experiments/aot-gpui/build-window.ts --entry react --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir "$package_dir"
run_dir=$(mktemp -d "$PWD/.bun-native/paint-observer.XXXXXX")
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/session" -- python3 tests/native/react-window.py \
  --scenario counter-click --mode development --output "$run_dir/result" -- \
  bun "$package_dir/development/application.js"
```

For the AOT case, use `--mode aot` and the emitted `$package_dir/react` executable
instead. The common recipe selects production framework distributions and uses
the same generated application module for both Bun development execution and
machine-code AOT compilation. Retain its inspection manifest and module hash;
the driver's declared mode alone does not prove AOT. Run both click and input
cases when qualifying a changed harness.
These bounded observations do not establish a cross-framework ranking, a release
latency budget, physical input, hardware GPU performance or macOS/Windows support.
