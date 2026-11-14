# Electrobun system-WebView baseline (#244)

A DOM port of the matched renderer workload (`benchmarks/solid/workload.ts`) running
in an [Electrobun](https://electrobun.dev) 2.0.6 app on the macOS system WebKit.
It gives the Bun Native comparison a WebView reference for process-level metrics.
macOS only.

Equivalent: tree shape (a label, a button, 32 keyed rows), phase counts (1,000
updates, 100 coalesced groups of 10, 1,000 keyed rotations, 100
mount/update/dispose cycles, 20 warmups) and lifecycle.

**Not equivalent:** a DOM has no host acknowledgement. Operation timings are DOM
mutation time (`synchronousSubmission`, below the WebKit 1 ms timer resolution)
and time to the next animation frame (`toNextFrame`, locked to 60 Hz vsync).
Do not compare them with the Bun Native acknowledgement medians.

## Build and run

```sh
cp -R benchmarks/electrobun/app "$(mktemp -d)/app" && cd that-copy
bunx electrobun build --env=stable          # downloads Hutch and Electrobun 2.0.6
cd - && bun benchmarks/electrobun/run.ts \
  --app /absolute/path/build/stable-macos-arm64/workload-baseline.app \
  --output "$(mktemp -d)/electrobun" --trials 5
```

Build outside the checkout: Electrobun writes `build/` and `artifacts/` next to the
project, and the stable `.app` writes its data under
`~/Library/Application Support/dev.bunnative.baseline`, which you can delete.

The runner launches the app once as `first` (reported separately) and then
`--trials` times, never retrying a failure. Each launch reports spawn to main
process, window created and view mounted, wall time, peak RSS of the launcher tree,
and peak RSS of WebKit helper processes (`com.apple.WebKit.WebContent`, `GPU`,
`Networking`) that did not exist before the launch. Those helpers are launchd XPC
services, so the helper figure is a heuristic upper bound that also counts any other
WebKit work that starts during the run.

## Recorded result

[macOS arm64 / Apple M2 Max, 2026-11-06](results/macos-arm64-m2max-webkit-2026-11-06/electrobun.json):
5 measured launches plus a first launch, all passed. Medians: spawn to view mounted
445 ms, process wall 37.6 s (the 2,100 frame-synchronized operations dominate),
peak launcher-tree RSS 132 MB, peak WebKit helpers 89 MB (total 220 MB). Shipped:
33.1 MB `.dmg`, 31.9 MB `.app.tar.zst`; the stable `.app` is about 32 MB when built
and 93 MB after its first launch. Comparison with Bun Native on the same Mac is in
[docs/records/macos-qualification.md](../../docs/records/macos-qualification.md).

Not measured: per-operation latency comparable to Bun Native, CPU/GPU use, input
latency, the CEF renderer, other platforms.

## Visible-input fixture under development

For the shared observer in #677, the reference has an opt-in input mode. An
external controller supplies an absolute `EB_INPUT_CONTROL` path and a random
UUID `EB_INPUT_NONCE`, alongside `EB_OUTPUT`. After the view's initial animation
frame, the fixture creates the control file with its loopback port and nonce.
It also reports the WebKit viewport dimensions for independent geometry checks.
The controller must verify the owned window, inject one OS click, observe the
changed output independently, then POST to `/input/finish` with the nonce in
`x-benchmark-nonce`. The reference reports the click and exits; premature finish,
wrong nonce, malformed click evidence and duplicate clicks are rejected. The
reference records its click locally and sends the report only after the finish
request, outside the click-to-observation interval. The control file must not
already exist. The default workload does not enter this mode.

This fixture has passed hosted owned-window click and composited-capture smoke
checks for both applications. Matching visible geometry does not establish complete
workload equivalence. A WebKit animation frame is not a display presentation timestamp.

`observe-text-macos.m` is a bounded offline Vision OCR helper for a captured
image; it can enlarge a bounded label crop and map observations back to the
original image. `visible-text.ts` validates its text and normalized bounding boxes, and
`visible-pixels.ts` compares a bounded region of two decoded captures. Neither
establishes window ownership or physical presentation. The eventual driver must
calibrate a stable unchanged region before using pixel differences as an arrival
signal, then independently verify the expected text. Record capture, pixel
comparison and OCR costs separately; an OCR result obtained after the change is
not a display timestamp.

The explicit `electrobun-smoke` workflow dispatch builds the pinned reference,
the native release host and an inspected Core/AOT fixture on hosted macOS. It
attempts an owned-window click and guarded composited-display capture for each
sequentially. Each sample also captures the owned window surface and requires an
exact pixel match in the calibrated label region; it records any overlapping
window bounds. It retains screenshots and failures, and rejects forced cleanup.
This is a qualification attempt, not the paired comparison or a physical
display-presentation timestamp. Window-order checks immediately before and
after capture cannot rule out a transient overlay between them.

```sh
gh workflow run benchmark-comparison.yml --ref <candidate-branch> -f electrobun-smoke=true
```

To collect fresh-process controls and alternating comparisons, add
`-f paired-macos=true -f paired-macos-trials=10`. The job first qualifies both
fixtures, then runs one warmup per variant, three A/A pairs per variant and the
requested 3–20 AB/BA pairs. It retains every launch and stops on failure or changed
binary fingerprints or viewport. The captured interval includes observer overhead;
controls expose some noise but do not establish physical presentation latency or
justify a general product ranking. The changed display capture's command-relative
start and completion are recorded separately from the later surface, guard and
pixel verification; the exact instant represented by the capture is unknown.
