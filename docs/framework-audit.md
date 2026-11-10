# Framework audit and optimization record (#260)

This record tracks completed audit and optimization evidence for
[#260](https://github.com/0xPlayerOne/bun-native/issues/260). It links problems
removed or measured and the remaining backlog. The broader audit remains open
until its acceptance criteria are met; this record makes no new performance claim.

## Hygiene

Ready-PR validation runs these checks, rather than relying on a one-time audit.
Draft validation stops before the implementation and CodeQL checks execute:

| Check                                     | What it rejects                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `check:health`                            | unreachable modules and internal-only exports                          |
| `check:boundaries`                        | package imports that cross the documented layering                     |
| `check:duplicates`                        | duplicate dependency versions                                          |
| dead-reference and doc-link quality tests | stale paths, missing link targets, docs/API drift (`api-reference.md`) |
| `oxlint --deny-warnings`, `bun --check`   | lint and type errors in packages, scripts, tests, examples, benchmarks |
| `cargo clippy -D warnings`, `ruff`        | Rust and Python warnings                                               |

The one-time dead-code pass (knip 5.66, each result checked by hand, #623) found
six unused script exports and removed them. Everything else it reported is a direct
entry point, a test import or a tool config. There is no retired CEF or Bunly
code path left: the only references are disclaimers that the packages use no
WebView or CEF (`packages/core/README.md`, `packages/react/README.md`) and
historical audit records.

## Profiling and optimization

Every item below has raw data in the linked record, and every candidate change was
measured before a decision.

| Path                         | Finding                                                                                                                                                                                                                          | Decision                                      | Record                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bridge acknowledgement tail  | Native prepare/apply/reply is p50 about 0.03 ms. The tail is the roughly 2% of requests that wait behind a full 1,001-node render on the UI thread.                                                                              | No bridge change; frame cost decides the tail | [BRIDGE.md, phase attribution](../benchmarks/BRIDGE.md#phase-and-render-attribution-297)        |
| Per-node pointer listeners   | They cost 8 allocations per node per frame. A same-semantics hitbox registry removed them and passed pointer, overlay and popup tests, but frames got about 10% slower in 5 of 5 pairs.                                          | Not adopted; listeners stay                   | [pointer registry](../benchmarks/results/pointer-registry-2026-11-10/README.md)                 |
| Host CPU during the bridge   | `perf` over a whole bridge run (Linux, lavapipe): about two thirds of the host's user-space samples are host and GPUI code and about a quarter is lavapipe rasterization. The top host symbol, `NativeView::apply`, is about 6%. | No hot spot worth a change at this load       | this section                                                                                    |
| Watch compiler memory        | RSS growth came from mimalloc's purge delay keeping freed bundler pages resident, not from a retained object.                                                                                                                    | `MIMALLOC_PURGE_DELAY=0` for the CLI (#448)   | [tooling controls](../benchmarks/tooling/README.md)                                             |
| Solid transform              | Babel garbage is collectable; reusing the preset changed nothing.                                                                                                                                                                | No change                                     | [Solid stages](../benchmarks/tooling/results/solid-transform-linux-x64/README.md)               |
| Sustained native watch       | Over 601 real edits, controller RSS levels off after about 100 edits. React keeps about 6 KB per edit of residual growth, and edit-to-paint time does not degrade.                                                               | No architecture change                        | [sustained watch](../benchmarks/tooling/README.md#sustained-native-watch-601-edits-november-10) |
| AOT heap retention (#287)    | Reproduced 19/60 on the old Bun pin and 0/60 on the current pin.                                                                                                                                                                 | Fixed by the Bun pin                          | #287                                                                                            |
| Framework and execution mode | Core, Solid and React in development and AOT, with a direct Rust GPUI baseline, on Linux and macOS. A scheduled regression gate runs against committed baselines.                                                                | Gate at 25% (hosted VMs vary 12–15%)          | [COMPARISON.md](../benchmarks/COMPARISON.md), [Rust GPUI](../benchmarks/rust-gpui/README.md)    |

## Lifecycle, failure and packaging audits

- Crash and failure: host panic, malformed payload, version mismatch and offline
  cases each have a deciding test ([qualification matrix](qualification-matrix.md)),
  including the CI-only host panic fault (#621).
- Updates: versioned manifests, the verifying launcher with health rollback,
  refused interrupted or incompatible installs, and a real `native build` app
  that confirms its own health (#618; [update lifecycle](update-lifecycle.md)).
- Packaging: macOS and Windows CI create, check and AOT-build all four templates
  (#254). Two independent hosted builds of the release host are byte-identical on Linux, macOS and Windows ([reproducible builds](reproducible-builds.md)).

## What limits release scope

These are tracked honestly as open and are not CI work:

| Limit                                          | Why it is open                                          | Issue      |
| ---------------------------------------------- | ------------------------------------------------------- | ---------- |
| OS code signing and notarization               | no Apple Developer ID or Windows certificate            | #249, #223 |
| Screen readers and OS IME composition          | needs VoiceOver/NVDA/Orca and real input methods        | #241, #222 |
| Multi-monitor, hotplug and mixed DPI           | CI runners have one virtual screen                      | #299       |
| Babel 8                                        | no Solid preset release supports it yet                 | #316       |
| Hosted first-window deadline                   | has not recurred; the startup trace is ready if it does | #296       |
| Physical GPU, Windows and real-Mac performance | hosted runners use software or paravirtual GPUs         | #244       |
| Release-readiness decision                     | depends on the rows above                               | #245       |

## For a fresh agent

[Getting started](getting-started.md), [development](development.md),
[testing](testing.md) and the [API reference](api-reference.md) cover clone,
validate, build and package. [Architecture](architecture.md) and the
[decision records](decisions/README.md) explain the package and host boundaries.
