# Code provenance

Record what is reused, what is referenced, and what is actually shipped.

**Status:** M1 inventory. No competitor source or browser distribution is vendored.
**Related issue:** #4.

## Reference audit

| Source | Inspected design | Reuse decision |
| --- | --- | --- |
| Mirin | Bun bootstrap, native-main-thread/Worker handoff, CEF helpers, development assembly | Reference host pattern; evaluate narrow CEF integration imports in M3, not the complete SDK/CLI |
| Electrobun | Prebuilt native components, Worker handoff, typed RPC, browser profiles and reload lifecycle | Reference and principal benchmark; do not copy its alternative runtime/package tooling |
| Butter | Separate native shim, framed shared memory, polling, generated compiler bootstrap | Reference tradeoffs; do not inherit duplicated generated transport or extraction design |
| cef-rs / CEF | Candidate browser bindings and official embedding contracts | Dependency candidates only; pin and audit exact source/binary versions before M3 |
| Wry | Candidate system-webview integrations | Post-MVP candidate; not linked or bundled in M1 |

Exact reference revisions and license URLs are recorded in
`provenance/references.json`. Upstream claims are not Bunly measurements. M1's
native fixture, SDK, and installer code were authored for this repository; no
claim is made that the overall design was developed without prior-art study.

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
introduced. See `THIRD_PARTY_NOTICES.md`.

## Patch maintenance

Before importing native browser code, identify the upstream security/update
channel and record a reproducible patch diff. Review Bun/CEF compatibility on
candidate upgrades; do not float shipped versions or assume developer Bun updates
the packaged executable. M1 references are immutable snapshots, not automatic
upstream synchronization. No bot, scheduled job, or external monitoring was
activated by this inventory.
