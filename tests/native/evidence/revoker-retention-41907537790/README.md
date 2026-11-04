# Headless renderer revoker retention failure: November 4, 2026

This archive preserves the failed Linux protocol observation from
[Validation run 41907537790, job 126846102120](https://github.com/0xPlayerOne/bun-native/actions/runs/41907537790/job/126846102120)
for [PR #377](https://github.com/0xPlayerOne/bun-native/pull/377). The complete
decoded job log, original environment artifact and source-specific failure
record remain available here. No failing test, native workload, heap inspection
or GC experiment was rerun to prepare this archive.

## Exact source and outcome

| Identity          | Recorded value                                |
| ----------------- | --------------------------------------------- |
| Pull request head | `af956a154fff0c0afcc5e26adbe55f5af76f9f1b`    |
| Tested merge      | `44334f79d05e8cdca9bb0298871f6aea9236b2b0`    |
| Tested tree       | `1a9d22268ed5e0c86b3e6fd5dfd5efe7f61995f2`    |
| Merge base parent | `77c842faa3137e8155b24c1d123d16c1ed5b76ed`    |
| Platform and mode | Linux x64, Bun development, headless protocol |
| Failed step       | Cross-platform TypeScript contracts, step 9   |
| Command           | `bun test tests`                              |

The command completed with **702 passing tests and 1 failure**, **5,459
assertions**, and **703 tests across 54 files** in **35.82 seconds**. The failed
test was `retained window unsubscribe handles release their callbacks
immediately`. At `tests/renderers/revoker-ownership.test.ts:22`, its unchanged
assertion expected zero reachable callback WeakRefs and observed one. The log
does not identify which callback remained reachable or why.

The next test, `window completion releases callbacks even while unsubscribe
handles stay live`, passed. That separate observation does not erase the
failure. The Rust protocol step was skipped after the TypeScript command
failed. This is a headless callback-retention result, not a native input or
pixel observation.

The complete `packages/` and `tests/renderers/` trees at the tested source are
byte-identical to the accepted main parent `77c842fa…`. The compact record
also contains exact hashes for the failed test, its actual IPC support and
`packages/renderer/src/window-lifetime.ts`. A read-only source trace confirms
that release removes the registration from its lifetime set and clears its
listener field. Neither that source inspection nor unchanged source establishes
the cause of the observed retained reference. The investigation remains open
under [#287](https://github.com/0xPlayerOne/bun-native/issues/287).

## Preserved files

- [job-126846102120.log.gz](job-126846102120.log.gz) losslessly contains the
  complete decoded GitHub job log. Decompression yields **132,293 bytes** with
  SHA-256 `86a9675c0f73c7abc368b055989424425e471caa24b653e08be6ec71554c9d33`.
  The deterministic gzip file is **30,158 bytes**, SHA-256
  `b9e26819923d2ceedfbf8ee40bb278049540ca6dff4c0dbe4ca66d919341d9af`.
  Compression preserves timestamps, ANSI sequences, whitespace and every test
  result without making formatting changes to the original log bytes.
- [original-environment.zip](original-environment.zip) is original GitHub
  artifact `13360144287`, unchanged: **1,197 bytes**, SHA-256
  `37279151f01ace2c52c3a8b262edfe27f7175ab7bcb4b6598893124fe2f23fa5`.
  Its three regular relative files are `bootstrap.txt`, `bun-bootstrap.log`
  and `toolchain.txt`. They retain the source, platform and toolchain records.
- [failure-record.json.raw](failure-record.json.raw) is the unchanged compact
  audit: **2,540 bytes**, SHA-256
  `e14a11d082b9f37f75b7b3f7b53965c365079f521fe0154f744d98556ea12b48`.
  Its `.raw` suffix preserves the exact recorded bytes through source formatting.

Archive preparation verified the compressed log's exact round trip, the
original environment ZIP's GitHub digest, safe unique member paths, source
identity and full package/renderer-test parity. It executed no application,
native host, failing test or GC workload.

This research branch changes no product code, workflow, deadline, GC checkpoint,
assertion or required gate. It does not create a new PR #377 execution. The
original protocol failure remains failed; the independently running native
viewport qualification and any later source changes have their own evidence.
