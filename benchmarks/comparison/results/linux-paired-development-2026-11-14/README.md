# Paired Linux Core development input

[Hosted run 43633651805](https://github.com/0xPlayerOne/bun-native/actions/runs/43633651805)
compared main base `15878c8be33a5e2e551ec410efa913d766322d58` with PR source
`6e6f332be4d7a33efb9cbb10d9eb1c9c5c1320e6` on a four-vCPU Intel Xeon Platinum
8573C Ubuntu 24.04.5 llvmpipe runner. All 20 alternating pairs passed the
calibrated tree, XTest input, native paint and cleanup checks. The compressed
`paired-input.json.gz` retains every pair's timing and report hashes, source,
host, module and Bun runtime identities, runner description, load and summary.
Its uncompressed SHA-256 is
`44321908718d976a7bdacea647716e62efbca31a60a186be6212b475d88d2dbb`.
The [full artifact](https://github.com/0xPlayerOne/bun-native/actions/runs/43633651805/artifacts/14129915773)
also retains individual driver and child reports.

Median candidate-minus-baseline was -1.433 ms, with an exploratory paired
bootstrap 95% interval of [-3.774, +1.604] ms. Median paired ratio was 0.867
[0.785, 1.087]; candidate was faster in 12 of 20 pairs. Baseline and candidate
medians were 14.560 and 12.436 ms respectively. A 54.197 ms baseline sample is
retained. The interval assumes independent pairs; runner load and cache were
uncontrolled. This single runner differs from the EPYC 7763 gate runner and the
metric includes XTest and observation overhead. It is not physical input or
presentation latency and does not establish a gain or exclude a regression.
