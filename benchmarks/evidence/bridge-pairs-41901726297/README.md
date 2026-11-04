# Failed historical bridge comparison: November 4, 2026

This archive preserves the complete failed collection from
[Native bridge pairs run 41901726297, job 126825622138](https://github.com/0xPlayerOne/bun-native/actions/runs/41901726297/job/126825622138).
Two declared development warmups failed before collecting workload samples;
the other 22 declared observations passed. The collector correctly rejected
the entire comparison. No native workload or failed job was rerun for this
archive, and there is no accepted performance comparison.

The result extends the startup observations in
[#296](https://github.com/0xPlayerOne/bun-native/issues/296) and the historical
comparison investigation in [#297](https://github.com/0xPlayerOne/bun-native/issues/297).
It does not identify the cause of a startup delay or qualify a new product fix.

## Exact sources and recorded outcomes

The workflow ran from head `5ca2cac204521216bd94a2203baa59f3694ec0e0`, tested
merge `93b489fa42da8689909ff5c322ea6ba1be70595b`. Its controller used two separate
fixed historical source revisions and their separately compiled release hosts:

| Variant           | Historical source                          | Recorded host bytes | First development warmup                |
| ----------------- | ------------------------------------------ | ------------------: | --------------------------------------- |
| BN1               | `6ea507b58d0249b752ff62691ebc1879f3fcf6da` |          29,000,736 | Failed: native open request 3 timed out |
| Event integration | `4549e75ca5463f136898a2f5fb49d22b58dffa11` |          29,206,992 | Failed: native open request 3 timed out |

Both failures have zero individual and zero batch samples. Each application
exited with status 1, without forced termination or remaining/unreaped observed
processes. Both AOT warmups and all 20 measured observations passed with exit 0.
Those later successes remain separate observations and do not erase the two
failed warmups. The summary records `Collection includes failed observations;
no accepted comparison`.

The prepared historical source inventories do not contain the vendored HAL
introduced by [#374](https://github.com/0xPlayerOne/bun-native/pull/374).
These failures therefore are not execution evidence for that proposed HAL
patch. The older hosts lack the later startup-phase instrumentation needed to
attribute which native operation consumed the deadline.

## Preserved files and verification

[original-artifact.zip](original-artifact.zip) is the original GitHub artifact
`13359367268`, byte-for-byte: **386,517 bytes**, SHA-256
`1a948baeda1f39e932944dd79c472105f3e1a8d061b0dc5eb82d45f1718a9fe6`.
It contains all 147 original regular files, totalling 1,557,193 uncompressed
bytes: every declared observation, logs, preparation and AOT manifests,
compiler/linkage inspection, environment records and the final failed summary.
Its members are relative paths and contain no native or application executable.
No observations were selected out of this archive.

[failure-audit.json.raw](failure-audit.json.raw) records the bounded independent
audit, all 24 statuses, both original failure messages, cleanup observations,
artifact/result/log hashes and exact host/controller identities. The `.raw`
suffix preserves those audit bytes through source formatting.

The original summary is 94,841 bytes with SHA-256
`2d80c0d24ecb539613c0a2345577aed77787059d6d1c1b63d67cf23520789fcf`.
The four current controller source hashes were verified against the reviewed
source; both failed results/logs, all 22 successful result hashes and the
prepared-build receipt were independently checked against the retained bytes.
The archive was also checked for duplicate/unsafe member paths and executable
payloads before publication.

Historical source identities and per-file hashes are retained in the original
preparation records. This audit did not independently rehash every historical
Git blob: an optional comparison encountered uncached partial-clone objects
and was stopped. That limit is preserved in the audit. The original executable
bytes are not retained and cannot be independently reinspected here.

This branch only archives an already completed outcome. It changes no product,
workflow, deadline, GC checkpoint, sample count, acceptance rule or protection.
The historical comparison is separate from the required `Validation / Gate`;
its failed status remains failed. The current-source CodeQL gate and ordinary
protected-merge requirements remain applicable to #374 independently.
