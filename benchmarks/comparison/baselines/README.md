# Regression baselines

Each JSON file here is a metrics file for
[`scripts/quality/regression-check.ts`](../../../scripts/quality/regression-check.ts),
produced by `bun benchmarks/comparison/metrics.ts export` from one passed hosted
[Benchmark comparison](../../../.github/workflows/benchmark-comparison.yml) run. The
workflow's `gate` step compares every new run with the file whose
`environment.label` is identical (OS release, CPU count and model, renderer and
cache state). Hosted `ubuntu-24.04` runners come with different CPU models, so
there is one file per model. A run on a model with no file is recorded and
reported, not gated: samples from different hardware are never compared.

Every sample is one fresh process from a measured trial (5 per adapter/mode
here). Warmup launches, failed launches and pooled operation samples are not
samples.

| File                                             | Run                                                                               | Source commit                     | Trials | CPU                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------- | ------ | --------------------- |
| `linux-x64-ubuntu-24.04-epyc-9v74-llvmpipe.json` | [42361841424](https://github.com/0xPlayerOne/bun-native/actions/runs/42361841424) | `d67794d1` (PR #557 head)         | 5      | AMD EPYC 9V74, 4 vCPU |
| `linux-x64-ubuntu-24.04-epyc-7763-llvmpipe.json` | [42360358389](https://github.com/0xPlayerOne/bun-native/actions/runs/42360358389) | `f27d44be` (PR #557 earlier head) | 5      | AMD EPYC 7763, 4 vCPU |

Both runs used Bun `1.4.4-canary.1+b1007f117`, a release host and the software
Vulkan renderer (llvmpipe) on Xvfb, with an uncontrolled page cache. A third
passed run on an EPYC 7763 ([42358377765](https://github.com/0xPlayerOne/bun-native/actions/runs/42358377765),
`fa5c8117`) compared against the 7763 file shows no regression: every per-launch
metric is `unchanged` or `improved`, and two click-to-paint medians are
`suspected` with intervals that include no change (runner noise).

Streaming-list metrics (`streaming solid/aot ...`) are recorded by the workflow
but are not in these files yet, so they are listed as "recorded without a
baseline value" and not gated.

## Adopt or refresh a baseline

1. Take a passed scheduled or dispatched run on `main` with at least 5 trials.
2. Download its `benchmark-comparison-linux-X64` artifact and copy `metrics.json`
   here as `linux-x64-<release>-<cpu>-<renderer>.json`. Two files must never
   share a label.
3. Add a row above with the run, source commit and CPU.

Replacing a baseline after a measured slowdown is a recorded tradeoff, not a
refresh: add an `accepted` entry with its ADR and upper ratio instead (see the
regression gate in [`docs/engineering-quality.md`](../../../docs/engineering-quality.md)).
