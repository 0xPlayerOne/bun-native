# Bun Native benchmark methodology

**Status:** A measurement specification, **not** published Bun Native performance results. The old Bunly M2 CEF/browser comparison workbench is obsolete and retained only in Git history. [BN0 #258](https://github.com/0xPlayerOne/bun-native/issues/258) establishes the first native baseline; [BN5 #259](https://github.com/0xPlayerOne/bun-native/issues/259) automates regression canaries; [BN7 #244](https://github.com/0xPlayerOne/bun-native/issues/244) owns full comparisons.

## Rules

1. **Correctness first:** each benchmark verifies the same visible native result and event sequence before timing. A mock, headless-only test, JIT build or browser renderer cannot be mislabeled as a native AOT result.
2. **Pin versions:** source commit, Bun/AOT compiler, native renderer/ABI, Rust toolchain, OS/arch/GPU, runner image, power profile, package versions and fixture data.
3. **Separate mechanisms:** compare Bun development/JIT vs AOT with the same renderer, and renderer alternatives with the same workload. Don't infer native UI benefits from AOT alone.
4. **Repeat trials:** warm up consistently, report raw samples, medians, p95/p99 where meaningful, variance and failed/unsupported runs, not best-of-one screenshots.
5. **Measure full cost:** startup-to-interactive, process-tree RSS/peak, idle CPU/GPU, input-to-paint, frame pacing/dropped frames, bridge traffic, build/reload times, app/download/install bytes and update time.
6. **No invented wins:** establish baselines from a correct native build, explain noise and record tradeoffs. A reproducible unexplained regression around 10% in critical metrics triggers investigation, not an automatic human checkpoint.

## Required fixtures

- Native empty window launch and idle state, repeated across 10+ launches or an explicitly justified sample count.
- Real text/button/input event roundtrip through Bun ↔ native host.
- High-frequency component tree updates and batched bridge calls.
- Solid and React mount/update/unmount with identical shared native elements.
- Streaming conversation view with growing history, scroll/virtualized list and interactive typing.
- 100+ source hot reload cycles, repeated window lifecycle and long-session leak/retention run.
- Release artifact build/install/launch on each supported macOS/Windows/Linux target.

Fixture sizes, sampling intervals and baselines are checked into the benchmark harness when implemented. Avoid fixed thresholds without hardware context.

## Comparators

Use direct Rust GPUI/native rendering and relevant established desktop approaches (including Electrobun WebView/Warren where reproducible) with equivalent functionality. Compare only measurements taken under matching conditions, and label incompatible component/API workload results rather than averaging unlike cases.

## Execution locations

GitHub-hosted Mac/Windows/Linux runners first; the owner's connected Mac via Remote Desktop Commander for real GUI and keyboard/IME interactions when the hosted environment is insufficient. Avoid large persistent Docker/VM images on the Mac.

## Evidence layout

Each run should retain:

```text
commit, build_mode, compiler_version, renderer_sha, abi_version
os, arch, cpu, gpu, memory, power_mode, runner
fixture_id, fixture_revision, expected_behavior, observed_behavior
samples, median, p95, p99, standard_deviation, failures
artifact_hashes, log_links, screenshots_or_video_if_supported
```

There is **no current runnable benchmark CLI for Bun Native**. The old Bunly benchmark scripts remain obsolete until the new harness and CLI are implemented. See [quality policy](../docs/engineering-quality.md) and [testing](../docs/testing.md).
