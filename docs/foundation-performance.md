# Foundation regression and profiling

Maintained correctness checks and explicit measurements before native M4 integration.

**Scope:** Protocol framing, RPC ownership, authenticated cache reuse, packaged asset loading and renderer responsiveness.
**Status:** Descriptive local profiling. Native renderer authority and representative transport selection remain M4 work.

## Deterministic validation

```sh
bun run check:foundation
bun run check:portable
bun run check:ci:native
```

`check:foundation` selects the existing native framing, packet ownership, RPC and
stream suites together with repeated resource-accounting regressions. The new
tests run automatically through the ordinary `bun test tests` command as well.
They check released queue bytes, shared reservation bounds, cancellation,
immutable ownership after buffer transfer, bounded malformed frames, and repeated
timer/subscription/adapter teardown. The native suite adds the asset executor's
queue, retained-byte, cancellation, corruption and shutdown regressions.

These checks assert state and accounting. They contain no throughput or latency
pass threshold, and they do not infer the absence of native leaks from JavaScript
garbage collection or an arbitrary heap snapshot.

## Portable profiling

```sh
bun run profile:foundation
bun run profile:foundation --samples 15 --warmups 2 --output .bunly/profiles/foundation-local.json
bun run profile:foundation:cpu
```

Use the pinned Bun 1.4.3. The CPU command asks Bun to write both machine-readable
and Markdown CPU profiles into `.bunly/profiles`; the measured program runs in
Bun. CPU profiling changes timing, so compare runs with equivalent options.

The maintained workload parameters come from the previous foundation audits:

| Workload                      | Measured operation                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Native sequential round trips | 512 requests through an in-process native protocol peer                                                     |
| Native coalesced messages     | 4,096 ordered title events in 16 KiB chunks                                                                 |
| Fragmented UTF-8 messages     | Eight large Unicode frames in 64-byte chunks                                                                |
| Structured RPC decode         | 256 packets containing 128 records each                                                                     |
| RPC control decode            | 4,096 small control results                                                                                 |
| Authenticated cache reuse     | An actual shared cache lease and full verification of a synthetic signed inventory containing a 64 MiB file |

No downloaded runtime or native browser is used in this lane. The synthetic
cache contains inert fixture bytes, and its fetcher fails if a download is
attempted. Setup and signing the fixture inventory occur outside the timed work.
This preserves the earlier audit workloads as reproducible commands without
modifying historical evidence.

Default reports have unique filenames under `.bunly/profiles`. An explicit
`--output` must be a new path, so rerunning a profile cannot replace a failed
report. Source fingerprints are compared before and after measurement.

Every report includes the source revision/cleanliness, source hashes, Bun and
platform information, workload parameters and raw measured samples. Workload
order is shuffled with a fixed seed within each repetition. Reports retain
median, p90, p95, p99, range, standard deviation and the existing benchmark
library's deterministic percentile-bootstrap **mean** 95% interval. The interval
describes uncertainty within the collected run; it does not account for all
thermal, machine, operating-system or background-load differences.

## Actual native profiling

Start with an already assembled prebuilt runtime on the matching platform. On
macOS pass the `.app`; on Windows or Linux pass the host executable inside its
complete installed runtime directory. Set `PYTHON` to the existing contributor
interpreter with the process-observer dependencies installed.

```sh
bun run profile:foundation:native --app /absolute/path/to/Bunly.app --samples 5 --warmups 1
```

The runner copies the supplied runtime into a fresh private profiling directory.
It bundles a dedicated TypeScript backend and a public renderer fixture, writes
the hashed asset inventory and, on macOS, uses the existing inside-out ad-hoc
signing recipe while preserving signing metadata. It never compiles the native
host, selects a production certificate or changes the supplied app. Original and
prepared app inventories are checked for changes after execution.

Each measured launch opens a real native window and its CEF renderer. The page
first collects 32 idle synthetic-input/frame observations, then collects another
32 while four bounded request lanes perform full GET, a 4 KiB byte range, HEAD
and conditional requests against an 8 MiB packaged asset. Each response is
checked for its status, validator, byte length and applicable content. Raw request
and rendering samples remain in the report. The total request count is bounded;
the workload has a deadline, and resource/cleanup failures fail the run. Each
active input/frame sample must have a fetch/body read outstanding at both scheduling
and callback receipt; exhausting the request budget early fails the workload
instead of reporting idle frames as loaded interaction measurements. This proves
request overlap at the endpoints, not uninterrupted execution inside a native
verification worker. Full response validation also performs asynchronous
WebCrypto hashing in the renderer; request durations include those content checks
and their additional background work. Keep that fixture identical across comparisons.

The existing title-event path carries only this controlled fixture's diagnostics.
Its single result is encoded as eight integer-microsecond arrays in fixed order:
idle input/frame, active input/frame, then full/range/HEAD/conditional requests.
The first four arrays contain exactly 32 samples each, and each request array
contains 1–64 samples. Phase, schema, elapsed-time and input-count markers are
validated before reconstructing the normal report. All 384 allowed samples at
their maximum recorded duration produce a 3610-byte UTF-8 title, below the host's
existing 4096-byte limit; tests cover that bound and exact roundtrips at the
fixture's 0.001 ms precision. Oversized or incomplete messages fail. This changes
no native authority and requires no chunk sequencing or title-delivery timing
assumption.

Startup is measured from the observer's monotonic timestamp immediately before
host process creation to receipt of the controlled page's first animation-frame
marker. Observer interpreter startup is outside that interval. This is a
readiness marker, not proof of compositor presentation to a physical display.

The runner alternates paired launch conditions in seeded order:

| Condition      | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| Fresh profile  | A new private browser cache directory for every launch          |
| Reused profile | The same private cache directory, primed by at least one warmup |

These are application cache conditions. They do not evict OS file caches, clear
the user's browser data or pretend that a later launch is a disk-cold launch.
The application view uses the existing ephemeral session contract; this is not
persistent-session qualification.

Synthetic input consists of a scheduled DOM input event followed by an animation
frame callback. Its latency includes event-loop scheduling, handler delivery and
waiting for that callback. It is useful for detecting contention during verified
asset loads, but it does not establish hardware-input latency or exercise future
native input APIs.

Reports aggregate each trial's median and tail statistics across launches. They
do not pool correlated frames into thousands of supposedly independent trials.
Process observer reports retain process-tree resources and post-exit accounting.
An unclassified or stuck helper remains a failed run; no helper role string
receives a blanket exemption. Failed reports and the private fixture remain for
investigation rather than being relabeled as successful samples.

## Comparing changes

Run the same maintained command and parameters against a retained baseline and
candidate on the same machine. Preserve every attempted run and compare the raw
distributions, source identities and uncertainty before attributing a change to
the implementation. Native startup and responsiveness need actual native runs;
portable message or cache ratios cannot substitute for those measurements.

Keep timing gates out of normal validation. Use a new profile when a concrete
regression, changed hot path or qualification decision calls for one. Completing
this suite does not certify Bunly as production-ready or complete M4 security.
