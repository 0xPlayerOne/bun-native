# Empty event registry fast path

`EventBindings.prepare` returns after event-type lookup when its registry has no
bindings. Native event path, ownership and input revision checks occur before
this method; message-dialog handling also runs first. Nonempty registries use
the existing capture and bubble traversal. This avoids two path walks for a
listener-free window; it does not skip native event validation or change event
delivery.

## Matched batched probe

On an Apple M2 Max, macOS 27.2, pinned Bun `1.4.4-canary.1+b1007f117`, other
load and power state uncontrolled, the checked-in `probe.ts.txt` measured
10,000 `prepare` calls per timed batch with 25 timed batches per process after
10 warmups. It rotates through 251 registries to avoid repeatedly calling one
statically fixed object. `empty` has no bindings; `off-path` has an unrelated
binding; `target` registers one listener and releases every prepared plan.
Each batch checks the number of plans. `EVENTS_FILE` is a placeholder replaced
with a temporary source copy's filename before compilation.

The first cohort used 12 alternating fresh-process pairs starting candidate
first; the second used 20 pairs starting baseline first. Each row reports the
median of within-pair differences in per-process median nanoseconds per call.
The 95% percentile intervals resample process pairs 10,000 times (seed 673)
and assume independent pairs; they do not remove temporal or runner bias.
Both AOT executables passed compiled-program and JIT-unused inspection.

| Cohort          | Mode        | Empty delta (95% interval), ns | Faster pairs | Target delta (95% interval), ns |
| --------------- | ----------- | -----------------------------: | -----------: | ------------------------------: |
| Candidate-first | development |        -13.38 [-13.50, -12.80] |        12/12 |             -3.04 [-8.44, 4.59] |
| Candidate-first | AOT         |        -35.06 [-35.31, -34.99] |        12/12 |             +4.53 [0.19, 11.10] |
| Baseline-first  | development |        -14.04 [-16.83, -13.47] |        20/20 |            -9.10 [-19.91, 6.46] |
| Baseline-first  | AOT         |        -35.15 [-35.38, -34.65] |        20/20 |            -5.64 [-11.33, 0.69] |

The target guard does not establish a consistent gain or regression: the AOT
cohorts moved in opposite directions. Compiler specialization of this synthetic
loop remains possible. The empty case benefits by tens of nanoseconds per call;
this does not establish input-to-display latency or app-wide speedup. Raw
per-batch samples and compiler explanations are retained here. Compiler log
headers replace the local binary path with `<OUTPUT>`.

Baseline `events.ts` SHA-256:
`9070622fc0abf243c43a8f636d761466603cc2c965955f039d8631d90a438a90`;
candidate SHA-256:
`1636b25a94f4d7998cfffd6b0ee57b573965d73fcb4ff6bc748bf3523837bcc0`.
Probe SHA-256:
`3e80df96019abc8a6e9edf3f454ef50c297cef642819ba5f044cb52d4f008f74`.
Baseline and candidate AOT executable SHA-256 values in both cohorts were
`24ca8077d6ec00382abbefd41d02a795f31526d8bc2081b7268c8b8191b3f3a8`
and `ec75eb3f6bdf43d4a6c2d24b72bbfc6f485578a02e5e57aec31acd4045e24ac9`.
Uncompressed candidate-first and baseline-first JSON SHA-256 values were
`658069b035dc21ffe7dc22be277c891bc0f772ccec5454ec408980c1ff515033`
and `88cc8130f35fd6a355d6c659476c36af0bc581899e07497ce03657e8badbf415`.

## Hosted paired reproduction

The manually dispatched `event-registry-pairs` workflow job runs 12 alternating
fresh-process pairs per mode on Linux and macOS using the pinned toolchain.
It constructs the baseline by removing only the fast-path line from the exact
candidate source and records source, probe, and executable hashes. Its separate
`benchmarks/core/event-registry-pair-probe.ts.txt` adds a mixed case with both
empty and listener-bearing registries in the same loop. It preserves per-batch
samples, compiler logs and AOT inspections as workflow artifacts. Trigger it
with `paired-only=true`, `startup-only=true`, and `paired-macos=false`.
Like the original probe, this measures synthetic routing work, not end-to-end
input latency; compiler specialization and runner noise remain possible.

The [hosted run](https://github.com/0xPlayerOne/bun-native/actions/runs/43627155844)
completed at `0c5a8a66`. Raw process samples are retained in
`hosted-linux-pairs.json.gz` and `hosted-macos-pairs.json.gz`; executable
inspections and compiler logs are in the run artifacts. Each cell below is the
median paired candidate-minus-baseline nanoseconds per call, with a 95%
percentile interval over 10,000 process-pair resamples (seed 673). Every empty
case was faster in all 12 pairs.

| Runner      | Mode        |                   Empty |             Off-path |                  Target |                   Mixed |
| ----------- | ----------- | ----------------------: | -------------------: | ----------------------: | ----------------------: |
| Linux x64   | development | -17.02 [-33.48, -14.69] |   +0.59 [0.07, 0.92] |   -23.28 [-75.01, 5.60] | -35.57 [-50.45, -21.27] |
| Linux x64   | AOT         | -35.12 [-62.70, -34.18] |  -0.35 [-1.23, 0.71] |     -3.97 [-8.48, 1.62] | -22.65 [-25.07, -19.22] |
| macOS ARM64 | development | -13.84 [-14.73, -12.61] |  -1.64 [-3.92, 2.33] | +31.76 [-11.45, 157.87] |  -9.79 [-103.04, 92.28] |
| macOS ARM64 | AOT         | -39.83 [-45.23, -39.14] | -2.40 [-6.60, -0.75] |   -15.49 [-43.69, 3.58] |  -21.30 [-32.61, -0.87] |

The Linux development off-path baseline was 33.17 ns/call, making its observed
+0.59 ns change a small regression. Target intervals and the macOS development
mixed interval include zero. Shared-runner noise and the assumption of
independent pairs limit the intervals; the results do not measure display
latency.

Recompute either table from the archived pairs, including validation of process
order, workload samples and Bun revision, with:

```sh
python3 benchmarks/core/analyze-event-registry-pairs.py benchmarks/results/empty-event-registry-macos-2026-11-14/hosted-linux-pairs.json.gz
python3 benchmarks/core/analyze-event-registry-pairs.py benchmarks/results/empty-event-registry-macos-2026-11-14/hosted-macos-pairs.json.gz
```
