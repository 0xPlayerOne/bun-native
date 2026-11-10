# Watch controller allocator control

[`controller-allocator.ts`](controller-allocator.ts) isolates the persistent
`native dev --watch` compiler path ([#372](https://github.com/0xPlayerOne/bun-native/issues/372),
[#243](https://github.com/0xPlayerOne/bun-native/issues/243)). Each case is a
fresh Bun process that creates one TypeScript checkout template, then calls the
production `bundleProject` once per distinct label edit, verifies the label in the
bundle and removes the output. Cases differ only in `MIMALLOC_PURGE_DELAY`
(inherited default `100` vs `0`) and run in a fixed interleaved order. No app,
native host, watcher, forced collection or heap walk runs.

```sh
bun benchmarks/tooling/controller-allocator.ts --builds 401 --repeats 3
```

## Linux x64 result

[Raw records](raw/controller-allocator-linux-x64.jsonl): source `15344d56` plus
this harness, pinned Bun `da867c60`, Linux 6.18 (4 vCPU cloud container), all 12
workers exited 0. Medians of the three repeats, VmRSS in MiB after each build:

| Framework | Purge delay | First build | After build 401 |  Peak | Median bundle ms | p95 bundle ms |
| --------- | ----------- | ----------: | --------------: | ----: | ---------------: | ------------: |
| Solid     | default     |        79.5 |           151.3 | 156.3 |             18.6 |          30.8 |
| Solid     | 0           |        72.2 |           117.6 | 124.5 |             24.3 |          40.7 |
| React     | default     |        73.8 |           146.3 | 152.2 |             26.3 |          39.9 |
| React     | 0           |        60.9 |            71.9 |  79.0 |             33.9 |          46.2 |

Exploratory single runs of the same loop (not retained as raw records) located
the cause: React's JavaScript heap stayed near 7 MB while RSS doubled;
`Bun.gc(true)` after each build kept React near 72 MB and Solid near 102 MB,
whereas `bun:jsc` `fullGC()`, `edenGC()` and `Bun.gc(false)` did not bound React.
Writing in-memory outputs instead of using `outdir` grew faster, and dropping
source maps reduced but did not remove growth. Freed bundler pages therefore stay
resident under delayed allocator purging, rather than through a retained
JavaScript owner. Solid's remaining growth tracks collectable Babel transform
garbage that is not forced out here.

The checkout and template `dev` scripts adopt `MIMALLOC_PURGE_DELAY=0` for the CLI
process; the cost is about 6–8 ms median per bundle on this machine, against
edit-to-ready intervals near 200 ms in the native watch run. The table is a
finite compiler-only observation, not native watch RSS, a plateau or a
leak-freedom claim.

## Solid transform follow-up

[`controller-solid-stages.ts`](controller-solid-stages.ts) splits the Solid path
into the full `bundleProject` call, the Babel transform alone, and Bun.build
without per-edit Babel. Its [Linux results](results/solid-transform-linux-x64/README.md)
attribute most of Solid's remaining growth under purge 0 to the Babel stage, with
the live JS heap bounded. They also show that reusing the loaded Babel preset does
not change RSS, so no transform change is adopted.

## Sustained native watch, 601 edits (November 10)

The controls above exclude the native app and host. [`cli-watch.py --edits 601`](../../tests/native/cli-watch.py)
runs the real `native dev --watch` loop with real XTest input and complete native paint
for 601 source edits per framework, six times CI's fixed 101. Each run is one fresh session:
release host, pinned Bun canary `b1007f117`, Xvfb with lavapipe, shared 4-vCPU Linux 6.18
container. The [per-generation record](../../docs/evidence/cli-watch-sustained-601-2026-11-10.json)
keeps controller, application, host and tree RSS and the edit-to-input-confirmed-paint time
for every generation.

Both frameworks completed all 602 generations. That covers the malformed-edit control,
joined replacement, zero-owner teardown and final OS close. React passed outright. Solid
finished every generation and its cleanup, but then failed its final source-identity check,
because the checkout's HEAD was committed while it ran. Its content was the same as
`a587381`, the source of the React run. Inner controller `VmRSS` (MiB) and edit timing:

| Framework | First | Sixth medians (100-edit windows)         |  Last |   Max |    Late fit (last 300) | Edit to confirmed paint, first → last sixth |
| --------- | ----: | ---------------------------------------- | ----: | ----: | ---------------------: | ------------------------------------------: |
| Solid     |  86.2 | 106.8, 118.5, 114.8, 116.1, 117.1, 121.5 | 120.4 | 126.8 | +20.5 KB/edit, R² 0.31 |                                351 → 335 ms |
| React     |  51.7 | 63.0, 64.6, 66.4, 66.5, 66.8, 67.5       |  67.4 |  68.0 |  +5.8 KB/edit, R² 0.70 |                                358 → 365 ms |

Most growth happens in the first 100 edits. After that, Solid moves within about
115–127 MiB, and React keeps a slow, steady rise of about 6 KB per edit, about 3 MiB
over 500 edits. Edit-to-paint time does not degrade. With the earlier findings (allocator
purge delay, adopted; collectable Babel garbage, no change justified), no retaining owner
or architecture change is indicated. Moving compilation into a subprocess would add a
process start to every edit to save a few MiB per hour of editing. This is a finite run on
one machine, not a proof that memory stays bounded indefinitely.
