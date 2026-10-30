# Windows native download qualification

The Windows cache-path correction in [PR #212](https://github.com/0xPlayerOne/bunly/pull/212)
passed the uninstrumented maintained Windows/full suite on both its reviewed
branch and final released main. Both complete exports pass the unchanged strict
receipt and historical source replay. **Issue #36's bounded software gate is
complete.** M7 remains incomplete because #35 has a separate Linux composition
failure and physical input/rendering qualification gaps.

## Retained cohorts

| Cohort | Exact application/native source | Whole download workload | Full suite | Maintained report replay |
| --- | --- | ---: | --- | --- |
| [Reviewed branch, run 41106853236](https://github.com/0xPlayerOne/bunly/actions/runs/41106853236) | `ff3f408c378975ac115e8842e2bba98823cbac03` | 11,010.6285 ms | 20 stages passed | Passed |
| [Released main, run 41111900552](https://github.com/0xPlayerOne/bunly/actions/runs/41111900552) | `eba03821c84bd2e73ffdeac1b2d8ccd1d36ddf5d` | 10,475.6416 ms | 20 stages passed | Passed |

These are separate source-attributed executions. The fourteen-case workload
duration includes cancellation, failure and cleanup cases. It is not the first
request's latency or a speedup measurement. The first request must complete
within the unchanged 6,000 ms deadline; its individual duration is not separately
recorded by the maintained receipt.

The correction merged as `04650be8ca1f0844b85bb6f5c4871c6ad40fa284`; release
[v0.6.8](https://github.com/0xPlayerOne/bunly/releases/tag/v0.6.8) changes version
metadata. Both use native tree `efb611c4aef5233c30d7768e69178a5bd4bd3ffb`.
The branch source tree is `1cf9e95cf257bae043b30cb330a93925803ff00c`; released
main is `048a1fed33b3060d297c8a2dc278a3e31afd940d`.

The documentation/evidence commit containing this record is separate from the
executed runtime commits. Its manifest records equality with released main for
all ten maintained desktop-profile source-selector inventories: 387 unique files,
including 359 download-profile files, plus the unchanged native subtree. Only
root documentation and this evidence directory change; root `README.md` is outside
those selectors. This is source-equivalence evidence for recording the result,
not a claim that a native app ran from the later documentation commit.

## What both passing results establish

Each run passes the unchanged `native-file-downloads-v1` acceptance for all fourteen required
outcomes, all nine safety checks, exact document authority and cleanup:

| Required outcome | Cases |
| --- | --- |
| Three completed transfers | Ordinary completion, explicit replacement of a 4 MiB file, allowed redirect |
| Seven cancellations | Explicit cancel, abort, navigation, renderer reload, view close, window close, application quit |
| Four expected failures | Denied redirect, unknown-size byte limit, transfer timeout, network interruption |

The expected failed transfers are successful negative cases within a passing
qualification; they are not reclassified failed qualification attempts. The nine
checks cover denied permission, traversal, root mismatch, duplicate preservation,
non-file destinations, blocked redirect isolation, stale grants, quit cancellation
and sentinel preservation. Completed files have the required bytes and hashes.

Native shutdown reports fourteen admissions and terminal callbacks, with three
completions, seven cancellations and four expected failures. Native transfers,
callbacks, staging handles and deadline workers return to zero. Final SDK
windows, views, sessions, listeners and listener errors are zero. Temporary
cleanup, SDK shutdown and overall host clean shutdown pass. The observer records
no timeout, cancellation, output overflow, failure, observed orphan or cleanup
survivor. Source-before/after, the 359-entry source inventory, prepared/input
artifact inventories and prepared-file identity remain unchanged.

All twenty full-suite stages pass, including downloads and the later credential
stage. The qualification record also retains ten prebuilt trials, one hundred
lifecycle cycles, six fault cases and terminal ownership acceptance. This is the
ordinary maintained full suite. The separate required workflow step also passed
Clippy and native compile/lifetime tests with `packaging,browser-actions`,
`packaging,programmatic-files`, and the combined feature set including
`rpc-qualification,shutdown-diagnostics`. Its actual completed/success result is
retained in [branch-workflow-steps.json](branch-workflow-steps.json), from job
`124238884605`, and [released-main-workflow-steps.json](released-main-workflow-steps.json),
from job `124255908251`. The released-main [job REST projection](released-main-workflow-job-rest.json)
also records the exact source and successful standard-user/optional-feature steps.
These executed feature checks do not substitute for the separate
four-profile GUI programmatic-file qualifier, OS picker or physical-file cases.

Each native log records 258 passing tests, including the Windows
`CreateFileW` path-spelling regression, namespace/name rejection and preservation
of `Zone.Identifier`. The regression requires the slash-appended verbatim-path
control to fail and the normalized path to open the same canonical directory.
The [cache-path analysis](../../docs/windows-cache-paths.md) explains that boundary
correction. Safe Browsing, security metadata handling, temporary ownership and
native-completion acceptance were retained. The earlier startup trace is excluded
from this uninstrumented acceptance.

Both runs also passed 1,613 Bun tests with fourteen declared skips and 269
Python tests with 41 skips. The optional native library configurations passed
268, 267 and 285 tests respectively; these overlapping configurations are not
summed with each other or the ordinary 258-test suite. Completed job-log digests
and provenance are recorded separately from the hosted artifact ZIP members.

## Files and integrity

[manifest.json](manifest.json) identifies each hosted run/artifact, exact source
and native tree, original ZIP hash, exported and compressed bytes, runtime
identity, selected receipts and replay status. The complete download report is
retained under deterministic gzip; qualification and environment records use the same archive format,
preserving their original Windows line endings. The separately retrieved workflow-step summary preserves the
run/job/source identity and actual step conclusions, including intentional skips.
Expanding a report reproduces its hosted export byte for byte.

| Retained file | Exported SHA-256 |
| --- | --- |
| [branch-file-downloads.json.gz](branch-file-downloads.json.gz) | `b77e18c98e9ffdd72d496fc5553098024a1f9dad0bbf5432c80d9865836c78f4` |
| [branch-qualification.json.gz](branch-qualification.json.gz) | `6024df6f050e21f951cb2568c9af22d10a151f8f44f80f0b4c877280c4c157a0` |
| [branch-environment.json.gz](branch-environment.json.gz) | `887b9f0659f84b30eb603f3c886b27843d4facbf44bdf039bb6a525336ee5547` |
| [released-main-file-downloads.json.gz](released-main-file-downloads.json.gz) | `e38c856125a4cdb55c03e182e98ac1f8659ce77d99708974e01dbc4512b173b4` |
| [released-main-qualification.json.gz](released-main-qualification.json.gz) | `47a5595d58e4e0abbe62b3b4200301be6f7774affc6ed92e50a5e233a51abf3c` |
| [released-main-environment.json.gz](released-main-environment.json.gz) | `887b9f0659f84b30eb603f3c886b27843d4facbf44bdf039bb6a525336ee5547` |

Branch [artifact 13004205822](https://github.com/0xPlayerOne/bunly/actions/runs/41106853236/artifacts/13004205822)
has ZIP SHA-256 `bfb25b84e7506afa7462463d7320d9603c37a1dd1727fcd614a1da43b65b95ac`.
The original `file-downloads.json` and `file-downloads-run-u5Ff9P.json` members
are byte-identical. Released-main [artifact 13006430837](https://github.com/0xPlayerOne/bunly/actions/runs/41111900552/artifacts/13006430837)
has ZIP SHA-256 `fba2ab861ec532772d951759527683be3b249ff74e26c24790d0b06b0d61c724`
and 4,591,949 bytes. Its two exported download-report members are also identical.
Native-test and portable-check log hashes are recorded in the manifest; those
logs are available in the named artifacts.

An [earlier step snapshot](released-main-workflow-steps-stale.json) briefly
reported the standard-user step as pending after the run had completed. It is
retained unchanged as stale metadata, not a failed run or an acceptance receipt.
The authoritative job REST projection, the later completed connector snapshot,
the completed job log and the actual qualification reports corroborate success.

The native report, qualification and environment inputs already carry the maintained export marker from
`scripts/export_native_evidence.py`: live fixture nonces and observation
correlation were removed before public artifact upload. The exporter is
idempotent on these reports. No additional content redactions, outcome edits,
receipt substitutions or source/inventory changes were applied during retention.
Full process observations remain present, with their existing sampling limits.

## Offline replay

Use Bun 1.4.4 and a checkout containing the named historical Git source objects.
The reviewed branch was squash-merged, so its commit need not be an ancestor of
`main`. If either source object is absent, retrieve it explicitly before the
offline replay:

```sh
git fetch origin ff3f408c378975ac115e8842e2bba98823cbac03 eba03821c84bd2e73ffdeac1b2d8ccd1d36ddf5d
```

The validator checks the complete historical source inventory and blob hashes,
native subtree binding and unchanged strict receipt acceptance. It does not fetch
missing history or launch a native app. From the repository root:

```sh
replay_dir=$(mktemp -d)
for cohort in branch released-main; do
  gzip -dc "evidence/m7-windows-downloads/$cohort-file-downloads.json.gz" > "$replay_dir/$cohort.json"
  GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 bun scripts/qualify-desktop.ts --verify "$replay_dir/$cohort.json"
done
rm -r "$replay_dir"
```

Compare the emitted `reportSha256` with the exported digest in the table or
manifest. The manifest also records the compressed archive digest and byte size.

The exported-report decoder validates the explicit export schema before passing
receipts to `acceptDownloadsReport`. It does not reconstruct private live
correlation or relax the raw receipt schema. The full-suite qualification JSON
is a hosted orchestrator summary, not an independent replay of all twenty stage
reports; the complete retained download report is the replayed profile here.

## Limits and preserved failures

This is actual Windows x64 execution by the maintained standard-user hosted
runner, recorded as non-emulated `ci-smoke`. Its desktop is explicitly
`hosted-desktop-unqualified`. Native dialogs and status items remain unsupported
on Windows; passing their unsupported paths does not qualify those adapters.
The download run does not qualify physical OS-file drops, directory upload, an
OS picker, trusted/physical input, IME, assistive technology, hardware DPI,
multiple displays, GPU performance or release packaging.

The observed runtime is packaged Bun 1.4.4, CEF 156.0.7 and Chromium
156.0.8078.17. Runtime sandbox identity remains `unverified`. Native source is a
declared build commit checked against Git and artifact bytes; embedded binary
build attestation is absent. The Windows metadata regression does not establish
a security verdict for every CEF download. No request-latency distribution,
performance improvement or hardware claim is inferred.

Earlier maintained failures and excluded diagnostic runs remain in the
[M7 status record](../../docs/m7-status.md#windows-file-workflow-completion-history).
Diagnostic-only [#211](https://github.com/0xPlayerOne/bunly/pull/211) closed without
merge; its selected trace evidence remains linked from the cache-path analysis.
The later passing result does not erase those failed receipts.

Issue #35 remains blocked by the strict Linux initial-hidden composition result.
The [separate six-report cohort](https://github.com/0xPlayerOne/bunly/blob/e76f02ae78ce7532ea5f02a5a5e6c36090f2d85f/evidence/m7-composition-interactions/README.md)
retains one Mac pass and five unsuccessful attempts, including the withdrawn
native candidate. Its [pinned upstream analysis](https://github.com/0xPlayerOne/bunly/blob/e76f02ae78ce7532ea5f02a5a5e6c36090f2d85f/evidence/m7-composition-interactions/upstream-initial-visibility.md)
documents the creation-time visibility guard. That qualifier is on unmerged
PR #210; it is not part of the released-main twenty-stage suite retained here.
Physical focus/IME/accessibility/display observations and a measured rendering
tradeoff decision also remain open. These Windows results do not complete M7.
