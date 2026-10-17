# Code provenance

Record what is reused, what is referenced, and what is actually shipped.

**Status:** M1/M2 inventory. No competitor implementation or browser distribution is vendored in the Bunly runtime.
**Related issues:** #4, #10.

## Reference audit

| Source | Inspected design | Reuse decision |
| --- | --- | --- |
| Mirin | Bun bootstrap, native-main-thread/Worker handoff, CEF helpers, development assembly | Reference host pattern; evaluate narrow CEF integration imports in M3, not the complete SDK/CLI |
| Electrobun | Prebuilt native components, Worker handoff, typed RPC, browser profiles and reload lifecycle | Principal executable benchmark; do not copy its alternative runtime/package tooling into Bunly |
| Butter | Separate native shim, framed shared memory, polling, generated compiler bootstrap | Reference tradeoffs; do not inherit duplicated generated transport or extraction design |
| cef-rs / CEF | Candidate browser bindings and official embedding contracts | Dependency candidates only; pin and audit exact source/binary versions before M3 |
| Wry | Candidate system-webview integrations | Post-MVP candidate; not linked or bundled in M1 |

Exact reference revisions and license URLs are recorded in
`provenance/references.json` and `benchmarks/references.json`. Upstream claims are
not Bunly measurements. M1's native fixture, SDK, and installer code were authored
for this repository; no clean-room design claim is made.

## Executed benchmark dependencies

Electron 44.8.0, Electrobun 2.0.3-beta.26 and xterm 5.5.0 have separate benchmark
package manifests and frozen Bun locks. They do not belong to consumer SDK
workspaces and are not included by Bunly's SDK/application build.

The Electrobun adapter's small application configuration and entrypoint use the
public API and prepared devkit. The reference is
`blackboardsh/electrobun@c4bbeca07829d9b1634d31598ef6091fb19ace2a`, particularly
`kitchen/hutch.config.ts`, `kitchen/electrobun.config.ts`, and the BrowserWindow
API. The adapter is Bunly-authored; it does not copy the framework implementation.
Its generated third-party CEF application and Hutch/Cottontail/Bun downloads live
under `.bunly` and are never checked in or published by these tests. Upstream
licenses/notices remain in the downloaded distributions. The npm lock authenticates
the bootstrap package, not every future release asset; actual app file hashes and
upstream setup versions are separately recorded.

## Import contract

For every future adapted/copied component, add repository URL, immutable commit,
source paths, destination paths, license/notices, local modifications, rationale,
and patch-following responsibility. Prefer a maintained dependency over copying
when the integration permits. Keep copyright/license notices in copied files.
A repository's top-level license does not establish all browser binary, codec,
font, operating-system, or transitive dependency redistribution rights.

The M1 native artifact contains our probe and the linked Rust standard library;
it does not contain Bun, CEF, helpers, codecs, fonts, or application assets.
`scripts/package-probe.ts` emits inventory and SBOM inputs alongside its artifact.
This is not a complete production SBOM or redistribution review. The Bun runtime,
Chromium/CEF distribution, helpers and native addons need their own notices when
introduced to shipping artifacts. See `THIRD_PARTY_NOTICES.md`.

## Patch maintenance

Before importing native browser code, identify the upstream security/update
channel and record a reproducible patch diff. Review Bun/CEF compatibility on
candidate upgrades; do not float shipped versions or assume developer Bun updates
the packaged executable. Reference snapshots are not automatic upstream
synchronization. No bot, scheduled job, or external monitoring was activated.
