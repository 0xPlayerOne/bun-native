# Failure-only Windows retention metadata

[Issue #287](https://github.com/0xPlayerOne/bun-native/issues/287) remains unresolved.
The Windows protocol job in [run 41243736310](https://github.com/0xPlayerOne/bun-native/actions/runs/41243736310)
failed the existing Solid collectability assertion: one of ten disposed render
roots remained observable where the test requires zero. The job passed 418 of
419 tests. The failure took 41.48 ms and used the pinned Bun revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`.

The exact tested merge was
[`788feca5b893390e7acfc9c3a83d01ba03f742af`](https://github.com/0xPlayerOne/bun-native/commit/788feca5b893390e7acfc9c3a83d01ba03f742af).
Its shared renderer, Solid adapter, failing test and shared test support are
byte-identical to the accepted Solid source at
[`59d921461075b839085823bdc6ef42377bf8d7d5`](https://github.com/0xPlayerOne/bun-native/commit/59d921461075b839085823bdc6ef42377bf8d7d5).
The original log identifies a retained count but not which root survived or its
state at that checkpoint. This increment adds those observations; it is not a
collection or ownership fix.

## Preserve the failed checkpoint

The test still mounts and disposes ten roots in the same loop, keeps the same
two `await Bun.sleep(0)` calls and two `Bun.gc(true)` calls, then evaluates the
exact same `WeakRef.deref()` filter and zero-length assertion. The assertion
runs before any diagnostic work. On failure only, its catch path calls
[`rethrowWithRetentionDiagnostic`](../../tests/solid/retention-diagnostic.ts).
That helper runs synchronously and rethrows the identical original failure,
including when reporting or diagnostic logging fails. It performs no extra
collection, heap snapshot, timer, await, retry or retained-count allowance.

When `BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR` is set, the report records:

- Which zero-based indexes in the original ten-reference array remain visible
  immediately after the failed assertion.
- Each surviving root's public mutation, node, listener and pending-operation
  diagnostics, plus its ready/closed Promise states.
- The current application ownership/queue counts and window revision/completion
  state, before the surrounding test helper starts shutdown.
- Bun version/revision, executable path, OS/architecture/release, the declared
  GitHub checkout SHA and SHA-256 identities of twelve relevant source and
  configuration files.

The output is limited to ten probes and 32 KiB. Source files are bounded before
reading and only their paths, sizes and hashes are recorded. The report copies
specified diagnostic fields; it does not store element values, arbitrary error
contents, stack dumps or heap contents. Exclusive file creation preserves an
earlier report from the same process. No report or target inspection occurs
when the original assertion passes or the diagnostic option is unset.

The existing Windows protocol step enables the option under
`.bun-native/evidence/retention/`. The existing protocol artifact already
uploads that evidence directory after failure. No additional runner, altered
job condition, test exclusion or acceptance change is introduced. Other
platforms retain the default disabled option unless explicitly configured.

## Interpretation and focused checks

The helper tests exercise deterministic post-failure observations, source
identity, disabled behavior, exclusive-write failure and preservation of the
original exception even when the diagnostic logger throws. They do not run a
GC experiment or claim native rendering or target collectability.

The extra metadata can expose an unexpected pending or nonempty root after its
`dispose()` completed, and can distinguish a first, final or intermediate root.
It cannot by itself distinguish framework ownership from runtime retention.
The original predicate and subsequent diagnostic dereferences keep observed
targets alive for the current job. The report therefore explicitly identifies
itself as a post-assertion observation, not a trace of the roots that marked the
objects during the two preceding collections.

A future passing run does not resolve the original failure. Keep the
[fixed-checkpoint failures](README.md) and [root-tracing limitations](root-tracing.md)
alongside any new report. A framework-leak claim still needs a demonstrated
strong ownership path that outlives disposal; a runtime-retention claim needs
the actual marking source. Neither classification follows from a zero ownership
counter, a survivor index, or an absent snapshot edge.
