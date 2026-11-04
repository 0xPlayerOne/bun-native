# Retained React calibration failure at c4d4

This is an archival record of an executed failure, intended for a draft research
PR closed unmerged. It changes no implementation, workflow, assertion, collection
checkpoint or deadline. The archival commit is not the tested source.

[Native Linux job 126851519250](https://github.com/0xPlayerOne/bun-native/actions/runs/41909084088/job/126851519250)
tested PR #374 head `c4d4c2e74d561ce19621e3e3940469d33bf3f118` through merge
`b04503e5f9e741b32ac213e65b2af96715081263`, tree
`7ce2cfdb841f3c616a14a3d6a12a51a3b3c79a25`. Step 27 failed the first development
React calibration with `Disposed view/callback targets remain observable`,
`2 !== 0`. Both fixed collection observations retained probes `[3,5]`, the
second mount's render-root and listener targets. The required aggregate failed.
No retry or additional workload was performed.

At the collection checkpoint the application intentionally still owns one window
and its native root node. The ownership oracle asserts those two counts at one
and the other five counters at zero immediately before the failed WeakRef
assertion. Only afterward does `finally` dispose the active view, shut down the
application and await closure. The reported all-seven-zero cleanup belongs to
that later shutdown; it does not pass the earlier collection assertion.

All 166 source-manifest records matched the tested tree, including the previously
omitted `ownership.ts` oracle. The retained 205,898-byte development module is
byte-identical to the earlier failed #353 and passed #379 modules. The receipt
records their exact source/run identities and common SHA-256. Those observations
identify no retaining strong edge and establish no engine, scheduler, HAL or
RenderDoc cause. The separately successful four-language CodeQL run and its
aggregate qualify source analysis; the required Linux retention result remains
failed. Later independently collected scenarios do not erase it, and skipped
baseline stages are not qualified.

`raw-evidence.tar.gz` preserves seven bounded inputs: the original calibration
JSON, native JSONL and log; the original 166-source build manifest and toolchain
record; the complete decoded native-job log; and the recorded job steps.
`receipt.json` records the original full ZIP identity, each member's exact byte
count and SHA-256, both compressed and uncompressed archive hashes, source/module
comparisons and explicit omissions. Tar/gzip metadata is deterministic. Every
member was read back and compared byte-for-byte with its retained input.

The complete original artifact ZIP, executables, generated module/map bytes, unrelated
scenario output and window-manager logs are not duplicated here. Nothing in the
archive was executed. Its original public hosted paths describe that run, not
paths required to reproduce or read this archive.
