# Post-M3 foundation audit

Repository hygiene, reproducible tooling and narrowly scoped security maintenance.

**Date:** October 21, 2026.
**Baseline:** `3fc759f9d7e02220469ee86cfa8c3e97a4c03a28` (merged M3 closeout).
**Scope:** Maintainer tooling, tracked repository structure, dependencies and preserved evidence. Not M4 acceptance or a comprehensive penetration test.

## Findings and changes

| Finding                                                                         | Resolution                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root contribution guide retained M1-only instructions beside the managed guide  | Preserve applicable Bunly guidance in `.github/CONTRIBUTING.md`; remove the obsolete root file and fix its incoming links.                                              |
| Two issue forms were both named Bug report                                      | Retain the managed form with Bunly-specific version/security diagnostics; remove the superseded form.                                                                   |
| Sync guards did not detect these duplicates                                     | Reject misplaced/case-aliased policies and duplicate form names before upstream writes. Test the canonical checkout and failure cases.                                  |
| Actual local Foundry hook setup remained incomplete                             | Run the installed generator and overlay; enable repository-local hooks through upstream's machine-hook chaining. No global hook configuration change.                   |
| Reusable Foundry workflows used a mutable release tag                           | Verify the v1.48.2 commit, then pin the configured runtime, checkouts and callers to `0b5374bc59599b53e298bcf461d7727a9938b3ae`. Keep the exact 1.48.2 package.         |
| CEF download/build dependency had a published certificate-verification advisory | Update only `rustls-webpki` 0.103.15 to 0.103.16 in the native CEF lockfile. Preserve all other runtime and dependency pins.                                            |
| An offline-toolchain archive export job had no remaining consumer               | Remove `contributor-snapshot`; hosted contributors provision their pinned toolchain directly.                                                                           |
| Automatic CEF CI retained a second, weaker smoke implementation                 | Remove `qualify-cef-runtime.ts` and route both automatic and manual qualification through the tested hosted prebuilt runner, including Windows standard-user execution. |
| Automatic native cache could restore broad, older compiled output               | Cache immutable download inputs with exact target/lock keys, require `--locked`, and save only after successful qualification.                                          |
| Old checkpoint documents looked like current setup instructions                 | Move superseded snapshots to `docs/history`, preserve their content/context, and add current documentation and validation indexes.                                      |

The older foundation CI lane now explicitly installs its Python process-observer
requirements before portable integration tests. Its runtime-target check avoids
a shell-lint ambiguity; main/manual runs are not cancelled by newer executions.
Both it and the ordinary CEF lane subscribe to the ready-for-review transition while
retaining its billing/draft guards. Diagnostic collection is cancellation-aware.
No security checks, acceptance cases or sandbox protections are removed.

## Dependency security

RustSec **RUSTSEC-2026-0382 / CVE-2026-111943**, published October 20, affects
certificate path verification in the locked `rustls-webpki` version. The patched
0.103.16 rejects the distrusted intermediate keys. In this repository the dependency
arrives through `download-cef` as a native build dependency; this is maintainer
download-path protection, not a claim about the frontend or reduced shipped bytes.

Sources: https://rustsec.org/advisories/RUSTSEC-2026-0382 and
https://github.com/rustls/webpki/pull/546.

The post-patch Cargo audit reports no known vulnerabilities for either native
workspace. Root Bun and the separately locked Electron, Electrobun and shared
fixture dependency projects also report none. The pinned Python requirement sets
pass pip-audit. These are time-specific advisory checks, not proof of absence of
unknown vulnerabilities. Historical competitor versions and evidence are not
silently upgraded to change prior measurements.

## Secret and evidence review

The history scan covers 80 commits at the baseline and approximately 3.56 MB of
text. Its nine findings were exact SHA-256 report values in
`evidence/m1-host-results.json`, not credentials. `.gitleaksignore` records only
those reviewed commit/file/rule/line fingerprints. No path, entire evidence tree,
or category of credentials is exempted. A repeat history scan passes.

A separate bounded expansion scans all 56 compressed JSON evidence collections
(approximately 78 MB). Two generic-key findings are SHA-256 source identities for
`native/cef-host/src/keychain.rs`; both are reviewed as source hashes. The scanner
output is not mislabeled zero findings, and no compressed report or outcome is
rewritten. Native macOS/Linux/Windows and M2 reference evidence replays pass.

Private one-off diagnostics remain ignored. The obsolete Windows/Linux VM scratch
directories were removed only after checking for tracked files, active Bunly
containers, QEMU processes and mounts. Their pre-deletion allocated size was about
39.3 GiB. This removed local disk images, setup helpers and throwaway VM credentials;
accepted Git evidence and reusable CEF/build caches remain. No unrelated container
or process was stopped, and no local VM was restarted.

## Validation

- The full local application/repository suite passes 483 tests; the Python suite
  passes 145 tests. Browser-only typechecking and compiler-free builds pass.
- Patched native CEF tests pass 43 cases; locked packaging Clippy with warnings
  denied and Rust formatting pass under Rust 1.91.0.
- Two real Foundry sync passes produce identical final hashes across the 465 files
  present at that checkpoint. Authored guides, custom workflows and native hook
  routing survive regeneration. Upstream and overlay doctor checks pass.
- Upstream doctor retains its tag-format warning for an immutable SHA. The SHA
  was independently checked against its v1.48.2 release; the warning is not hidden.
- Changed workflow syntax, formatting, normal commit checks and final hosted
  qualification are recorded in the pull request. A cloud run is not implied by
  local tests or historical evidence replay.

## Fresh hosted verification

Full native run **39667418111** passed on all three hosted targets from clean
commit `599348a819781f6d5d28465e73d7d8fd4bfb6d02`. It exercised the patched native
lockfile and shared hosted qualification code with the normal deadline profile.
Downloaded Windows/Linux reports were independently replayed with the strict
platform validator; macOS packaged and fault outcomes were checked as well.

| Target      | Prebuilt cases | Lifecycle cycles | Actual fault cases | Native Rust tests |
| ----------- | -------------: | ---------------: | -----------------: | ----------------: |
| Windows x64 |             10 |              100 |                  4 |                38 |
| Linux x64   |             12 |              100 |                  4 |                42 |
| macOS arm64 |             11 |              100 |                  4 |                43 |

All three passed development-origin isolation with zero forbidden requests.
These are functional regressions, not performance or physical-input claims.

Final-head portable run **39668257634**, from clean
`d1c0deccf914e548ec75d602d11b9d51b76f959c`, also passed on all three platforms.
Linux/macOS passed 483 TypeScript tests; Windows passed 480 with its three
pre-existing platform-specific symlink skips. All three passed 145 Python tests,
strict typechecking, browser boundaries and compiler-free builds. The difference
between those execution sources is the legacy foundation CI prerequisite/trigger
fix, its regression test and this audit documentation, not native runtime behavior.

All workflows pass actionlint. Two further real sync passes on the committed tree
leave it clean. Ordinary automatic CI remains paused; its new orchestration is
statically checked and shares the executed hosted smoke runner, but the automatic
job itself was not dispatched as a claimed fresh pass. Final record-only edits
do not alter any tested executable source.

Run records:
https://github.com/0xPlayerOne/bunly/actions/runs/39667418111 and
https://github.com/0xPlayerOne/bunly/actions/runs/39668257634.

## Repository settings requiring an explicit policy decision

Read-only GitHub inspection at this checkpoint reports a public repository,
Dependabot security updates enabled, secret scanning and secret-scanning push
protection disabled, private vulnerability reporting disabled, and no active
protection or required status checks on `main`. Automatic CI is
still paused. Local hooks and manually run tests therefore are not equivalent
to enforced server-side merge or secret-protection gates.

Recommended next administrative work is enabling the available secret scanning
and push-protection controls and private reporting, then adopting branch protections and required
status checks backed by an intentionally resumed validation workflow. Do not
require a check whose workflow is still paused. This codebase audit does not
change those settings implicitly, and their absence is not hidden by the local
scanner result.

## Deliberately retained boundaries

M3 remains complete for its declared profiles. M4 renderer-native authority,
persistent/ephemeral sessions and permission integration are still separate work;
this audit does not certify them. Production signing, updates, wider physical
input/DPI/GPU conformance and performance claims retain their existing milestone
owners. Automatic CI remains paused; manual native qualification remains usable.
Publishing and repository settings are unchanged.

Existing regression, lifecycle and fault tests are retained. Referenced qualification
scripts are maintainer tools, not shipped application payloads. Root license and
language configuration, plus inert release metadata, are not misplaced GitHub files.

A future optimization candidate is caching verified immutable public asset content:
the current handler bounds reads and verifies hashes on requests. Profile that cost
before changing it; removing integrity checks is not an acceptable optimization.
The present cleanup makes no measured runtime speed or memory claim.
