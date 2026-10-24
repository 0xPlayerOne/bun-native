# Native acceptance and sanitized evidence

`m4-acceptance` is the maintained six-stage selection: native RPC/prebuilt,
permission policy, external network/redirect/certificate policy, both functional
transport candidates, offline whole-profile reset, then protected cookies.
Automatic PR jobs and manual `m4-acceptance` use the same Python command map.
`full` now adds native fault qualification after those six stages. `smoke`, `rpc`
and `credentials` remain explicitly narrower diagnostic selections.

The hosted workflow prepares a contributor artifact, a standard-user account and
Linux display/session-bus/provider prerequisites. `bun run qualify:m4` invokes
that suite on such an already prepared disposable hosted environment; it is not
a personal-workstation command. Credential fixtures keep their independent
GitHub-hosted standard-user guard. Do not spoof it. No personal Keychain or user
profile should be used. Hosted orchestration deadlines are not native deadlines.

## Export contract version 1

Private observer reports are validated live before acceptance. Collection emits
`nativeEvidenceExport` metadata and replaces private 48-hex nonces with
`[fixture-nonce]`. SHA-256 digests and all outcomes, native receipts and cleanup
accounting remain intact. Each observation carries `observationExport` metadata;
its optional correlation ID is deliberately omitted (or recorded as absent), never
replaced with a fabricated valid ID. Invalid original IDs reject export. Export
is idempotent; the original private report is not modified.

Use `decodeExportedNativeReport` from `benchmarks/lib/exported-native-evidence.ts`
before applying the maintained workload validators to exported reports. This
requires exact export metadata and validates every observation without claiming
live correlation. Direct live validation of a marked exported observation rejects.
A successful export/replay is evidence verification, not new native execution.
Historical pre-versioned exports require an explicit historical projection; they
are not silently upgraded or used to invent private identities.

Tests execute the actual Python exporter and TypeScript replay path, preserving
nonzero exits, cancellation, overflow, orphan/cleanup failures, missing receipts,
duplicate receipts and malformed shutdown. No workload acceptance gate is relaxed.

## M5 handoff

M4 functional acceptance is recorded in `evidence/m4-final-acceptance.json`.
The closed historical #92 is not evidence of a runtime cure. #25 owns bounded
supervision and diagnostic follow-up; #27 must retain all failed load/shutdown
trials and cannot claim reliability from a later successful run. This risk does
not block independent stream protocol work. Current-engine performance profiling
remains separate from historical CEF154 transport distributions.
