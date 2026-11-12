# Framework audit and optimization record (#260)

This record tracks the repository-wide audit in
[#260](https://github.com/0xPlayerOne/bun-native/issues/260), which stays open
until its acceptance criteria and dependencies are met. It links each problem
that was removed or measured, and it names the backlog that remains and why. It
summarizes evidence recorded elsewhere and makes no new performance claim.

## Hygiene

Ready-PR validation runs these checks, rather than relying on a one-time audit.
Draft validation stops before implementation and CodeQL checks execute:

| Check                                     | What it rejects                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `check:health`                            | unreachable modules and internal-only exports                          |
| `check:boundaries`                        | package imports that cross the documented layering                     |
| `check:duplicates`                        | duplicate dependency versions                                          |
| dead-reference and doc-link quality tests | stale paths, missing link targets, docs/API drift (`api-reference.md`) |
| `oxlint --deny-warnings`, `bun --check`   | lint and type errors in packages, scripts, tests, examples, benchmarks |
| `cargo clippy -D warnings`, `ruff`        | Rust and Python warnings                                               |

The first dead-code pass (knip 5.66, each result checked by hand, #623) found
six unused script exports and removed them. Everything else it reported is a direct
entry point, a test import or a tool config.

### Second pass (November 11, base `2e2334a`)

`check:health` covers only the six packages, so this pass ran the tools over the
scripts, tests, benchmarks, examples and experiments as well. Each result was
checked by hand.

- **knip 5.66** with every `scripts/`, `tests/`, `benchmarks/`, `examples/` and
  `experiments/` file as an entry and `--include-entry-exports` (a temporary
  config, not committed). It reported 17 exported values that nothing imports
  and that are used only inside their own module. They are now module locals:
  `maximumHealthAttempts` (`scripts/native/installation.ts`), `installerFormats`
  (`installer-image.ts`), `nativeExecutables` (`signing.ts`),
  `maximumKeySetBytes`, `maximumKeys` and `maximumRevoked` (`update-keys.ts`),
  `logLine` (`benchmarks/adapters/workspace.ts`), `fromComparison`
  (`benchmarks/comparison/metrics.ts`), `PATH_LIMIT`, `RETAINER_LIMIT`,
  `VISIT_LIMIT` and `SNAPSHOT_BYTES_LIMIT` (`benchmarks/solid/retention-evidence.ts`),
  `REPLY` and `buttonStyle` (`examples/adea-components`), `headlessPeerRoot`
  (`tests/tooling/headless-peer.ts`), `themes` (`tests/native/layout-style-scene.ts`)
  and `INITIAL_VALUE` (`tests/native/renderer-input-viewport.ts`). No behavior
  changed. Kept on purpose: `lockControlArguments` (a test imports it
  dynamically), `mergeMessages` and `withOlderPage` in
  `examples/adea-components/retained/transcript-history.ts` (retained upstream
  source checked against its Adea blob), the package `index.ts` re-exports and
  Solid compiler helpers (public API), exported types that appear in exported
  signatures, the `tests/types/*` compile fixtures (checked by `bun --check`),
  `tests/native/javascript.js` (run by Native Linux) and `code-foundry` (used by
  `foundry:doctor`).
- **Unused dependencies:** knip found none in the six package manifests and only
  the `code-foundry` false positive at the root. `cargo-machete` 0.9.2 found no
  unused dependency in the five workspace crates.
- **Orphan files:** every file under `scripts/`, `benchmarks/`, `experiments/`
  and `tests/` (except test files) is named by some other tracked file, except
  type-check fixtures and Electrobun's own `electrobun.config.ts`.
- **Duplicate code:** jscpd 4.0.5 (12 lines and 80 tokens minimum) found **no**
  clone in the TypeScript of `packages/*/src`, so the Solid and React adapters
  share no copied code. In `native/gpui-host/src` and `native/protocol/src` it
  found 19 Rust clones (370 lines, 1.3%): 9 in protocol test files and 10 in the
  host. The largest host ones were the D-Bus connection plumbing that
  `services/file_dialogs.rs` and `services/notifications.rs` each owned
  (`spawn`, `link`, shutdown accounting; about 80 lines over four clones). That
  is now one module, [`services/session_bus.rs`](../native/gpui-host/src/services/session_bus.rs):
  the lazily opened connection, its signal listener, the in-flight count and
  bounded shutdown drain, the two-second bound, connection setup and the
  session-bus check. Each service keeps its own registry, match rule, signal
  parsing and failure texts, so behavior is unchanged; the file dialog and
  notification native suites pass unchanged in development and AOT on X11.
  Still kept: the Linux and macOS dialog paths in
  `task_dialogs.rs`/`task_dialogs_macos.rs` (different OS APIs) and the request
  scaffolding in `shortcuts.rs`/`clipboard.rs` (X11 protocol code, not D-Bus).
- **CEF and Bunly references:** no code path remains. `docs/development.md`
  still said CI "must replace" the old M1–M6 CEF workflows; it now says they were
  removed under #251. Left as they are: the disclaimers that the packages use no
  WebView or CEF (`packages/core/README.md`, `packages/react/README.md`), the
  Electrobun WebView benchmark baseline (#244), historical records
  (`bun-native-handoff.md`, ADR 0001, BN0 audit), the `LICENSE` copyright line
  "Bunly contributors" (a legal notice for the owner to change) and the
  first-session steps in `AGENTS.md` that point at the closed #251 and #225
  (agent instructions, also the owner's to change).

## Profiling and optimization

Every item below has raw data in the linked record, and every candidate change was
measured before a decision.

| Path                         | Finding                                                                                                                                                                                                                               | Decision                                      | Record                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bridge acknowledgement tail  | Native prepare/apply/reply is p50 about 0.03 ms. The tail is the roughly 2% of requests that wait behind a full 1,001-node render on the UI thread.                                                                                   | No bridge change; frame cost decides the tail | [BRIDGE.md, phase attribution](../benchmarks/BRIDGE.md#phase-and-render-attribution-297)        |
| Per-node pointer listeners   | They cost 8 allocations per node per frame. A same-semantics hitbox registry removed them and passed pointer, overlay and popup tests, but frames got about 10% slower in 5 of 5 pairs.                                               | Not adopted; listeners stay                   | [pointer registry](../benchmarks/results/pointer-registry-2026-11-10/README.md)                 |
| Host CPU during the bridge   | `perf` over a whole bridge run (Linux, lavapipe): about two thirds of the host's user-space samples are host and GPUI code and about a quarter is lavapipe rasterization. The top host symbol, `NativeView::apply`, is about 6%.      | No hot spot worth a change at this load       | this section                                                                                    |
| Watch compiler memory        | RSS growth came from mimalloc's purge delay keeping freed bundler pages resident, not from a retained object.                                                                                                                         | `MIMALLOC_PURGE_DELAY=0` for the CLI (#448)   | [tooling controls](../benchmarks/tooling/README.md)                                             |
| Solid transform              | Babel garbage is collectable; reusing the preset changed nothing.                                                                                                                                                                     | No change                                     | [Solid stages](../benchmarks/tooling/results/solid-transform-linux-x64/README.md)               |
| Sustained native watch       | Over 601 real edits, controller RSS levels off after about 100 edits. React keeps about 6 KB per edit of residual growth, and edit-to-paint time does not degrade.                                                                    | No architecture change                        | [sustained watch](../benchmarks/tooling/README.md#sustained-native-watch-601-edits-november-10) |
| AOT heap retention (#287)    | Reproduced 19/60 on the old Bun pin and 0/60 on the current pin.                                                                                                                                                                      | Fixed by the Bun pin                          | #287                                                                                            |
| AOT object growth (M9)       | The forced-collection object count that rose in 30-minute AOT sessions is live number strings held by a bounded AOT number-to-string cache, not Bun Native state. It levels off. See [below](#aot-object-growth-in-long-sessions-m9). |
| Framework and execution mode | Core, Solid and React in development and AOT, with a direct Rust GPUI baseline, on Linux and macOS. A scheduled regression gate runs against committed baselines.                                                                     | Gate at 25% (hosted VMs vary 12–15%)          | [COMPARISON.md](../benchmarks/COMPARISON.md), [Rust GPUI](../benchmarks/rust-gpui/README.md)    |

### AOT object growth in long sessions (M9)

The [30-minute sessions](../benchmarks/results/workspace-long-session-2026-11-11/README.md)
recorded an AOT-only rise in live objects after a forced collection (Solid
11,125 → 12,576, React 9,762 → 13,032), while the heap stayed under 2 MB.
`BUN_NATIVE_SOAK_HEAP_CENSUS=1` (`tests/native/workspace-session.ts`) makes each
sample record JSC's `objectTypeCounts` and a `strings-<round>.json` count of
every live string's text.

- Type census, 20-minute AOT sessions of both soaks (local X11, Bun
  `1.4.4-canary.1+b1007f117`): from 180 s to 1,200 s, live strings rose by
  1,062 (Solid) and 2,765 (React). Every other type changed by less than 140
  (Solid) and less than 4 (React), and Solid's other types returned to the
  same values in later samples.
- String census, 10-minute AOT sessions: every string that grew after warm-up
  was a number's text. Solid had 1,024 integer and 449 decimal strings; React
  had 989 integer and 607 decimal strings. The integers are the round numbers
  in the fixture's `Round ${round} …` titles. The decimals are round durations,
  which `SessionRecorder` writes to `rounds.txt` as `${milliseconds}\n`.
- [`aot-number-strings.js`](../benchmarks/retention/aot-number-strings.js)
  reproduces this with no Bun Native, framework, host or file I/O. Each round
  makes and drops one number's string. In development, 0 such strings stay
  live. In AOT, live integer strings go to 1,025 by 2,500 rounds and stay
  there through 40,000 rounds. Live decimal strings, made with a template or
  `String()`, rise along a fill curve (1,846 at 2,500 rounds, 3,984 at 15,000)
  and reach exactly 4,096 at 40,000 rounds, then stay there through 60,000.
  The pattern fits a fixed-size cache of number strings in the AOT runtime,
  with about 1,024 integer and 4,096 decimal entries. That is inferred from
  the plateaus, not read from Bun's source.
- Why the counts rose more slowly later in the session: the integer slots
  fill within the first rounds, and the decimal slots then fill more slowly
  as fewer stay empty. For a soak, 1,024 integer plus 4,096 decimal entries
  bound the increase at about 5,100 strings. That is the scale of the
  observed +4,300 to +4,900 objects from the first sample of the 30-minute
  sessions to the last. Number strings are short, so the bound is roughly
  100–200 KB of heap.

The growth is therefore bounded and belongs to the Bun AOT runtime, not to
Bun Native ownership. Not done: a session longer than 30 minutes that shows
the soak's own object count flat once both caches are full, and reading the
AOT runtime source to confirm the cache.

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

| Limit                                          | Why it is open                                                                                                                                                        | Issue      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| macOS and Windows code signing, notarization   | owner-only: Apple Developer ID and Windows certificate                                                                                                                | #249, #223 |
| Linux host archive provenance                  | keyless Sigstore attestation wired; first `main` run pending ([releasing](releasing.md#linux-keyless-build-provenance))                                               | #249, #223 |
| Windows screen reader and OS IME composition   | Orca, IBus Hangul, VoiceOver and macOS Korean composition gate CI; NVDA speech and the Windows Korean IME still fail                                                  | #241, #629 |
| Physical multi-monitor hardware                | headless sway outputs, two Xvfb screens and a macOS virtual display cover the semantics in CI; EDID monitors, cables, GPU outputs and Windows mixed DPI need hardware | #299       |
| Babel 8                                        | no Solid preset release supports it yet                                                                                                                               | #316       |
| Hosted first-window deadline                   | not recurred since November 6 ([below](#first-window-deadline-296))                                                                                                   | #296       |
| Windows disposal retention                     | Windows support waits on it                                                                                                                                           | #629       |
| Physical GPU, Windows and real-Mac performance | hosted runners use software or paravirtual GPUs                                                                                                                       | #244       |
| Release-readiness decision                     | per-platform draft in [ADR 0021](decisions/0021-platform-release-readiness.md) (proposed)                                                                             | #245       |

## First-window deadline (#296)

Checked on 2026-11-11 with read-only `gh api` calls:

- Every failed push Validation on `main` since November 6 (runs 42215872209,
  42293211745, 42750220152, 42754811240, 42772679992, 42774689778 and
  42786819888, plus the cancelled scheduled audit 42929826979) failed somewhere
  else: a Wayland compositor click on headless sway, a headless Windows `hello`
  timeout (already recorded on #296 as unrelated) with macOS drag and drop, a
  macOS protocol contract, macOS drag and drop, macOS workspace scroll endpoints
  (twice) and macOS AOT accessibility. None logged `Native open request N timed
  out`.
- The 60 most recent failed Validation runs on any branch (November 9 15:25 UTC
  to November 11) have 24 failed Native Linux, Native macOS/Windows or Protocol
  jobs; none of their logs contains an open-request timeout.
- The latest `main` Validation, 42922483983 (`5638bbd`), passed all three Native
  Linux shards.

So it has **not recurred** since the November 5 reproductions recorded on the
issue. No code was changed for it; the bounded startup trace stays in place for
the next occurrence.

## For a fresh agent

[Getting started](getting-started.md), [development](development.md),
[testing](testing.md) and the [API reference](api-reference.md) cover clone,
validate, build and package. [Architecture](architecture.md) and the
[decision records](decisions/README.md) explain the package and host boundaries.
