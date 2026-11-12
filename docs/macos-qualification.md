# macOS qualification on a physical Mac

**Status:** experimental, recorded 2026-11-06 on one Apple M2 Max (macOS 27.2,
Xcode 27.2, arm64) against `main` at `59cc47a`. It extends the hosted
`macos-15` runs in [native platforms](native-platforms.md) with checks that need
a physical Mac or a second toolchain. It records passed, failed and **not run**
cases for issues [#247](https://github.com/0xPlayerOne/bun-native/issues/247),
[#223](https://github.com/0xPlayerOne/bun-native/issues/223),
[#244](https://github.com/0xPlayerOne/bun-native/issues/244),
[#249](https://github.com/0xPlayerOne/bun-native/issues/249),
[#250](https://github.com/0xPlayerOne/bun-native/issues/250),
[#248](https://github.com/0xPlayerOne/bun-native/issues/248) and
[#297](https://github.com/0xPlayerOne/bun-native/issues/297). Nothing here is
signed or notarized, and nothing was run on Windows.

The session could not post CoreGraphics events, so no synthesized pointer or key
reached a window. Every case that needs one is marked **not run**.

## Native fault containment (#247)

[`native-fault-macos.py`](../scripts/quality/native-fault-macos.py) drives
[`tests/native/fault.ts`](../tests/native/fault.ts) `host-crash` against the real
release host. It stops the owned host with `SIGSTOP`, queues two batches behind
it, kills it with `SIGKILL`, and requires one shared `NativeHostExitError`
(`reason: signal`, `SIGKILL`), both queued batches rejected with that same
error, zero ownership counters and no surviving host process. It rechecks the
host's PID, start time and executable path before each signal.

| Case                                                                       | Development | AOT     |
| -------------------------------------------------------------------------- | ----------- | ------- |
| Stop and kill with two queued batches, no OS click (`--no-os-click`)       | Passed      | Passed  |
| Same with a real OS click parking a public callback, aborted by the crash  | Not run     | Not run |
| Startup failure (Linux uses an invalid `DISPLAY`; macOS has no equivalent) | Not run     | Not run |
| A real GPUI-internal panic or abort                                        | Not run     | Not run |

`native-platforms.yml` now runs the click variant in both modes on hosted macOS
(step "Development and AOT native fault containment", which runs
[`native-fault-windows.py`](../scripts/quality/native-fault-windows.py) on Windows), where posting
works. [`test_native_platform_fault_macos.py`](../tests/quality/test_native_platform_fault_macos.py)
covers the driver's process-ownership guards.

## Hit-testing controls (#297)

The three AppKit/WindowServer controls described in
[macOS input target verification](macos-hit-testing.md) compiled with `-Werror`
and passed on this Mac: pointer-event and target-guard construction (11 window
target controls), owned click-through and input-taking overlays, and a real
cross-process foreign window. No input was posted. The record is
[`platform-macos-hit-testing-physical-2026-11-06.json`](../tests/native/evidence/platform-macos-hit-testing-physical-2026-11-06.json),
with source and helper hashes. It supersedes the stale hashes in the earlier
record. It still does **not** show GPUI input delivery.

## Reproducible builds (#223)

| Check                                                                                                                                                                                          | Result                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Two clean AOT builds of the generated app ([`build-reproducibility.test.ts`](../tests/tooling/build-reproducibility.test.ts), [`host-archive.test.ts`](../tests/tooling/host-archive.test.ts)) | Passed on macOS arm64 (the ad-hoc Mach-O signature is deterministic here) |
| Two clean release hosts, same commit, different source **and** target directories                                                                                                              | **Differ:** `293ed01f…` and `7b913ea8…` (9,238,912 bytes each)            |
| Two clean release hosts, same commit, different source directories, same target directory                                                                                                      | **Identical:** `37ddecc…` both times                                      |
| This Mac vs the hosted `macos-15` host at `6624d44` (Xcode 16.4, `/Users/runner/...`)                                                                                                          | Differ: `6fc23ade…` here, `540709e4…` hosted. Not a like-for-like pair    |

Cause of the first difference: the `gpui_apple` build script compiles the Metal
shaders from `$OUT_DIR`, and the absolute `…/build/gpui_apple-<hash>/out/shaders.metal`
and `shaders.air` paths end up in the host (34 occurrences). `LC_UUID` follows the
content, so it differs too. `--remap-path-prefix` does not reach the Metal
compiler. **A macOS host is therefore reproducible only for an identical absolute
`CARGO_TARGET_DIR`.** Hosted runners share one workspace path, so that holds there.
The last row is not evidence either way: the Xcode, SDK, linker and target path
all differ. Closing it needs two hosted runs of one commit, or a fixed path on
both sides. Linux and Windows results are not affected.

## Equivalent-workload benchmark on hardware Metal (#244)

[`benchmarks/comparison/run.ts`](../benchmarks/comparison/run.ts) now samples RSS
through `ps` and load through `sysctl` on macOS. One run, `--trials 5`, passed:
6 first launches, 6 calibrations and 30 measured launches, none failed or
retried, all six calibrations painting identical trees on the same `Apple M2 Max`
Metal device. See the
[record](../benchmarks/comparison/results/macos-arm64-m2max-metal-2026-11-06/README.md).

The Mac was reached through Screen Sharing (a 4K virtual display), on AC power,
with other load uncontrolled. The numbers describe this setup only.

### Electrobun system-WebView baseline

[`benchmarks/electrobun/`](../benchmarks/electrobun/README.md) ports the same
workload (label, button, 32 keyed rows; 1,000 updates, 100 coalesced groups,
1,000 keyed rotations, 100 mount/update/dispose cycles) to a DOM in Electrobun
2.0.6 using the macOS system WebKit. Five measured launches plus a first launch
all passed.

| Median of 5 launches                | Bun Native core/AOT                 | Bun Native solid/AOT | Bun Native react/AOT | Electrobun (WebKit)                                         |
| ----------------------------------- | ----------------------------------- | -------------------- | -------------------- | ----------------------------------------------------------- |
| spawn to view mounted (ms)          | 529                                 | 530                  | 500                  | 445                                                         |
| peak RSS, app plus native host (MB) | 129                                 | 130                  | 133                  | 132 plus 89 WebKit helpers = 220                            |
| shipped size                        | 56 MB app + 9 MB host, uncompressed | 56 MB + 9 MB         | 57 MB + 9 MB         | 33 MB `.dmg`, 32 MB `.app` before first launch, 93 MB after |

The Electrobun RSS includes WebKit helper processes (`com.apple.WebKit.*`) that
appeared during the run. They are launchd XPC services, not children, so the
figure is a heuristic upper bound that would also count unrelated WebKit work.

**What is not comparable:** the DOM has no host acknowledgement, so operation
timings are DOM mutation time (below the WebKit timer's 1 ms resolution) and time
to the next animation frame (17 ms, the 60 Hz vsync). Do not set them against the
Bun Native acknowledgement medians (about 0.1 to 0.2 ms). Per-operation latency,
GPU use and input latency were not measured on macOS. CPU time is recorded by the comparison runner, and the direct Rust GPUI baseline (`benchmarks/rust-gpui`) has been recorded on Linux only.
The Electrobun CEF renderer was not built.

## Install, update and rollback on macOS (#249, unsigned only)

Run on a temporary root with a real `bun run native build` package (56 MB
`application`, 9.2 MB host) and `scripts/release-update.ts`. Developer ID signing
and notarization were not attempted, by decision.

| Case                                                                                                   | Result                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build output signature                                                                                 | `application` and the host are linker-signed ad hoc (`flags=adhoc,linker-signed`), `codesign --verify --strict` passes, no team identifier                    |
| Unsigned-experimental install, integrate, update to 1.1.0, tampered payload, rollback to 1.0.0, replay | Passed. The tamper was rejected (`integrity: launcher.ts exceeds its declared 185 bytes`), the replay was refused (`downgrade`), `data/` was preserved        |
| Installed binaries after install, update and rollback                                                  | `codesign --verify --strict` passes for both releases                                                                                                         |
| `Qual App.app` wrapper opened with `open -n`                                                           | Started the installed `application` and host with `BUN_NATIVE_DATA_DIR` set; `SIGTERM` ended both                                                             |
| Launcher after rollback                                                                                | Started 1.0.0; `SIGTERM` ended both                                                                                                                           |
| Uninstall keeping data, then `--purge-data`                                                            | Passed                                                                                                                                                        |
| Gatekeeper, `spctl --assess` of a quarantined copy of the wrapper                                      | **Rejected** (`no usable signature`); still **rejected** after `codesign --force --deep --sign -` (valid on disk). The payload `application` is also rejected |
| `.dmg`, `.pkg`, a real `.app` holding the release, Finder double-click, clean-machine run              | Not run                                                                                                                                                       |

An ad-hoc signature does not satisfy Gatekeeper for a downloaded app. Until a
Developer ID signature and notarization exist, a user must remove the quarantine
attribute or approve the app in System Settings. This was not exercised with a
real download.

## Workspace references (#250, #248)

Not run in this physical session, which could not post events. Since
[#582](https://github.com/0xPlayerOne/bun-native/pull/582) the hosted `macos-15`
job runs both workspace references with the unchanged Linux scenarios (keys,
text, wheel, resize and OS close) in development and AOT
([Validation 42746456002](https://github.com/0xPlayerOne/bun-native/actions/runs/42746456002)).
That run is hosted, not physical; a physical run needs event posting granted to
the controlling process ([runbook](real-machine-validation.md#macos-workspace-references-248-250)).
The same step also runs a bounded 120 s long session of each workspace soak
fixture in development and AOT, with CoreGraphics typing, Return and wheel input
every round ([long session on a physical Mac](real-machine-validation.md#long-session-on-a-physical-mac-248-250));
on hosted CI that is still a VM.

## Remaining

- Windows for every item above (no device was available).
- Click-variant fault containment, workspace scenarios and GPUI input on this Mac
  need CoreGraphics event-posting permission for the controlling process
  (workspaces run on hosted macOS since #582).
- Developer ID signing, notarization, installer formats and a Finder or
  Gatekeeper run on a real download (#249).
- Two hosted macOS builds of one commit to settle cross-runner hashes (#223).
- Per-operation, CPU/GPU and input-latency numbers for the Electrobun baseline,
  and a CEF variant (#244).
