# Exploratory empty-child storage measurements

These are local, uncontrolled microbenchmarks for [#673](https://github.com/0xPlayerOne/bun-native/issues/673#issuecomment-6879564933), not release-host or allocation-count results. No candidate is included in the runtime. The machine was Apple M2 Max, macOS 27.2, Rust 1.98.1 (`48a229cea`, LLVM 22.1.8), release profile. Load, thermal state and other machine activity were not controlled.

The baseline tree source was from `f5a13a094a9ca84c458d793269c592be610954a8`, SHA-256 `f69b40a660c8aeb785564233f0677be38c1dd0ec3f6d665e4f5fae05ccadbd84`. The mount fixture is `native/protocol/examples/mount_perf.rs` (SHA-256 `2944a9733d62e912434cf1fec1c18d8efde2f06bf27857979e0c1725a4c94483`); sparse diff uses `native/protocol/examples/diff_perf.rs`; removal uses the existing `removal_perf.rs`. Patches describe the tested production-source changes; the optional pointer delta was reconstructed from the recorded edit after collection. Test-only adaptations for the optional representation are not in these patches. Binary hashes are below; individual results are linked in the issue discussion. These patches are evidence, not proposed runtime changes.

Each gzip is deterministic (`gzip -n`) and decompresses to a JSON array in actual process order. `pair` identifies a baseline/candidate pair and `variant` identifies its side. Mount files have `rows` of `[leaf_count, trial, preflight_nanoseconds]`; `mode` is `single` or `parallel` (four independently prepared trees). Repeat files are parallel only. Each worker ran five unreported warmups followed by 30 samples. Diff files have `[trial, nanoseconds_for_1000_traversals]`; removal files have named arrays of preflight nanoseconds. Comparisons use the median of a process's samples within each pair, not pooled samples as independent observations. The first cohort alternated baseline-first and candidate-first; repeats reversed that order.

The global shared-Arc variant showed a large four-worker regression; the thread-local and optional variants had mixed concurrent results, and the optional variant slowed sparse diff. These samples do not establish causality, allocation savings, end-to-end impact, or statistical confidence on other machines. Keep all samples, including unfavorable ones, when reanalyzing.

The release executable SHA-256 values were:

| Probe and variant     | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Mount baseline        | `dad790c7ddda5e417dcfdb4277f6360a0a2791c499abde5708013848ee23b44c` |
| Mount global          | `abff6e5d2afcccc8ecfd3e5d6e03e4eaf0ac2b1117431814b2c44f02bf807cfa` |
| Mount thread-local    | `73b960dade978c3d60bbd891bc5cddfe6cd04eda1dec085491c4fefb8fc01941` |
| Mount optional        | `241a941430f4661c3828e68faa4fc599cbcb77852a65c7e60bdc6d151099827a` |
| Removal baseline      | `cd9e5d80712942c4fab21c0c65f56bc3e33fda8d37003facda48aa44ed9c1eef` |
| Removal optional      | `6f4359ab97a3bc497e8d2a16a2ca7e7dc0c0172251c665f952bfa9669ac8235a` |
| Diff baseline         | `030200dad11eb172f3be3a038f441e98705cf552e47d820377bf3e95cd017637` |
| Diff optional         | `5434e0533f4cf016129fcea4793da65bc8068becbe96a2b20a10fdeeb11f1406` |
| Diff optional pointer | `019b3eade6498496fda74303d27c7626689556a37910ef254f245fd4d58a14fb` |
