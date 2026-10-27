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
