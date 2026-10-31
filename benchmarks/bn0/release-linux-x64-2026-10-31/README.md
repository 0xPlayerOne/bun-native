# BN0 hosted Linux release-host evidence

This directory preserves **20 original files, 340,931 bytes**, from GitHub Actions artifact `13034880706` for [run 41179568675](https://github.com/0xPlayerOne/bun-native/actions/runs/41179568675). The actual native job [124474016479](https://github.com/0xPlayerOne/bun-native/actions/runs/41179568675/job/124474016479) passed its release GPUI build, development/AOT input checks and all 12 baseline trials. **The overall historical workflow failed its Windows protocol job and aggregate Gate.** These records do not describe that workflow as successful.

The subsequent Windows test correction and complete native-integration validation passed in [run 41180169500](https://github.com/0xPlayerOne/bun-native/actions/runs/41180169500), and [#266](https://github.com/0xPlayerOne/bun-native/pull/266) merged as `2c04f0ed991e8b5c5eecf56c9e07cbe3196e452c`. The [BN0 audit](../../../docs/bn0-audit.md) records the remaining #273 checks/merge and scope limitations. These historical files remain unchanged when later fixes or measurements land.

## Provenance and retained files

[provenance.json](provenance.json) maps every original artifact path to its committed path, byte length and SHA-256. Original JSON files have a `.json.raw` suffix so source formatting cannot rewrite their bytes. They remain ordinary UTF-8 JSON and can be loaded with a JSON parser. The other files keep their original names and bytes.

| Record                                                                                                            | Content                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [Baseline summary](baseline/summary.json.raw)                                                                     | Methodology, platform/renderer, exact manifest, source/harness fingerprints, trial ordering, artifact sizes and all descriptive distributions |
| [Package manifest](package/manifest.json.raw)                                                                     | Genuine AOT command, compiled-program and JIT-removal inspection, source hashes, release-host identity, sizes and compile duration            |
| [Compiler diagnostics](package/compile-aot.stdout.log)                                                            | Original `bun compile --production --explain=json` output                                                                                     |
| [Application sections](package/application-sections.stdout.log)                                                   | ELF section listing; section presence alone is insufficient to prove AOT                                                                      |
| [Application linkage](package/application-linkage.stdout.log) and [host linkage](package/host-linkage.stdout.log) | Actual startup ELF dynamic dependency reports                                                                                                 |
| [Toolchain/environment](toolchain.txt)                                                                            | Source snapshot, kernel, compiler versions and installed native dependency versions                                                           |
| [Native build](build.log)                                                                                         | Original Cargo dependency/build output and timed optimized release completion                                                                 |

All 12 original per-trial reports are retained:

| Phase       | Development/JIT                                        | Machine-code AOT                               |
| ----------- | ------------------------------------------------------ | ---------------------------------------------- |
| Warm-up     | [01](baseline/warmup-01-development/result.json.raw)   | [01](baseline/warmup-01-aot/result.json.raw)   |
| Measured 01 | [01](baseline/measured-01-development/result.json.raw) | [01](baseline/measured-01-aot/result.json.raw) |
| Measured 02 | [02](baseline/measured-02-development/result.json.raw) | [02](baseline/measured-02-aot/result.json.raw) |
| Measured 03 | [03](baseline/measured-03-development/result.json.raw) | [03](baseline/measured-03-aot/result.json.raw) |
| Measured 04 | [04](baseline/measured-04-development/result.json.raw) | [04](baseline/measured-04-aot/result.json.raw) |
| Measured 05 | [05](baseline/measured-05-development/result.json.raw) | [05](baseline/measured-05-aot/result.json.raw) |

This is a selected evidence subset, not the complete hosted artifact. Executables, screenshots and complete event-stream logs are not committed here. The reports retain observations, samples, cleanup outcomes and screenshot/log fingerprints; those fingerprints alone do not reproduce a missing image. Use the linked hosted run/artifact for the larger capture while it remains available.

The manifest is a build-stage record, so its `nativeRendering`, `osInput` and `teardown` fields correctly remain `not-run`. Subsequent per-trial reports provide native execution evidence. Conversely, the input driver's `aot_verified_by_driver: false` is deliberate: it verifies native behavior, while the baseline verifier checks the independently inspected executable manifest and artifact/source fingerprints. A declared mode string alone never qualifies AOT.

## Exact captured scope

The capture began at `2026-10-31T07:18:47.544292+00:00`, from clean checkout `e89d1511708f4230eae3318c9d6acb0612b60ca4` for PR #273 head `06b8859acbc93de721b889867fbb811fd817bada`. All 26 recorded build-source/configuration hashes match that PR head. Later supervisor-cancellation and export-hygiene corrections change current source/harness fingerprints; they do not change these historical hashes.

| Item                      | Observation                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution environment     | GitHub-hosted Linux x86_64; kernel `7.0.0-1017-azure`, glibc 2.39, AMD EPYC 9V45 with four available logical CPUs                                                                                     |
| Native display/input      | Isolated Xvfb X11/Openbox and XTest pointer input                                                                                                                                                     |
| Actual renderer           | llvmpipe, LLVM 20.1.2, Mesa `25.2.8-0ubuntu0.24.04.4`; software emulation reported by GPUI                                                                                                            |
| Bun                       | `1.4.4-canary.1+da867c60b`, revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                                                                                                                       |
| Rust / GPUI               | Rust `1.98.1`; GPUI `0.2.2` at Zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`                                                                                                                         |
| AOT application           | 70,712,360 bytes; SHA-256 `a80e2ba3ab7c4a0cc23d1bd2722b28326dd37e5f9a3ffc9467252cc232a0b556`                                                                                                          |
| Release GPUI host         | 28,669,752 bytes; SHA-256 `4508642dfa90a59c49fa7a22ae20a525cf2a3d77c69c35c7555504c9aa0b9354`                                                                                                          |
| Combined executable bytes | 99,382,112 bytes; excludes system libraries, fonts, archive/installer overhead and installation layout                                                                                                |
| Bun compile wall time     | 1,874.52 ms; one diagnostic build sample                                                                                                                                                              |
| Native build wall time    | 360.22 s for the captured `cargo build --locked --release --manifest-path Cargo.toml -p bun-native-host` command; dependency/index work is included, with `CARGO_BUILD_JOBS=2`, `CARGO_INCREMENTAL=0` |

The AOT executable has the compiled-program bit, and its named `.bun_features` record marks the JIT unused with 27 removed JIT ranges. The interpreter remains present; optional whole-program `--trim` was not enabled. See [AOT inspection](../../../docs/aot-inspection.md) for the decoder, pinned compiler source and genuine JIT negative control.

Neither retained startup linkage report lists CEF, Chromium or WebKit. Startup linkage does not enumerate every runtime-loaded library; Vulkan drivers, fonts and other system resources remain dependencies. The two unsigned executables are not an installed or signed distribution.

## Measured observations and limits

One warm-up per mode runs the complete correctness scenario and is excluded from the distributions. Five measured fresh-process trials per mode alternate execution order, use the identical release host and sample two idle seconds before clicking. All 12 trials received the matching Bun event and changed native paint report, closed through the OS, exited zero and reported no remaining or unreaped observed processes.

| Median of five measured trials         |   Development/JIT |  Machine-code AOT |
| -------------------------------------- | ----------------: | ----------------: |
| Launch to observed window              |         128.05 ms |         129.22 ms |
| Launch to observed first paint report  |         117.98 ms |         118.53 ms |
| Idle combined process-tree RSS         | 156,168,192 bytes | 160,378,880 bytes |
| Sampled peak combined process-tree RSS | 157,442,048 bytes | 161,689,600 bytes |
| OS close to observed application exit  |          26.89 ms |          26.92 ms |

Nominal 100 ms polling limits observation precision. The retained approximately 109 ms input/event/paint observations include automation and polling delay; they are not native input-to-display latency. Paint callbacks are not GPU presentation. Page cache and power state were uncontrolled. RSS summation can count shared pages twice, and sampling can miss the true peak. With five measurements, nearest-rank observed p95 equals the maximum sample and does not establish a stable tail. These records establish no AOT speedup, credible regression, physical-GPU result or arbitrary performance threshold.

Controlled cold-cache startup, time to interactive without the deliberate idle interval, CPU/GPU utilization, physical input/frame latency, long-duration leaks, reload and installed/download size remain unsupported by this baseline. [NATIVE_BASELINE.md](../../NATIVE_BASELINE.md) provides the reproducible recipe and full interpretation; [the audit](../../../docs/bn0-audit.md) assigns follow-up ownership.

## Integrity verification

The audit verified all 20 copies against the supplied original bytes, matched the original manifest fingerprint to the embedded summary, independently recomputed all 16 metric distributions from the 12 raw reports, checked trial/renderer/cleanup consistency and matched all 26 source hashes to the historical PR head. Those are report/source consistency checks; they do not rerun the GUI or rehash executable files absent from this subset.

From the repository root, verify the retained bytes with Python's standard library:

```sh
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path('benchmarks/bn0/release-linux-x64-2026-10-31')
index = json.loads((root / 'provenance.json').read_text())
for item in index['files']:
    data = (root / item['retainedPath']).read_bytes()
    assert len(data) == item['bytes'], item['retainedPath']
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['retainedPath']
print(f"Verified {len(index['files'])} original files")
PY
```
