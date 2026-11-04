# One deliberate native failure reaching the production aggregate

This is a fixed research plan for [#256](https://github.com/0xPlayerOne/bun-native/issues/256),
not a production change or an executed result. The branch is intended for one
ordinary existing Validation run, an evidence archive, then closure unmerged.
The deliberately failing workflow must never be merged into main.

## Exact source and fixed scope

Preparation starts from accepted main
`27405939ce1007d4142e1bb67e9ecc6ca3ce0411`, tree
`9647bf3cd9c49d89114a15d36e2f61d015e0f72a`. Publish and record the clean
implementation commit/tree before triggering its one Validation run. Retain the
actual tested merge/tree independently of that published head.

| Input                                                   | SHA-256                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Unchanged production `.github/workflows/bun-native.yml` | `2f83f45e5c8c33d926260cf106d3ad18f839b6796662f561581bdacb24e34388` |
| Original `.github/workflows/native-platforms.yml`       | `cdb0826d81562cd7b2f00042ad5fa2d396da9231b90956071437cd951b9512f2` |
| Research `.github/workflows/native-platforms.yml`       | `514c8c5c821bde67b933458e706b670dd016a624c1ffd2b274270e4d1bfe98c2` |

The only executable-source difference is one line in the existing **Prove a
wrong native paint expectation fails** step:

```powershell
if ($IsWindows) { exit $code }
```

It appears after the existing report/cleanup assertions and before the existing
`$global:LASTEXITCODE = 0`. The Windows x64 matrix target alone propagates the
original nonzero native-controller exit code. The macOS target retains its
original expected-negative success handling. No native/runtime/test source,
fixture, toolchain, compiler flag, assertion, deadline, action pin, job matrix,
cache, permission, billing/draft guard, aggregate implementation or `needs`
dependency is changed.

## Why this tests the actual gate

The existing target-native release-host scenario opens the real GPUI fixture
with `--negative-paint-check`. Before the added line can execute, its unchanged
wrapper must observe a nonzero code, `status: failed`, exact error type
`NativePaintMismatch`, `nativeShutdownAndExitVerified: true` and
`forcedApplicationTermination: false`. A bootstrap failure, timeout or unrelated
assertion does not meet this control.

The Windows job then actually fails. Its reusable-workflow result reaches the
existing `native-platforms` dependency of `Validation / Gate`. That production
job continues to use `toJSON(needs)` for its six existing job families and its
unchanged inline Node predicate, which rejects every result other than
`success`. No copied gate, synthetic result, `continue-on-error`, shell success
wrapper or separate workflow stands in for this path.

## One predeclared attempt

1. Complete static source review, workflow lint/format checks and normal hooks.
   Publish this exact plan and source on a draft research PR. Root review and
   publication precede any runner activation.
2. Mark that PR ready once to start **one ordinary existing Validation run**.
   Record the run ID, attempt number, source head, actual tested commit/tree and
   all job IDs. Do not manually dispatch an additional workflow, rerun a job,
   retry the run or alter the source to seek a cleaner outcome. Configured
   automatic code/security analysis retains its normal behavior.
3. Require the Windows native job to reach the existing wrong-paint step and
   pass all its precise error/cleanup checks, then fail by propagating the
   original nonzero code. Retain the complete step/job log and original
   `negative-paint/result.json` plus its correlated raw records. The later
   Windows AOT steps will be skipped after this intentional failure; they are
   not qualified by this run.
4. Require the actual production aggregate to receive
   `native-platforms: failure`, report that rejected dependency and exit 1.
   Preserve its complete log and actual dependency outcomes. Record every other
   executed job separately. Additional failures do not disappear: if present,
   the evidence proves rejection of this deliberate failure among the actual
   inputs, not that it was the sole failing dependency.
5. Retain the original artifact IDs, sizes and ZIP digests, exact source/workflow
   hashes, native report/log bytes, toolchain/host identity, complete job steps
   and aggregate log. Audit these retained bytes without rerunning a workload.
   Archive them in a separate evidence commit that clearly distinguishes the
   measured source. Close the research PR unmerged. This is not a replacement
   run for any earlier failed feature source.

An interruption before the designated native observation, cancellation, missing
artifact, wrong error or failed cleanup remains an incomplete control. Preserve
that outcome without an automatic retry.

## Cost and acceptance limits

The production dispatcher has no negative-only input. The one run therefore
uses the existing full matrix and existing timeouts; a direct dispatch of
`native-platforms.yml` alone would not reach the production aggregate. This
small source change does not claim a small runner workload. No local package
installation, application build, native program, test suite, GC checkpoint or
snapshot is part of preparing this research branch.

The expected result is a **failed Windows native job and failed Validation
aggregate**, with precise native error and joined cleanup. That can satisfy
only #256's explicit deliberate-failing-native-test-to-gate acceptance. It does
not complete scheduled GPU/soak or performance-regression work, establish
physical input/IME/accessibility support, or resolve separately retained
startup, close or reachability failures. No failure is relabeled as a pass.
