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
[docs/macos-qualification.md](../../docs/macos-qualification.md).

Not measured: per-operation latency comparable to Bun Native, CPU/GPU use, input
latency, the CEF renderer, other platforms.
