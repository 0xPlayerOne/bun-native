# Pre-M4 foundation pass

Bounded native asset work, lifecycle qualification, and maintained regression checks.

**Baseline:** Merged PR #87, `bdf9c9e10fa4d30a43931aee794186c09e83bcf1`.
**Scope:** Packaged resource loading and qualification before native M4 renderer authority.
**Validation checkpoint:** Clean source `a3e6ee0e8f1065889980c90e0d5111d878ff05a8`, 2026-10-22.
**Status:** Local test suites and the four-case macOS helper qualification pass.
The full native profile still fails the CEF shutdown watchdog; native qualification remains incomplete.
PR #89 has since merged; see the [current shutdown investigation](cef-shutdown-investigation.md)
for the subsequent control run, NetworkService captures and open acceptance work.
The October 23 retry confirmed the five recorded probe process IDs were absent
and resumed bounded diagnostics. The native shutdown failure remains unresolved.

At the historical checkpoints below, PR #89 was a draft. The billing-pause
flag was true and checked hosted jobs were skipped. After the 17:14:19Z push,
the repository variable changed to `CI_BILLING_PAUSED=false`, with an update
timestamp of 2026-10-22T17:14:38Z; this pass did not change that setting. The
kernel run still reported `in_progress`, but its only job was completed and
skipped, with no assigned runner. Existing draft-PR guards also exclude the
native/custom and validation jobs. Branch pushes can still run the lightweight
draft-PR metadata workflow. The skipped jobs provide no hosted execution
acceptance. The
[local evidence record](../evidence/pre-m4-foundation-local.json) preserves source
checkpoints, exact native binary identities, measurements, validation outcomes and
earlier failures. The profiler signs its own private app copy, so its executable
hash is recorded separately from the supplied native bundle.

## Native packaged assets

Asset creation now builds a bounded response plan. Two background workers perform
file verification, and a deferred CEF continuation releases the response only after
the complete installed file matches its manifest hash. Full GET retains its verified
body; ranges retain only the requested bytes; HEAD and 304 retain no body. Each
worker reuses a 64 KiB verification buffer.

Admission is bounded across concurrent requests: 64 requests, 64 MiB of retained
body reservations, and a separate 64 pending-continuation limit. Queued cancellation
removes work immediately; running work remains charged until its actual allocation
is released. Shutdown fences callbacks and joins workers before CEF shutdown, with
a guard covering early startup errors. The CEF wrappers delegate to ordinary Rust
functions. See [native assets](native-assets.md) for invariants and precise limits.

Actual CEF execution also exposed existing Range and HEAD adapter defects. CEF
applies its own range handling before response headers; applying that to an
already selected response body could fail or produce the wrong range length.
The adapter now retains the original validated response plan while normalizing
the internal range used by CEF for that selected body. HEAD preserves the full
representation's `Content-Length` while returning an empty body. A maintained
nine-case native gate checks nonzero, clipped, suffix, unsatisfiable and multiple
ranges; matching and mismatching `If-Range`; HEAD with a range; and a matching
conditional request with a range. Full-file verification still precedes every
successful response, including HEAD and 304.

### Native SHA measurement

The native host enables the upstream `sha2` 0.10.9 `asm` feature on macOS arm64.
This changes the SHA implementation used by the Rust host, without removing any
file verification. It does not change the Bun authenticated-cache implementation.

The controlled experiment used a Rust 1.91 release build on the M2 Max, hashing
8 MiB of byte value 81 in 64 KiB chunks. Each process run had two warmups and
20 measured hashes. The order was software, accelerated, accelerated, software;
Python `hashlib` independently reproduced the expected SHA-256 digest.

| Process run | SHA implementation | Mean hash time | Median hash time |
| ----------- | ------------------ | -------------- | ---------------- |
| 1           | Software           | 41.495 ms      | 40.454 ms        |
| 2           | Accelerated        | 6.326 ms       | 6.233 ms         |
| 3           | Accelerated        | 6.381 ms       | 6.290 ms         |
| 4           | Software           | 42.495 ms      | 42.190 ms        |

The equal-run means are 41.995 ms and 6.353 ms: 84.9% less elapsed hash time,
or 6.61 times the throughput for this fixed hashing workload. These are
in-memory hash measurements, with no file I/O, CEF, rendering, startup or
shutdown measurement. They establish no desktop speedup. There are only two
process runs per variant; the 20 serial samples within each run are not
independent application trials. Raw samples and run order are retained
without presenting a pooled 40-sample confidence interval as between-run
uncertainty.

## macOS helper lifecycle

The observer keeps the ordinary 500 ms descendant grace. A separate three-second
cleanup window requires the exact owned helper executable and full hash, fresh
process identity, and a private clone independently bound to the launched host.
The last-sample race is covered by a bounded same-user libproc inventory using the
kernel's retained original-parent unique ID. Process role text cannot establish
ownership. Completion requires both helper exit and removal of the exact clone.

Before launching the host, the observer snapshots at most 256 namespace entries.
Every preexisting name remains excluded from that launch, even if its directory
disappears and the suffix is reused. A stale clone sharing the main executable's
inode cannot become evidence for a new run. Discovery continues after the first
new clone, retains each directory identity, and bounds both current and cumulative
inventories. Old clones and their failure records are neither deleted nor credited
to current completion.

The maintained qualifier runs prompt and deliberately delayed cleanup for retained
baseline and current apps, with every attempt preserved. Policy tests reject stuck,
substituted, foreign and misidentified helpers; post-exit resources remain visible.
The corrected four-case qualifier passed all four combinations on their first
attempts, including exact helper ownership, exit and clone removal:

| App      | Cleanup case | Observed held interval | Cleanup elapsed after observed root exit |
| -------- | ------------ | ---------------------- | ---------------------------------------- |
| Baseline | Prompt       | None                   | 779.170 ms                               |
| Baseline | Delayed      | 757.647 ms             | 831.298 ms                               |
| Current  | Prompt       | None                   | 757.037 ms                               |
| Current  | Delayed      | 756.032 ms             | 815.676 ms                               |

The delayed injector suspends only the verified helper after completed root exit
and reparenting. The held intervals are measured suspension times, not claims of
that much additional cleanup latency: Chromium's polling sleep can elapse while
the process is stopped. Earlier failed injections, stale-clone observations and
native failures remain failure evidence. See [macOS clone cleanup](macos-clone-cleanup.md)
for the proof and accounting limits. This successful helper matrix does not resolve
the separate CEF shutdown watchdog failure.

## Maintained regression commands

`bun run check:foundation` exercises deterministic ownership, queue and reservation
bounds, cancellation and malformed input. Its 133 tests also run within normal
validation. The latest local checkpoint recorded these successful test invocations:

| Suite                             | Passing tests |
| --------------------------------- | ------------- |
| Bun tests                         | 571           |
| Python tests                      | 199           |
| Selected foundation tests         | 133           |
| CEF Rust tests                    | 67            |
| SHA regressions with `force-soft` | 2             |

The selected foundation suite overlaps the ordinary Bun suite. The two
`force-soft` executions repeat CEF digest regression cases under the software
implementation. These counts must not be added as independent coverage. Python
and Rust supply native lifecycle and resource-invariant checks. Test counts do
not establish native acceptance or release quality.

`bun run profile:foundation` preserves the message, structured RPC and cache
workloads with raw observations, seeded order and distribution summaries.
`bun run profile:foundation:cpu` adds Bun's machine-readable and Markdown CPU
profiles. `bun run profile:foundation:native --app PATH` measures a real prepared
CEF app under concurrent full, range, HEAD and conditional asset requests, including
fresh/reused profile startup and idle/active synthetic input-to-frame observations.
See [foundation performance](foundation-performance.md) for the methodology.

The preserved portable profile used Bun (version redacted) and clean source
`dcd204b4c42e161ffe5ba158f2cc287633727eb6`, with 15 measured samples and two
warmups. All six workloads passed. Full verification of the synthetic 64 MiB
cache had a 313.634 ms mean and a bootstrap mean 95% interval of
292.298–333.119 ms. The 256-packet structured RPC decode workload had a
38.863 ms mean and an interval of 36.075–42.328 ms. These are whole-workload
timings including correctness checks, not desktop measurements. The earlier
unpinned Bun 1.4.4 run remains separate diagnostic evidence. The separately
instrumented CPU profile is retained without comparing its timings to the
uninstrumented run. Neither portable result is a before-and-after comparison
for the native Rust SHA feature.

### Native qualification and shutdown diagnostics

The evidence checkpoint contains eleven native profiling invocations: six retained
qualification records and five instrumented diagnostic records. Together they
contain fifteen app-launch attempts and two preparation failures. All eleven
invocations failed to complete their planned profiling run. The table uses the
suffix of each `foundation-native-*.json` record:

| Record              | Retained app launches | Outcome                                                                                                                                                    |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current-1`         | 0                     | Preparation failed because the supplied fixture lacked backend resources.                                                                                  |
| `current-2`         | 1                     | First warmup failed; watchdog exit 2 was observed.                                                                                                         |
| `current-3`         | 1                     | First warmup failed; watchdog exit 2 was observed.                                                                                                         |
| `baseline-1`        | 1                     | First warmup failed; watchdog exit 2 was observed.                                                                                                         |
| `current-4`         | 1                     | Asset and interaction checks completed; CEF shutdown reached the watchdog.                                                                                 |
| `current-5`         | 2                     | First warmup exited cleanly; second completed the workload and reached the watchdog.                                                                       |
| `sampled-1`         | 5                     | Four app launches exited cleanly; the fifth completed the workload and reached the watchdog.                                                               |
| `network-sampled-1` | 0                     | Preparation failed without a signing-observer report; no app trial occurred.                                                                               |
| `network-sampled-2` | 1                     | First warmup completed the workload and reached the watchdog.                                                                                              |
| `combined-1`        | 2                     | Fresh-profile warmup exited cleanly; reused-profile warmup completed the workload and reached the watchdog. Both late root captures had empty callgraphs.  |
| `crashpad-1`        | 1                     | First warmup completed the workload and reached the watchdog. A local minidump identifies the final thread-pool wait; post-exit clone cleanup also failed. |

Completed workloads in these later records include the four asset lanes, all nine
response-semantics checks and all 32 active input observations with the required
request overlap. An individual clean exit does not complete the full profiling
run. The `sampled-1` diagnostic recorded completed CEF shutdown phases of 4.060,
7.692, 8.182 and 9.853 seconds before its fifth launch failed. Those are observed
durations under instrumentation, not an accepted performance distribution or
evidence that sampling caused the delays. Earlier baseline and candidate range
failures remain recorded and cannot serve as comparable native performance
baselines.

Captured host addresses, matching module disassembly and version-pinned source
identify `BrowserProcessIOThread::ProcessHostCleanUp` waiting for the
`network.mojom.NetworkService` utility process, with a configured ten-second
timeout. This is an inference from the combined evidence; nearby exported symbol
names alone do not identify the exact function. It identifies the wait at
capture time; it does not establish that the wait occupied the entire watchdog
interval or explain why the utility had not completed. In `network-sampled-2`,
the sampling utility returned exit code zero but produced an image inventory
without a call graph. That capture supplies no usable child stack. These
diagnostics leave the shutdown cause unresolved.

The final `combined-1` diagnostic retained two network-thread snapshots during
the successful fresh-profile warmup and nine during the failed reused-profile
warmup. The successful CEF shutdown phase took 6.605 seconds under instrumentation.
The failed warmup's snapshots began 1.011–5.003 seconds after the observed CEF
shutdown start and contained the same 14 thread identities. All 112 comparable
adjacent per-thread CPU deltas were zero. The named network main thread and six
foreground workers reported a waiting state at each snapshot. These are bounded
counter and state observations, not proof of zero process work or a particular
blocked operation. All nine collections finished before the late root sampler
began at 6.027 seconds; no child sampler was launched.

Subsequent metadata collection stopped because verified network identity was no
longer available. That condition combines disappearance, ownership and executable
mismatch; it does not independently attest an exit time. Both late root samples
returned exit code zero and matched the expected target headers, but contained
zero thread rows and zero frame rows. Neither supplies a usable late shutdown
stack. The public record retains artifact lengths and hashes, aggregate thread
observations and these limitations while omitting process identities and unique
thread IDs.

The combined diagnostic records its source checkout as dirty before and after
the run because the evidence JSON was untracked. Its fingerprinted harness files
were unchanged. The supplied native app still comes from the separately recorded
clean `a3e6ee0e8f1065889980c90e0d5111d878ff05a8` checkpoint; the dirty diagnostic
checkout is not relabeled as a clean qualification run.

#### Subsequent Crashpad diagnostic

A subsequent diagnostic enabled local Crashpad reporting only in a private app
copy, with no upload endpoint or forwarding to the macOS crash reporter. The
ordinary Chromium watchdog, observer deadlines and profiling workload remained
in place. The watchdog produced a usable minidump. Crashpad changes process and
I/O activity, so this run remains diagnostic evidence alongside the earlier
failures. The run used clean source `2f47c9a90490c309451735e63bc42751b2095995`
and the native artifact from the build checkpoint recorded above.

Matching module identity, captured addresses, disassembly of the exact binary and
Chromium `154.0.8037.98` source identify the final main-thread stack as
[`ThreadPoolImpl::Shutdown`](https://github.com/chromium/chromium/blob/154.0.8037.98/base/task/thread_pool/thread_pool_impl.cc#L424-L469)
calling
[`TaskTracker::CompleteShutdown`](https://github.com/chromium/chromium/blob/154.0.8037.98/base/task/thread_pool/task_tracker.cc#L233-L258),
which waits for its shutdown event through
[`WaitableEvent` and a Mach message receive](https://github.com/chromium/chromium/blob/154.0.8037.98/base/synchronization/waitable_event_apple.cc).
This is a later shutdown stage than the NetworkService cleanup wait identified
in the earlier captures.

All 21 identified Chromium worker threads were waiting for work at the capture
instant. That observation does not establish a zero blocker count:
[`TaskTracker` accounts for queued as well as running work](https://github.com/chromium/chromium/blob/154.0.8037.98/base/task/thread_pool/task_tracker.cc#L107-L195).
Recovered stack values consistently identify the tracker and event, but the
minidump omits the heap memory needed to read the tracker state. The remaining
blocker count and responsible task are therefore unknown. A single snapshot
also cannot measure time spent at this gate or divide the watchdog interval
between NetworkService cleanup, thread-pool shutdown and other phases. It does
not establish a thread-pool deadlock or a production fix. The raw dump remains
private; the public evidence contains its length, digest and reviewed findings.

#### Earlier paused live-state capture and environment cleanup

A separate disposable C-stub/LLDB probe was intended to test hard-disconnect
cleanup before the proposed Bunly live-state capture. Its coordinator stalled during
process-metadata collection; the exact blocked call was not captured. A later
bounded inspection verified the same kernel process identity and found its
sole thread in the state defined as
[`TH_STATE_UNINTERRUPTIBLE`](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/osfmk/mach/thread_info.h).
This establishes the observed thread state. The installed kernel's exact source
revision, wait channel and cause were not established.

At that checkpoint, verified `SIGKILL` requests targeted the owned coordinator
and its unreaped direct children, but completed exit and reaping had not been confirmed. The
probe does not establish that disconnecting LLDB safely resumes its target.
No Bunly application was launched or attached by that probe, and the planned
live-state capture was unexecuted at that checkpoint. These auxiliary probes are excluded from
the native profile and app-launch counts above. Further Mac application and
debugger launches were paused until the recovery check below.

This environment failure establishes no cause for the earlier CEF watchdog
failure. Offline analysis, diagnostic-harness review and mock tests supply no
native qualification pass. No shutdown deadline, Chromium security-cloning
policy or system setting was relaxed.

#### October 23 retry: observer fix and bounded live captures

The retry confirmed by signal-zero checks that all five recorded processes from
that earlier probe were absent. This establishes current absence, not the timing
of their prior exit/reaping or safety of forced debugger disconnection. A fresh
disposable-child probe completed normal attach, known-memory read, detach and
reaping; the hard-disconnect path was not retested.

The maintained native command first exposed an interpreter-resolution bug:
applying the application's deliberately empty `PATH` and unrelated working
directory also hid the Python observer. `observedCommand` now resolves the trusted
interpreter in the caller's environment before applying the target environment.
Three maintained regressions cover basename resolution, relative paths and
missing-interpreter rejection. The target's empty `PATH` is still enforced.
The complete portable command passed **574 Bun tests and 199 Python tests**, plus
formatting, types, lint, boundaries, builds and type-checker qualification.
The foundation command passed **133 tests**, overlapping the ordinary suite.
Native Rust code and dependencies did not change; their earlier validation and
advisory checks were not rerun or relabeled as fresh results.

With an absolute interpreter selected, the uninstrumented native workload again
completed its assets and normal backend exit, then failed the CEF teardown
watchdog with host exit code 2. No performance distribution was accepted.

The first private live-capture retry failed before attachment because Xcode's
embedded Python 3.9 and the contributor Python 3.11 did not share the same
`time.monotonic()` epoch. Python documents the macOS process-wide change in
[version 3.10](https://docs.python.org/3.13/library/time.html#time.monotonic).
The coordinator, observer tap and LLDB capture now use the same explicit
`CLOCK_UPTIME_RAW` clock. The 10-second capture bound and ordinary 30-second
observer deadline were not extended.

Two corrected late captures read tracker state **`0x17`**, meaning shutdown had
started with **11 blocking items**. This is not a count of eleven identified
executing tasks: the tracker also counts queued/running BLOCK task sources.
The bounded all-thread snapshot found the identified pool workers waiting for
work. A separate, earlier capture finished about **6.25 seconds** after
`cef-shutdown` began and showed the previously mapped **NetworkService exit-wait**
stack instead. That earlier capture did not satisfy the TaskTracker state-read
condition; its result remains unavailable rather than being treated as zero.

These observations show different shutdown stages, not a proven thread-pool
root cause. The sampled late blocker count cannot explain where the earlier
interval was spent or identify the responsible task sources. All three attached
captures detached successfully, but their ordinary observer cleanup outcomes
failed; a reported exit code zero is not a successful native qualification.
Later signal-zero checks found each recorded root PID absent. Raw diagnostics
remain private; digests, source hashes, outcomes and limits are retained in
`retry20261023` within the local evidence record.

The remaining evidence needed is the owned NetworkService child wait and the
identity of the remaining blocking task sources. No speculative native fix,
longer shutdown timeout, security-cloning exemption or system/billing setting
change was made. PR #89 remains draft and unmerged.

No startup or interaction distribution from these invocations is accepted.
Captured timings remain diagnostic observations while shutdown qualification is
incomplete.

The maintained profiling suites report descriptive distributions and bootstrap
mean intervals without timing gates.
Fresh profiles do not establish OS cold-cache startup; synthetic DOM events do not
establish hardware input or compositor presentation latency. M4 renderer authority
and representative transport selection remain unfinished acceptance work. Merge
and progression into M4 remain blocked until the native shutdown failure is fixed
and the complete native profile and shutdown qualification pass.

## Packaging integrity

`packageCefRuntime` computes the compressed byte count and SHA-256 while gzip
output flows through the bounded stream pipeline. It returns a manifest only
when the source, compressor and destination have completed successfully, the
completed output is a regular file of the measured length, and the final source
inventory validation succeeds. Failed owned outputs are removed; an existing
output is never overwritten or removed.

The source inventory pass, pre-pack directory validation, per-file size/hash
checks during emission, production-runtime configuration checks, and post-pack
directory validation remain in place. They cover different source-mutation
windows and have not been removed as redundant.

The compressed digest now describes bytes emitted by gzip and accepted by the
writer. The former extra archive read described bytes read back from the output
path. Those are different guarantees: this optimization does not independently
check storage corruption or a same-length modification after the write. Neither
approach is an `fsync` or power-loss durability guarantee. The signed acquisition
path still verifies the received archive's exact size and hash before publishing
an installed runtime. Work assumes the existing private per-user filesystem
boundary; it does not promise protection from hostile same-user filesystem races.

The maintained tests independently hash and decompress captured output, exercise
real package/acquisition round trips, and reject source failure, late destination
failure, aborted writes and oversized compressed output. Metadata is withheld
until the writer's final completion. This removes one complete archive read; it
is a packaging I/O change, with no desktop-runtime speed claim.

## Actions runtime pins

Direct workflow actions were checked against upstream release commits and their
`action.yml` manifests. The following pins explicitly use Node 24:

| Action                               | Release  | Commit                                     |
| ------------------------------------ | -------- | ------------------------------------------ |
| `actions/checkout`                   | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-python`               | `v7.0.0` | `5fda3b95a4ea91299a34e894583c3862153e4b97` |
| `actions/upload-artifact`            | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/cache`, `/restore`, `/save` | `v6.1.0` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| `oven-sh/setup-bun`                  | `v2.2.0` | `0c5077e51419868618aeaa5fe8019c62421857d6` |

The existing setup-bun pin already supported Node 24. The pinned Foundry release
and its reusable workflows stay unchanged. The application continues to use
Bun (version redacted); Node 24 here is the Actions implementation runtime. Billing guards,
draft requirements, trigger conditions and hosted-run authorization are unchanged.
Local workflow syntax validation is not hosted execution.

Sources: [GitHub's Node 20 deprecation guidance](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/),
[checkout release](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-python release](https://github.com/actions/setup-python/releases/tag/v7.0.0),
[upload-artifact release](https://github.com/actions/upload-artifact/releases/tag/v7.0.2),
[cache release](https://github.com/actions/cache/releases/tag/v6.1.0), and
[setup-bun release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0).

## Advisory verification

Fresh `bun audit --json` requests for the root, Electron adapter, Electrobun
adapter and shared benchmark fixtures completed with exit code zero and empty
advisory objects on 2026-10-22. The prior timed-out attempts remain historical
unverified checks; the new results do not rewrite them. JavaScript application and
benchmark lockfiles were not upgraded as part of this pass. An empty advisory result means
no known findings from that check, not absence of vulnerabilities.

Both locked Cargo dependency audits completed with zero reported vulnerabilities
and no warnings. The complete Python requirements audit also reported no known
vulnerabilities. An initial Python audit invocation selected a virtual environment
without the audit module; the installed contributor audit tool was then used
successfully. The Git-history secret scan passed with the existing exact
historical exclusions. These checks do not establish native runtime security or
M4 renderer authority.
