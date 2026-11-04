# A deliberate native failure reaches the production gate

The one predeclared [PR #390](https://github.com/0xPlayerOne/bun-native/pull/390)
control reached its intended failure in
[Validation 41916968921](https://github.com/0xPlayerOne/bun-native/actions/runs/41916968921),
attempt 1. The Windows native controller reported the exact
`NativePaintMismatch` after a correct native paint, completed its required
shutdown checks, and returned exit 1. The Windows job failed. The unchanged
production aggregate received `native-platforms: failure` and itself exited 1.

This satisfies the bounded deliberate-native-failure-to-gate acceptance in
[#256](https://github.com/0xPlayerOne/bun-native/issues/256). The Windows job and
Validation run remain **failed**. All ten other implementation jobs passed;
there was no other rejected aggregate dependency. The research control and
this data-only archive are intended for closure unmerged.

## Exact measured source

| Identity                        | Value                                      |
| ------------------------------- | ------------------------------------------ |
| Published control head          | `09a090e42ac30641c090bef7145349dd8a6e1eca` |
| Actual tested merge             | `01cbc04abd06fe12f5f45c81f257afe5a7d7d68e` |
| Tested tree                     | `7a00e874dcc2330b6afd7f4182983e944a70f609` |
| Equivalent local control commit | `f5637461a2345f30f453c85655f696847a3e0f53` |
| Control base                    | `27405939ce1007d4142e1bb67e9ecc6ca3ce0411` |
| This archive's separate base    | `6b4a775b139e4a40c802b54614f0ae80dfcb6142` |
| Windows native job              | `126879092034`                             |
| Actual aggregate job            | `126888642945`                             |
| Run attempt                     | 1; no retry or control-source mutation     |

The only executable change in the measured control was
`if ($IsWindows) { exit $code }`, after the existing negative-paint error and
cleanup assertions. Its other changed file was the published research plan.
No runtime, native fixture, compiler, deadline, matrix, pass criterion or
aggregate implementation changed. This archive adds no executable change.

The production `.github/workflows/bun-native.yml` remained byte-identical to
the control base: 11,626 bytes, SHA-256
`2f83f45e5c8c33d926260cf106d3ad18f839b6796662f561581bdacb24e34388`.
Its actual `toJSON(needs)` result and unchanged rejecting predicate are
preserved with the complete aggregate log.

All **120 original source inventory records** match the exact measured Git
tree. The archive includes the original and research native workflows, the
unchanged aggregate workflow and the published plan as exact bytes. It does
not substitute the archive branch's source for the measured source.

## Native observation and failure propagation

The original negative report records `status: failed`, exact error type
`NativePaintMismatch`, and message `Timed out waiting for complete native
paint`. Its raw trace contains the correct complete six-node GPUI paint at
tree revision 1, including `Clicks: 0`; the deliberately incorrect expected
label is absent. The complete layout precedes that paint. All six native
records and the public mount record carry the original nonce
`c1dcd60fca7209462f3d1b8994baad56`.

The native controller and application returned exit 1. The original report
records `nativeShutdownAndExitVerified: true`,
`forcedApplicationTermination: false`, all seven public ownership counters
zero, and no discarded stdout/stderr bytes. The application deliberately
aborted with `Controller aborted native smoke` and completed zero cycles.
The preceding development and development-input reports separately passed
three cycles each with exit 0, native shutdown verified, no forced termination
and zero public ownership counters.

The negative report retains **`processTreeCleanup: unverified`**. Verified
native shutdown and application exit do not establish complete descendant
process-tree cleanup. The negative case requested neither OS input nor
screenshots, and this audit makes no physical input/display/GPU claim.

Windows step 18, **Prove a wrong native paint expectation fails**, was its sole
failed step. Native AOT compilation, AOT paint/lifecycle and AOT OS-input steps
19–21 were skipped after that failure. The separate Windows AOT interop job
passed its own headless scope; it does not qualify those unexecuted native
fixture steps.

The actual aggregate received these six dependency results:

| Dependency         | Actual result |
| ------------------ | ------------- |
| `source`           | `success`     |
| `protocol`         | `success`     |
| `aot`              | `success`     |
| `native`           | `success`     |
| `native-platforms` | `failure`     |
| `security`         | `success`     |

At `2026-11-04T21:49:54.0092680Z`, the unchanged gate printed only
`native-platforms` as rejected. Its runner recorded exit 1 immediately after.
The follow-on coverage-summary step was skipped, and the Validation run
completed with `failure` at `21:49:56Z`.

All eleven implementation jobs and the aggregate, including their full step
outcomes, are retained in `metadata/final-jobs.json`. Linux native and macOS
native passed; all three protocol jobs, all three AOT interop jobs, Source
quality and Dependency audit passed. The separate CodeQL workflow
`41916970163` completed successfully, while Code Foundry Security
`41916970224` was skipped. Those workflow statuses are preserved separately
from the successful required Dependency audit.

## Environment and host identity

The observed target was Windows Server 2022 x64, build 20348, hosted image
`win22/20261026.347.1`, with pinned Bun revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`, Rust 1.98.1 and Python 3.12.10.
The recorded renderer was `Microsoft Basic Render Driver`, driver version
`10.0.20348.5756`. Its original `is_software_emulated: false` field is retained
without inferring physical GPU coverage from that flag.

The actual retained PE host bytes were independently hashed without execution:
**10,055,680 bytes**, SHA-256
`e8e6dc4af89d541422dac5344373d58579b0973705423f1be8b1f0aeac2cd797`.
This matches the original native hash/size receipts and scenario reports.

This control does not establish physical input, screenshots, IME,
accessibility, long-soak behavior, scheduled GPU coverage or performance
budgets. It does not resolve separately retained startup, close or
collectability failures.

## Retained bytes and archive preparation

The original Windows artifact `13365752122` is **3,966,429 bytes**, SHA-256
`3a245c1de9710af51e25c370c337ec49193c6e1efd6a68f76166dca7d0ecd945`.
[archive-inventory.json.raw](archive-inventory.json.raw) lists all **42** safe,
unique regular members with sizes, SHA-256 values and inclusion decisions.

[original-evidence.tar.gz](original-evidence.tar.gz) contains **58** safe,
unique regular files, totaling **445,343 uncompressed bytes**. It is **82,396
bytes**, SHA-256
`568fad41091391238686407d163d76817a212ceb1ba8e1cf73a64a6a4c8da628`.
All **41 original Windows text members** are copied byte-for-byte, including
the negative case, preceding positive reports/records, bootstrap/toolchain,
native build and host identity receipts. The archive adds the complete
decoded Windows and Gate logs, final job/run/artifact metadata, the exact
`RESULTS` JSON extracted from the Gate log, and the four source/plan files.

The complete decoded Windows job log is **90,191 bytes**, SHA-256
`a0f3bef2a031c22693ed10c2249ee40c101f779bf748b068d62a55945ae9c401`.
The complete decoded Gate log is **2,582 bytes**, SHA-256
`e4384cf0a861989c6afd91f0bcc6d3de0195bcb73244074256d5f4c2235fdcc3`.
Both retain their original decoded UTF-8 bytes, including the Gate log's byte
order mark. The Gate's complete dependency object is preserved without
changing its field order or content.

The full original Windows ZIP and its executable-containing
`unsigned-native-host.tar.gz` are **not copied** into this branch. The omitted
host archive's original size/hash and the independently checked PE size/hash
remain recorded. Other targets' artifact payloads are not re-archived or
requalified here; final artifact identities and job outcomes remain in the
metadata. No Windows native AOT payload was produced by the skipped stages.

[audit-receipt.json.raw](audit-receipt.json.raw) binds the measured source,
original observations, complete source fingerprints, final actual outcomes,
archive hashes and limitations. Earlier Windows-only and source-plan audit
snapshots are preserved unchanged inside the archive; their then-pending
aggregate wording is superseded by this final receipt, not rewritten.

Archive preparation used read-only source/artifact checks, JSON decoding,
hashing and archive round-trip comparison. A **separate offline setup install**
prepared the fresh archive worktree's normal commit hook:
`bun install --offline --frozen-lockfile --ignore-scripts`, exit 0, 72 packages
in 19 ms from the existing populated task cache, with no lockfile change.
That was framework hook setup, not a cold installation or standalone-consumer
qualification. No further installation, native/application execution, test
suite, GC workload, workflow retry or control-source mutation occurred during
archive preparation. Normal active commit hooks apply to these data/docs files.
