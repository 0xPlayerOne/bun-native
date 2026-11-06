# Bun `b1007f117` trial: retention flake counts against `da867c60b`

**Status:** trial pin evidence for [#287](https://github.com/0xPlayerOne/bun-native/issues/287). Local Linux x64 only. It does not qualify macOS, Windows or the hosted first-window timeout [#296](https://github.com/0xPlayerOne/bun-native/issues/296).

Measured on November 6, 2026 on source `a0e60de` plus the pin change, Linux x86_64 with four shared vCPUs (Intel Xeon). The release host was `target/release/bun-native-host` from the same source, SHA-256 `d6340497dbdfd5793b5c0d02d623121843c145f63b45860744543bbf48a750e9`. The environment used Xvfb `21.1.12-1ubuntu1.9` and Mesa llvmpipe/lavapipe `25.2.8-0ubuntu0.24.04.4`.

| Label | `bun --revision`           | npm package                                   | Linux x64 executable SHA-256                                       |
| ----- | -------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| old   | `1.4.4-canary.1+da867c60b` | `@oven/bun-linux-x64@1.4.4-canary.20261029.1` | `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810` |
| new   | `1.4.4-canary.1+b1007f117` | `@oven/bun-linux-x64@1.4.4-canary.20261105.1` | `8f55345e8a878f2b4f9b233184ffa424fdd67667fa70c16b1f11a1ae8387e9ab` |

`node scripts/install-bun.mjs` installed the new executable from the committed `toolchain.json` pin. Its downloaded integrity and executable SHA-256 matched the values above.

## Method

Old and new trials were interleaved. Even-numbered trials ran old then new, and odd-numbered trials ran new then old. Two trials ran at a time, so each pair of builds saw the same load. Every recorded outcome is counted, with no retries and no trials dropped. The workload trials used `benchmarks/solid/workload.ts` builds and the unchanged assertions and checkpoints. A **failure** means the run exited non-zero because `retentionObservation.stillReachable` was not empty, which is the existing assertion after two fixed `sleep`/`gc(true)` checkpoints. **First-checkpoint** counts how often `firstReachable` was non-empty. That is a diagnostic only and never fails a run.

- Core and Solid builds were made by `scripts/solid-build.ts` (`benchmarks/solid/direct.ts`, `reactive.tsx`) and then `bun compile --no-script --production` with each Bun. The development module bytes are identical for both Buns.
- React builds were made by `experiments/aot-gpui/build-window.ts --entry react-workload --host-profile release` with each Bun. The old build ran from a clean checkout of the same commit, because the script refuses a Bun that does not match `toolchain.json`. The two development bundles differ only in `debugId`.
- Each trial ran in its own `xvfb-run` and `dbus-run-session` through `scripts/quality/native-linux-session.sh`, with the argument sets used by `.github/workflows/native-linux.yml`. "Timed" means `--iterations 1000 --rotations 1000 --mounts 100 --rows 32` (React timed uses `--mounts 1000`). "Calibration" means `--iterations 10 --rotations 10 --mounts 2 --rows 32 --calibration`.
- The 1-minute load average while the workload trials ran was 2.66 on average, with a maximum of 3.81. Batch one (2,000 trials) took 955 s, and batch two (600 trials) took 435 s.

## Native workload trials

| Cell                                        | Old failures | New failures | Old first-checkpoint | New first-checkpoint       |
| ------------------------------------------- | -----------: | -----------: | -------------------: | -------------------------- |
| Core AOT, timed                             |        0/200 |        0/200 |                0/200 | 0/200                      |
| Core development (DFG on), timed            |        0/200 |        0/200 |    53/200 (297, 298) | 48/200 (297, 298)          |
| Solid AOT, timed                            |        0/200 |        0/200 |                0/200 | 200/200 (297, 298 or 298)  |
| React AOT calibration (CI)                  |        0/200 |        0/200 |                0/200 | 200/200 (1–5)              |
| React AOT, timed, 1,000 mounts              |        0/100 |        0/100 |                0/100 | 99/100 (2997–2999 or 2997) |
| React development calibration, DFG on       |       34/200 |       42/200 |               38/200 | 42/200                     |
| React development calibration, DFG off (CI) |        0/200 |        0/200 |     200/200 (3, 5 …) | 0/200                      |

The React DFG-on difference, 34 against 42, is not significant (two-sided Fisher p = 0.37). Both builds kept probes 3 and 5, as in [settled-collection.md](settled-collection.md). The configuration the required check uses (DFG off) was clean on both builds.

The core AOT cell did **not** reproduce the historical 15/299 on the old pin at this source. So these trials cannot show a fix of the AOT residue in the real workload. They show only that the new pin does not make it worse.

**Behavior change:** on the new Bun, the AOT executables still hold the final mount's probes at the _first_ collection checkpoint, in every Solid and React AOT trial. The second checkpoint releases them every time, so the unchanged assertion passes. The old Bun shows the reverse pattern for React development with DFG off. This is new-runtime timing, not an application edge. However, any future check that has only one checkpoint would fail on AOT with the new pin.

## Framework-free upstream reproducer

`/mnt/project-files/adea/bun-native-flakes/287/upstream/aot-eden-retention.js` (SHA-256 `6c5627c368b219509da8fc7d918f56565a6b3097727b79a25958e3a8ec18ff2e`) was built with each Bun's own `bun compile aot-eden-retention.js` and no other flags. Old executable SHA-256: `007a6631…c32c`. New: `5776ed5a…a7fa5`. A run that exits 1 kept the disposed view through five full collections.

| Run                                  |     Old |   New |
| ------------------------------------ | ------: | ----: |
| AOT, `GC=reader` (eden GC in reader) | 200/200 | 0/200 |
| AOT, `GC=timeout`                    |  47/200 | 0/200 |
| AOT, `GC=none` (control)             |   0/100 | 0/100 |
| `bun run`, `GC=reader`               |   0/100 | 0/100 |

The new build is clean in 400 injected-eden AOT runs that fail on the old one (timeout variant: p < 1e-15). As the earlier recheck noted, this cannot tell whether `b1007f117` fixes the root or only moves the allocation-layout trigger.

## Required collectability tests and DFG control

The `tests/renderers/collectability-scenarios.ts` children ran 200 times per cell, interleaved, exactly as `collectability.ts` spawns them.

| Scenario                                  | DFG | Old non-empty | New non-empty |
| ----------------------------------------- | --- | ------------: | ------------: |
| `solid-roots`                             | off |         0/200 |         0/200 |
| `solid-roots`                             | on  |         0/200 |         0/200 |
| `revoked-callbacks`                       | off |         0/200 |         0/200 |
| `completed-callbacks`                     | off |         0/200 |         0/200 |
| `unreleased-callback-control` (must be 1) | off |   200/200 [6] |   200/200 [6] |

The negative control still detects the one unreleased callback on both builds.

`bun --conditions=browser benchmarks/retention/solid-collection-control.ts fixed 500` ran twice per cell, alternating order:

| DFG      | Old failed trials | New failed trials |
| -------- | ----------------: | ----------------: |
| enabled  |   11/1000 (5 + 6) |   10/1000 (4 + 6) |
| disabled |            0/1000 |            0/1000 |

The DFG retention described in [settled-collection.md](settled-collection.md) is unchanged on the new Bun, so the `BUN_JSC_useDFGJIT=0` collectability children remain necessary.

## Native diagnostics, new Bun only

The `.github/workflows/native-linux.yml` step "Development and AOT native failure, scheduling, layout and interaction contracts" ran three times with the new Bun. It covered `startup-failure`, `host-crash`, `scheduling`, `scheduling-control`, `layout` and `interactions`, each in development and in AOT. The AOT packages came from `build-window.ts` with the new compiler. Result: 36/36 passed. This environment cannot reproduce the hosted llvmpipe first-window open timeout (#296), so only a hosted `Native Linux` run can show whether the new pin changes it.

## Not established

- macOS and Windows: their four npm integrity values were checked against `npm view` metadata only. No executable ran.
- Linux arm64: the same applies.
- Hosted CI timing, including #296 and #358.
- Whether the upstream root is fixed or only moved, as discussed above.
