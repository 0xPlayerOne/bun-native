# Rejected empty-validation fast path

An exploratory candidate added an early return in `Transaction.validate()` after
text-limit checks when `this.attached.length === 0`, calling `validateRequests()`
before returning. It avoided allocating the empty `Set` and traversal array;
the text checks and request validation remained in place. This candidate is not
in production. The source checkout was at `df141fce`.

On an Apple M2 Max, macOS 27.2, with pinned Bun `1.4.4-canary.1+b1007f117`,
[`benchmarks/core/commit.ts`](../../core/commit.ts) ran eight alternating
fresh-process baseline/candidate pairs per mode. Each process ran the existing
300 warmups and 3,000 measured samples per scenario. The raw records contain
one p50/p95 summary per process and phase, not independent per-operation
samples. Other load and power state were uncontrolled. Both AOT executables
were inspected as compiled programs with JIT unused.

| Scenario        | Mode        | Median paired candidate-minus-baseline p50 | Candidate-faster pairs |
| --------------- | ----------- | -----------------------------------------: | ---------------------: |
| Keystroke total | development |                                  +0.084 µs |          0/8 (one tie) |
| Keystroke total | AOT         |                                       0 µs |        3/8 (four ties) |
| Mount total     | development |                                  +0.062 µs |                    4/8 |
| Mount total     | AOT         |                                  -0.604 µs |                    5/8 |

These small exploratory measurements do not establish a performance gain or
end-to-end effect. The candidate was rejected; no behavior change is retained.

The baseline `tree.ts` SHA-256 was
`51e2edcc0f1e6d5d92e1f7edf79c6dc6bc5c2f5acc8bffa20b211523f3971bb8`; the
candidate source hash was
`0e880d90207d1db3e578f3c70978c183dfb4dd6dfdaa8533459d3a7f43281460`.
The benchmark source SHA-256 was
`3e7280eadb8bf392b2aa18680d07133738aad274dbb45fc199d3ca7f857d98ac`.
The baseline and candidate AOT executable hashes were respectively
`2fdd58427fc501c7c96dd2f9e0a343edefe7ee678a5dbb30f414da18dff6f60f` and
`8a29ef2a3faa5c6ffad5bf69afdde2ee0f21585d690004e6ad9f3874e61d7a33`.
The uncompressed raw JSON hash is
`dae75908f43ce3dd42f34a6673b840c16d7b2e553f4d837158fd71a50f1f1477`.
The archive also retains the two Bun `--explain=json` outputs, with the
local output-binary path replaced by `<OUTPUT>` in each log header. Temporary source
copies lived next to their original modules to preserve relative imports and
were removed after the experiment.
