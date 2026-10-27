# Reload mechanism qualification

**Issue:** #29. **Runtime:** pinned Bun 1.4.3. **Scope:** executable mechanism
experiments, not a production loader or native desktop persistence acceptance.
The stable supervised Bun process retains the desktop owner and its process leases;
application generations must be replaceable without implicitly restarting that owner.
The #28 managed ownership contract remains the authority for adapters, stale callbacks,
work reservations and explicit cleanup. This qualifier does not implement #30–#33.

## Reproduce

```sh
bun run qualify:reload
bun run verify:reload .bunly/m6/reload/run-EXAMPLE/report.json
bun test tests/reload-mechanisms.test.ts
```

The qualifier requires a clean committed source, pinned Bun, and Python with the
repository's pinned psutil. It owns a fresh private output directory and accepts
no alternate samples, deadlines or overwrite arguments. Its fixed matrix executes
20 sequential generations for each of plain same-path dynamic import, ModuleGraph,
one Worker per application generation, and one supervised child per application
generation. Separate synchronous-loop cases run under the existing bounded process
observer. None runs an infinite loop in the developer's main interactive process.
No per-service Worker/process topology is proposed.

Each generation opens a real numeric-loopback listener and timer, reads a rewritten
dependency at the same path, and returns module-local and shared-global counters.
Disposal requires actual timer cessation or observed Worker/child exit, plus successful
listener rebinding. A separate owner-side server must still respond. Syntax, missing
import, thrown initialization and indefinitely pending import cases preserve independent
outcomes. ModuleGraph additionally exercises a queued microtask, an external EventTarget
listener, a raw descriptor, scoped timer promises, host-context resource creation and
an asynchronous exception. Framework retirement must not equate graph disposal with
complete application cleanup.

For same-event-loop import/graph loops, timeout and forced owner exit are **expected
application failures**, not resource-preserving reload successes. Worker/process loop
cases must establish actual entry, generation exit, listener release, and owner survival.
Ordinary output, process-tree cleanup and observer-failure gates remain mandatory.
The fixture's direct-child lifecycle does not qualify detached descendants or native
addons. #124's final CEF teardown risk remains independent and unresolved.

## Evidence and measurements

The report retains exact source hashes, source-before/after identity, runtime/target,
each raw generation row, every expected negative outcome, raw private-observation
hashes and non-identifying resource samples. RSS is sampled across the observed process
tree; shared pages can be counted more than once and brief child lifetimes can be
missed. POSIX descriptors and Windows handles are different metrics. Unavailable
counts stay null. No PID, birth identity, path, raw exception text or endpoint is
included in the published report.

Per-generation RSS is process-wide. Worker heap counters cover only the main isolate;
subprocess rows exclude the child and are not comparable to in-process heap rows.
Initial/final heap readings follow explicit full GC. Samples in one owner process are
correlated: min/median/p95/max are descriptive sequential samples, not independent-run
confidence intervals or an engine-matched advantage. Successful port release and
finite observed trends do not prove universal leak freedom. #33 owns the 500-replacement
integrated desktop soak and comparative warmed workflow.

`verify:reload` recomputes result hashes and summaries, enforces the complete unique
matrix and failure classifications, and matches every retained harness hash to its
historical Git blob. A missing source object fails rather than silently fetching or
substituting current source. It is replay of retained evidence, not new execution,
cryptographic attestation of execution, or reconstruction of private process records.
The matrix workflow executes and replays the same fixed plan on Linux, macOS and
Windows; its actual receipts, not the presence of a workflow, establish platform coverage.

## Decision gate

Do not select an implementation based only on module load speed. First require fresh
dependency state, stable owner survival, actual cleanup and explicit behavior for
uncooperative code. A fast same-event-loop mechanism cannot claim to recover the
stable owner from a synchronous infinite loop. Any fallback must be chosen before
running code that can block the owner; it cannot rescue an already blocked event loop.

The implementation decision and measured platform scope will be recorded alongside
the completed fixed matrix. Until then this command deliberately reports
`not-a-production-loader-selection`. Even a selected mechanism still needs bounded
cross-generation communication, prepare/commit retirement, native reauthorization,
and resource reconnection in #30/#31; it cannot pass live in-process identity objects
across an isolate/process boundary as though those objects were authorization.

## Local result and proposed M6 mechanism

The committed [macOS arm64 matrix](../evidence/m6-reload-local.json) was executed
on clean `6e4fd3b713a97dc9a5facf66ca95ba3fc7e309ff`, Bun 1.4.3, on October 27, 2026. Its report is 115,783 bytes, SHA-256
`7dc2131c66de06262c1a8cb2ae99c460b2d6c5d043e61ff88de79a0543f0e78e`.
It contains 80 repeated generation observations and four distinct loop controls,
not 80 native backend replacements or independent performance launches.

| Mechanism        | Fresh dependency and module state              | Synchronous-loop outcome                            | Local median load / disposal request, ms |
| ---------------- | ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| Same-path import | 1/20; subsequent generations reuse stale state | Owner unresponsive; outer observer terminates it    | 0.148 / 0.025 (not viable reload)        |
| ModuleGraph      | 20/20                                          | Owner unresponsive; outer observer terminates it    | 0.563 / 0.028                            |
| Worker           | 20/20                                          | Generation exits, listener released, owner survives | 8.039 / 2.126                            |
| Subprocess       | 20/20                                          | Child reaped, listener released, owner survives     | 11.830 / 1.007                           |

The disposal column includes the exit wait for isolated candidates but only the
initial disposal call for in-process candidates; listener rebinding is verified
separately. These numbers are not equivalent-cost performance ratios. Peak sampled
process-tree RSS was approximately 26.0 / 26.3 / 45.1 / 42.3 MiB respectively.
Heap after final full GC exceeded its initial reading for every candidate, notably
about 0.74 to 8.79 MiB in the subprocess controller. The retained data does not
attribute that growth or demonstrate a long-run plateau. Do not claim the process
fallback is a memory optimization; longer integrated attribution remains #33.

ModuleGraph shared-global counters increased across generations. Its external
listener, queued microtask and raw descriptor survived graph disposal; its scoped
sleep promise did not settle during the 30-ms observation. Explicit framework
cleanup and cancellation remain necessary. Those observations are boundary results,
not successful automatic cleanup of those resources.

**Proposed default for #30:** one replaceable Bun Worker per application generation,
with the existing supervised Bun host retaining native owners and leases. At most
one candidate and one serving generation should run during preparation/cutover;
unsettled retired work remains charged under the #28 contract. Workers are not
per-service processes and are not a security sandbox or native-crash isolation.

**Supported-fallback candidate:** one supervised application-generation subprocess,
selected before execution for a profile that cannot use Workers. The stable owner
must stay alive, must not replay uncertain mutations, and must observe the child's
exit and channel/resource drain. Killing/replacing the desktop-owner Bun process
is a controlled full restart and explicitly loses resource persistence. A failed
Worker cleanup cannot silently become a seamless process fallback or free its
unknown resource reservations.

Do not adopt ModuleGraph as the default merely for its lower measured load cost:
its synchronous loop blocks the very owner whose windows, sessions and terminals
must survive. Ordinary same-path import is rejected as a reload strategy. ModuleGraph
remains a qualified cooperative experiment, not an automatically exposed fast mode.

This choice is provisional until the same fixed matrix passes on the declared
Linux and Windows targets and is reviewed together with #28. It selects a mechanism
for subsequent implementation, not a shipping loader. #30 must carry opaque host
identities through a bounded host-controlled channel mapping; JS identity objects
cannot be serialized to obtain equivalent authority. #31 must revalidate native
view/session/document permissions at attachment and every managed operation.

## Primary API references

The current upstream documentation describes experimental APIs and may be newer than
the pinned executable. Availability and semantics are tested on Bun 1.4.3; a current
webpage alone is not evidence that that pinned version supports an operation.

- [ModuleGraph guide](https://bun.sh/docs/runtime/module-graph)
- [ModuleGraph API](https://bun.sh/reference/bun/ModuleGraph)
- [Worker guide](https://bun.sh/docs/runtime/workers)
- [Watch and hot mode](https://bun.sh/docs/runtime/watch-mode)

The fixtures use only documented application-facing APIs, no Bun fork, private
embedding internals, custom resolver, CEF flags, native deadlines or dependency changes.
