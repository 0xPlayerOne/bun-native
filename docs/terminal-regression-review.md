# Measured terminal regression review

The hard correctness gates remain byte/order/hash equality, authenticated native
window state, actual xterm-consumer acknowledgment, fixed admission bounds,
zero final reservations and accepted process/shutdown evidence. They run in normal
portable/native validation. They are not replaced by a favorable latency number.

For timing, CPU and sampled process-tree RSS, use repeated explicit profiling and
the separate review command:

```sh
bun run qualify:terminal-window-load cef PREPARED_APP --samples 5 --warmups 0
bun run profile:terminal:review capture REPORT.json CAPTURE.json
bun run profile:terminal:review envelope CAPTURE.json ENVELOPE.json
bun run profile:terminal:review compare BASELINE.json CANDIDATE.json REVIEW.json
```

`capture` replays every retained workload/exit/shutdown, verifies raw workload
hashes and unchanged source/artifact evidence, and recomputes metrics rather than
trusting stored claims. Only the explicit native, guarded, four-mode profile is
admitted. A failed launch, omitted mode, duplicated process observation, missing
CPU data, modified metric, incorrect ownership or incomplete output rejects the
capture. Raw reports are bounded to 512 MiB and individual workload data to 4 MiB;
outputs are exclusively created rather than silently overwritten.

A capture may describe a functional run, but an envelope or comparison requires
at least five separate measured launches **per mode**, with warmups excluded.
The fixed workload, actual engine identity, Bun version, native-owner policy,
observer environment and complete workload/profiler source hashes must agree.
Changing them requires deliberate requalification, not automatic baseline reuse.
This command does not compare different engines or imply Electron/CEF parity.

## Reference ranges, not arbitrary millisecond limits

Each mode retains per-launch control p95/p99, graphical-consumer p95/p99,
trigger-to-consumer-ack and first-PTY-callback-to-consumer-ack p95/p99, delivered bytes/s, summed process-tree CPU,
peak summed RSS and nonnegative last-quarter sustained RSS increase. The
maintained deterministic 1,000-resample percentile bootstrap computes a 95%
interval for the **mean of each per-launch metric**. It does not resample the
correlated 1,400 batch rows as independent experiments.

The baseline's measured intervals are the review envelopes. A candidate interval
entirely worse than the baseline interval is a review-required shift; throughput
has the opposite direction from latency/CPU/memory. Overlapping intervals mean
insufficient separation, not proven equivalence or absence of regression.
Favorable separation is an observation, not a causal optimization claim.

Exit status 0 means the capture/envelope is valid or the comparison found no
separated adverse shift. Status 2 means an otherwise valid comparison needs
review; status 1 means invalid/incomplete/incomparable input. The review JSON is
written before status 2. No new busy-machine latency test runs in ordinary CI,
and no comparison grants release approval or bypasses correctness gates.

## Memory interpretation

The 30-second sustained profile includes normal allocator/cache warmup; its
quarter trend is **not** plateau acceptance. Inspect the separate 120-second
`qualify:terminal-soak` data and complete raw time series. RSS may double-count
shared pages, short-lived processes can escape sampling, and rising reserved
heap can later be reclaimed by the engine. CPU uses only adjacent matching PID
and birth-identity intervals; unavailable counters are never converted to zero.
Record unresolved growth or bottlenecks explicitly rather than raising limits or
forcing garbage collection to manufacture a favorable result.

The current implementation's profile measurements are descriptive local evidence,
not quiet-machine certification, hardware input/paint latency, long-running leak
proof or a production resource guarantee. Native and baseline adapters retain
their actual engine versions and process/security topology. Historical failed
trials, including CEF watchdogs, remain failures even when later profiles pass.

## Retained evidence replay

`bun run verify:terminal-acceptance` replays the committed compressed reports,
per-batch records, exact source hashes, failed controls and derived baseline. It
starts only isolated Bun verification processes, not desktop applications. The
recorded historical commits must be available in the checkout; a shallow clone
must fetch those exact recorded commit objects first. The verifier refuses a
missing commit rather than substituting current source or silently fetching code.
Archive digests bind sanitized data; original private report hashes are preserved
separately. Fixture nonces, private paths and process IDs are explicitly redacted
with stable process pseudonyms. Counts, ordering, outcomes, birth identity
relationships, samples and failure receipts remain replayable.

Archived source fingerprints use explicit `{ path, sha256 }` records. The bounded
decoder rejects unknown encodings, duplicate/unsafe paths and changed source maps
before reconstructing the exact original maps for ordinary report validation. This
disambiguates file digests from credentials without a scanner exemption; original
raw-report hashes remain separately retained.
