# ADR 0002: native owner and one supervised Bun process

An evidence-backed hosting baseline, independent of the application's TypeScript model.

**Status:** Accepted for M1 architectural feasibility; supersedes the provisional Node-API-first preference.
**Decision date:** October 17, 2026.
**Related issues:** #5, #9, #12–#15, #22, #29.
**Evidence:** [Recorded results](../../evidence/m1-host-results.json), [input identities](../../evidence/m1-host-inputs.json), [M1 closeout](../m1-completion.md).

## Decision

Use a prebuilt Rust native executable to own the GUI/main thread and stable native
resource identities. Run application TypeScript in **one supervised Bun process**
per desktop host, with bounded, asynchronous, versioned IPC. This formalizes the
architecture already used by the initial CEF implementation; it does not replace
that implementation in this change. Application developers still write Bun
TypeScript and consume prebuilt native artifacts, without compiling Rust.

Keep Node-API/Worker and C-ABI/FFI/Worker hosts as tested alternatives, not shipping
requirements or an automatic fallback after failure. Any later switch requires
an explicit ADR and equivalent application-level lifecycle/performance results.
Do not create one process per service/window, embed undocumented Bun internals,
or maintain a Bun fork. Bun 1.4.3 is the qualified runtime. The host-probe C ABI
and native-control protocol are version 1 but are distinct interfaces; changes
must retain explicit version checks rather than assuming Rust source compatibility.

Initial functional targets are macOS arm64, Windows x64 and Linux x64. This
feasibility decision does not certify CEF sandboxing, DPI/input, every Linux
window system, browser failures, or release distribution on those targets.
Those platform support gates remain in M3/M9. Rust is the native-core choice,
not a requirement that every platform shim or application extension use Rust.

## Evidence reviewed

The [initial matrix](https://github.com/0xPlayerOne/bunly/actions/runs/38991991211)
recorded 45 fresh-host trials across all three targets and all three candidates.
The following later completed runs supply the closeout's retained measurements:

- [Lifecycle/fault matrix](https://github.com/0xPlayerOne/bunly/actions/runs/39011450636):
  normal and hung FFI/Node-API Workers, supervised process recreation and actual
  native-process abort on all targets. Normal Worker runs contain 26 successive
  generations; process runs contain 28, including different explicit fault cases.
- [Kernel-counter matrix](https://github.com/0xPlayerOne/bunly/actions/runs/39011450665):
  separate instrumented FFI/Node-API/process runs on the same target classes.
  Linux scheduler and macOS package/interrupt counters were actually collected.
  Windows recorded an unavailable provider, not a zero reading.

Those runs exercised head `a68c7dfe8ace8b3e1bb5245f1eafe817c15aba33` through GitHub's
merge commit `b7097320d2726e0aa2a7da03ef0ff8ab15d4cf14`, with Bun 1.4.3 and probe
compiler Rust 1.85.1. Six artifact SHA-256 values, original JSON member hashes,
targets and environment records are retained. The reducer independently checks
process exits/orphans, the full fault/generation matrix, and recomputes kernel
deltas from raw samples instead of trusting the archived success summary alone.

## Observed resource costs

Uninstrumented lifecycle runs, one run per row. Resident sets are summed across
observed processes and can double-count shared pages. "Startup" is the first
externally observed idle marker (a sampled upper bound), **not** exact readiness,
CEF startup, or a displayed frame. Generations are not independent repetitions.

| Target      | Model                | First idle observed, ms | Idle median tree RSS, MiB | Peak concurrent processes | Peak idle threads |
| ----------- | -------------------- | ----------------------: | ------------------------: | ------------------------: | ----------------: |
| Linux x64   | FFI + Worker         |                   66.34 |                     44.99 |                         1 |                10 |
| Linux x64   | Node-API + Worker    |                   64.03 |                     45.28 |                         1 |                10 |
| Linux x64   | Native + Bun process |                   34.51 |                     28.28 |                         2 |                 6 |
| macOS arm64 | FFI + Worker         |                  180.12 |                     50.70 |                         1 |                12 |
| macOS arm64 | Node-API + Worker    |                  140.75 |                     58.17 |                         1 |                12 |
| macOS arm64 | Native + Bun process |                  151.60 |                     18.95 |                         2 |                 8 |
| Windows x64 | FFI + Worker         |                   78.00 |                     47.07 |                         1 |                11 |
| Windows x64 | Node-API + Worker    |                   63.00 |                     47.41 |                         1 |                11 |
| Windows x64 | Native + Bun process |                   94.00 |                     27.30 |                         2 |                12 |

Separate kernel runs, idle-phase observations only. Each entry is **observed
counter delta / sampled matched-identity duration**, not a lifetime count.

| Target / counter           |  FFI + Worker | Node-API + Worker | Native + Bun process |
| -------------------------- | ------------: | ----------------: | -------------------: |
| Linux scheduler wakeups    | 323 / 4.024 s |     314 / 4.150 s |        130 / 4.305 s |
| macOS package-idle wakeups | 100 / 2.880 s |     102 / 3.099 s |         30 / 2.881 s |
| macOS interrupt wakeups    | 270 / 2.880 s |     281 / 3.099 s |        116 / 2.881 s |
| Windows                    |   Unavailable |       Unavailable |          Unavailable |

The JSON also retains work-phase counters, sample counts, observed idle CPU,
peak memory, and both runs' environment metadata. Provider semantics differ;
Linux scheduler wakeups cannot be compared to macOS package-idle exits. These
are hosted smoke observations with short 200 ms idle intervals, fixed candidate
order, sampling gaps and observer overhead, not controlled desktop benchmarks.
The counter and resource runs used different hosted runners and are not paired.

## Why select the subprocess baseline

1. **Explicit failure boundary.** A Worker shares the native host's address space.
   The tests require native dispatch to stop before destroying its callback owner.
   They do not make uncontrolled Worker termination or native-memory corruption
   safe. A separate Bun process decouples its termination from native callback
   ownership; the native host itself can still fail and needs M3 recovery tests.
2. **Stable ownership.** GUI resources can outlive a replaceable Bun service
   process. M6 still needs resource reconnection, state-transfer and terminal
   ownership implementations; a process boundary alone does not provide HMR.
3. **Measured rather than process-count-driven.** Two processes were not
   automatically the highest resident-set or idle-activity choice in these
   fixtures. This rejects "fewest processes is necessarily best"; it does not
   establish that the subprocess model is faster or smaller in a real desktop.
4. **Bounded implementation surface.** Standard process startup and explicit IPC
   avoid making FFI callback teardown a consumer-facing dependency. Additional
   serialization/copies, process startup, supervision and pipe pressure are real
   costs. M2/#22 must compare those costs with the same browser/application work.

The process fixture recreates a fresh Bun runtime while the Worker fixture keeps
its host heap alive, and their transport/binary checks differ. We therefore do
not publish a speedup, memory-saving percentage, cross-platform ranking, or
confidence interval from this table. No quantitative production budget has been
"passed" by these smoke measurements. The selection prioritizes failure and
ownership properties with no demonstrated prohibitive cost in the tested probe.

## Windows measurement support decision

**Windows wakeup/power benchmarking is explicitly unsupported in M1.** The current
collector has no qualified ETW implementation. Successful Windows lifecycle tests
remain valid functional evidence; the empty counter result is neither success at
measuring wakeups nor permission to label context switches as wakeups.

This resolves the formerly provisional measurement-support choice, rather than
claiming that missing instrumentation has been implemented. Linux and macOS
supply actual idle counter observations for both viable host models; Windows
supplies its startup/resource/fault observations with a documented measurement
limit. M1's exit is runnable scaffolding and an evidence-backed host decision,
not a platform power benchmark. The existing #9/#10/#22 measurement work retains
Windows wakeup collection before any Windows idle-efficiency/power comparison.
No runtime capability is silently removed and no Windows power goal is waived.

Why this is acceptable for the architecture decision: the chosen isolation and
ownership boundaries do not depend on a Windows wakeup advantage, and the model
remains replaceable if later equivalent workloads show an unacceptable cost.
Do not hold unrelated host implementation indefinitely behind an unqualified
power metric; do not release a performance claim in its place either.

## Revisit and release gates

Revisit this ADR if an equivalent CEF workload demonstrates a material startup,
latency or memory penalty; if pipe scheduling prevents responsiveness; or if a
qualified in-process boundary delivers benefits without weakening lifecycle or
security guarantees. Record the reproducer and compare both models, not just
an empty window or a change in process count.

M3 still owns actual GUI/helper shutdown, including the retained intermittent
macOS descendant finding (#15). M4 still owns native document authority,
sessions and permissions. M6 still owns managed reload. This M1 decision closes
none of those issues and makes no production-readiness or benchmark-win claim.
