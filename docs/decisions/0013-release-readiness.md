# ADR 0013 — Release readiness and supported scope

Status: accepted

Date: 2026-11-05

Related milestone/issues: BN7 [#245](https://github.com/0xPlayerOne/bun-native/issues/245),
parent [#224](https://github.com/0xPlayerOne/bun-native/issues/224), roadmap
[#1](https://github.com/0xPlayerOne/bun-native/issues/1). Depends on
[#241](https://github.com/0xPlayerOne/bun-native/issues/241),
[#244](https://github.com/0xPlayerOne/bun-native/issues/244),
[#247](https://github.com/0xPlayerOne/bun-native/issues/247),
[#223](https://github.com/0xPlayerOne/bun-native/issues/223) and
[#254](https://github.com/0xPlayerOne/bun-native/issues/254).

## Context and constraints

BN7 decides which feature and platform scope is ready to ship
([releasing](../releasing.md)). Every claim must come from recorded native
evidence for an exact source; compile success, parser checks and zero public
ownership counters are not acceptance. This decision is made against main
[`38634595`](https://github.com/0xPlayerOne/bun-native/tree/3863459588378532a4af4fb27188f051fa0955df)
and the pins in the [compatibility matrix](../compatibility.md#exact-pins).

Each linked CI run qualifies the head of the pull request it ran on, not later
combined trees. No completed Validation run covers that main commit as a whole:
[#453](https://github.com/0xPlayerOne/bun-native/pull/453) merged on a skipped
draft-stage gate before its ready-stage Validation started (the gate fix is
[#456](https://github.com/0xPlayerOne/bun-native/pull/456)), and
[#430](https://github.com/0xPlayerOne/bun-native/pull/430)'s Validation ran on a
merge with an earlier base, `15344d56`.

## Options considered

1. **Declare a general release.** Rejected: no artifact is signed or installed,
   the platform matrix is incomplete and three intermittent native failures are
   unresolved.
2. **Declare nothing ready.** Rejected: it hides which scope already has
   repeatable native evidence and gives later work no baseline to move.
3. **Ship an explicitly bounded experimental developer preview** and list every
   blocker to a wider release. Selected.

## Decision and rationale

Bun Native is **not ready for a production, stable-API or end-user release**.
The ready scope is an **experimental developer preview built from a checkout or
from local package archives**, with unsigned artifacts, on the platforms and
features below. The preview carries no API stability promise and the pins are
exact selections, not ranges.

### Supported preview scope

Each row is supported only at the linked evidence's source and environment.

| Scope                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64 X11 (Xvfb, Mesa llvmpipe, XTest input): public core, Solid and React windows, input, keyed updates, events, layout, paint and close in Bun development and inspected AOT | [Native Linux job 127562219829](https://github.com/0xPlayerOne/bun-native/actions/runs/42117878399/job/127562219829) on [#430](https://github.com/0xPlayerOne/bun-native/pull/430) head `f505189e`, running the [native Linux workflow](../../.github/workflows/native-linux.yml) steps                                                                                                                                                                                                                                                |
| Generated Solid/React TypeScript and checked-JavaScript templates and the 101-remount watch, Linux, development and AOT                                                            | Same job; scope in [developer tooling](../developer-tooling.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Four installed standalone consumers from local package archives, Linux, development and AOT                                                                                        | [#388](https://github.com/0xPlayerOne/bun-native/pull/388), [Validation 41952309890](https://github.com/0xPlayerOne/bun-native/actions/runs/41952309890); scope in [standalone projects](../standalone-projects.md)                                                                                                                                                                                                                                                                                                                    |
| Linux services under explicit grants: owned-window display snapshot, X11 clipboard text, X11 global shortcuts, freedesktop notifications (dunst)                                   | [Display](../../tests/native/evidence/services-linux-hosted-release.json) and [clipboard](../../tests/native/evidence/clipboard-linux-hosted-release.json) records; shortcuts [job 127513230930](https://github.com/0xPlayerOne/bun-native/actions/runs/42103802861/job/127513230930) ([#422](https://github.com/0xPlayerOne/bun-native/pull/422)); notifications [job 127525552193](https://github.com/0xPlayerOne/bun-native/actions/runs/42107349701/job/127525552193) ([#424](https://github.com/0xPlayerOne/bun-native/pull/424)) |

### Experimental, observed but not supported

- **macOS 15 ARM64 and Windows Server 2022 x64:** core, Solid and React open
  real GPUI windows with complete paints, OS-injected input and joined cleanup in
  development and AOT on hosted runners
  ([#399](https://github.com/0xPlayerOne/bun-native/pull/399),
  [Validation 41977270938](https://github.com/0xPlayerOne/bun-native/actions/runs/41977270938);
  [platform record](../native-platforms.md)). Templates, standalone consumers,
  services, OS close buttons, physical input and display presentation are not
  covered there, so these targets are not supported.
- **Performance:** one local
  [equivalent-workload run](../../benchmarks/comparison/results/linux-x64-llvmpipe-2026-11-05/README.md)
  on a shared software-rendered VM. It describes that VM only and sets no budget
  or regression baseline ([#244](https://github.com/0xPlayerOne/bun-native/issues/244)).

### Unsupported

- Linux Wayland, Linux ARM64, macOS x64 and Windows ARM64 GUI: Bun packages are
  pinned for them in `toolchain.json`, but there is no native GUI evidence.
- Every service on macOS and Windows; filesystem grants, drag and drop, owned
  processes, dialogs and menus on every platform. They are absent from this
  source; open work is [#304](https://github.com/0xPlayerOne/bun-native/issues/304),
  [#303](https://github.com/0xPlayerOne/bun-native/issues/303),
  [#305](https://github.com/0xPlayerOne/bun-native/issues/305) and
  [#239](https://github.com/0xPlayerOne/bun-native/issues/239).
- IME, assistive technology, mixed-DPI and broader Unicode text
  ([#241](https://github.com/0xPlayerOne/bun-native/issues/241)); physical GPUs
  and physical input.
- Installers, code signing, notarization, clean-machine launch and update
  integrity/rollback ([#223](https://github.com/0xPlayerOne/bun-native/issues/223),
  [#247](https://github.com/0xPlayerOne/bun-native/issues/247)).
- DOM, `react-dom`, `solid-js/web`, CSS cascade/selectors and DOM-dependent
  component libraries (shadcn, Radix, Kobalte), and untrusted web content; see the
  [web compatibility boundary](../compatibility.md#web-compatibility-boundary).
- Babel 8 with the Solid compiler
  ([#316](https://github.com/0xPlayerOne/bun-native/issues/316)).
- Any WebView or CEF fallback.

## Blocking risks

Each is open and blocks any release wider than the preview above.

| Risk                                       | State on this source                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS-close stall after a completed workload  | [#358](https://github.com/0xPlayerOne/bun-native/issues/358) open. [#419](https://github.com/0xPlayerOne/bun-native/pull/419) and [#425](https://github.com/0xPlayerOne/bun-native/pull/425) add thread, window-manager and key-down diagnostics; no cause or fix is recorded ([close diagnostics](../native-close-diagnostics.md)).             |
| First-window startup deadline              | [#296](https://github.com/0xPlayerOne/bun-native/issues/296) open. [#421](https://github.com/0xPlayerOne/bun-native/pull/421) splits GPU instance setup in the startup trace; no cause or fix is recorded ([startup diagnostics](../native-startup-diagnostics.md)).                                                                             |
| Retention at fixed checkpoints             | [#287](https://github.com/0xPlayerOne/bun-native/issues/287) open. Collectability checks now run with the JSC DFG tier disabled ([#418](https://github.com/0xPlayerOne/bun-native/pull/418)); collectability under default tiers is unqualified.                                                                                                 |
| No signed or installed artifacts           | [Releasing](../releasing.md) records no qualified installer or signed production artifact; packaging, signing and update trust remain [#223](https://github.com/0xPlayerOne/bun-native/issues/223) and [#247](https://github.com/0xPlayerOne/bun-native/issues/247).                                                                             |
| Text input, IME and accessibility          | [#241](https://github.com/0xPlayerOne/bun-native/issues/241) open; no IME or assistive-technology evidence exists.                                                                                                                                                                                                                               |
| Required gate can pass without native jobs | A skipped draft-stage `Validation / Gate` counts as passed, so [#453](https://github.com/0xPlayerOne/bun-native/pull/453) merged unvalidated; [#456](https://github.com/0xPlayerOne/bun-native/pull/456) is open. Until it lands, check that a ready-stage Validation run completed on the exact head before citing a merged change as evidence. |

## Implementation consequences

- [`docs/compatibility.md`](../compatibility.md) is the versioned support matrix.
  Its exact-pin table is checked by
  [`tests/quality/compatibility-pins.test.ts`](../../tests/quality/compatibility-pins.test.ts)
  against `toolchain.json`, the package manifests, the GPUI host manifest and
  both `PROTOCOL_VERSION` constants, so a pin or protocol bump fails
  `bun run test` until the matrix is updated.
- A change that adds a platform, service or framework capability updates the
  matrix row and links its own native evidence; this ADR moves a row into the
  supported scope only with that evidence.
- Release tooling keeps producing unsigned experimental artifacts only.

## Validation and measurements

The support decision is bounded by the CI runs and evidence records linked
above. This ADR adds no native measurement. Its pin check runs with every
`bun test tests` invocation, including Source quality.

## Revision for 0.27.2 (2026-11-10)

Re-evaluated against main
[`e456a6d`](https://github.com/0xPlayerOne/bun-native/tree/e456a6d2f65f8771b663a7fb8f3a6026ce0a9a54)
(release 0.27.2) and the [changes in 0.27.2](../compatibility.md#changes-in-0272).
**The decision is unchanged:** Bun Native remains an experimental developer
preview built from a checkout or local package archives, with unsigned
artifacts. The supported preview scope above is unchanged; nothing below moves
into it.

What changed since `38634595`:

- **Required gate.** [#456](https://github.com/0xPlayerOne/bun-native/pull/456)
  merged: a draft run now fails `Validation / Gate` instead of skipping it, so
  that blocking risk is closed. A merged change is evidence only for the
  ready-stage run on its exact head.
- **OS-close stall.** [#358](https://github.com/0xPlayerOne/bun-native/issues/358)
  is closed; see the issue for its recorded attribution.
- **macOS ARM64** moves further within _observed, not supported_. Hosted
  `macos-15` now runs the Solid and React workspace references with keys, text,
  wheel, resize and OS close in development and AOT
  ([#582](https://github.com/0xPlayerOne/bun-native/pull/582),
  [Validation 42746456002](https://github.com/0xPlayerOne/bun-native/actions/runs/42746456002)),
  and a physical M2 Max ran the clean-clone Solid and React quick-start in
  development and AOT ([getting started](../getting-started.md#macos-arm64-physical-mac)).
  It stays unsupported: services are unverified there, the physical run sent
  no input, and nothing is signed or notarized.
- **Linux Wayland** moves from unsupported to _observed, not supported_: one
  core case on headless sway ([ADR 0017](0017-wayland.md)).
- **Services.** Filesystem grants ([#304](https://github.com/0xPlayerOne/bun-native/issues/304)
  closed), processes, file dialogs, drag and drop, core message dialogs, the
  macOS menu bar and Windows task dialogs are merged. Only their Linux X11
  cases are native evidence; macOS and Windows steps are unverified per
  [capabilities by platform](../native-platforms.md#advertised-capabilities-by-platform).
- **IME.** One IBus Hangul composition over XIM passes on Linux X11
  ([#545](https://github.com/0xPlayerOne/bun-native/pull/545)). No macOS or
  Windows IME and no assistive-technology run exist, so
  [#241](https://github.com/0xPlayerOne/bun-native/issues/241) still blocks.

Still blocking a wider release: [#296](https://github.com/0xPlayerOne/bun-native/issues/296)
first-window deadline, [#287](https://github.com/0xPlayerOne/bun-native/issues/287)
retention under default JIT tiers, [#241](https://github.com/0xPlayerOne/bun-native/issues/241)
text input and accessibility, and signing, installers and update trust
([#223](https://github.com/0xPlayerOne/bun-native/issues/223),
[#247](https://github.com/0xPlayerOne/bun-native/issues/247),
[#249](https://github.com/0xPlayerOne/bun-native/issues/249)).

## Revision for the November 11 close-out (2026-11-11)

Re-evaluated with [#628](https://github.com/0xPlayerOne/bun-native/pull/628).
**The decision is unchanged:** Bun Native remains an experimental developer
preview. Nothing below moves a row into the supported scope; the changes move
rows within _observed, not supported_ and narrow the blockers to steps that need
the owner's identities, physical machines or upstream releases.

- **Signing and installers** ([#249](https://github.com/0xPlayerOne/bun-native/issues/249),
  [#223](https://github.com/0xPlayerOne/bun-native/issues/223)). Hosted `macos-15`
  and `windows-2022` sign the generated template with a throwaway identity
  (hardened-runtime `codesign`; `signtool` with an RFC 3161 timestamp), build a
  `.dmg` or `.zip`, install it through its own script and confirm the signed
  application's health through the installed verifying launcher. Notarization is
  wired and skips without Apple credentials. No Developer ID or public
  Authenticode signature, notarization, Gatekeeper or SmartScreen result exists;
  the owner steps are in [releasing](../releasing.md).
- **Templates on macOS and Windows** ([#254](https://github.com/0xPlayerOne/bun-native/issues/254)).
  All four templates open, take one OS click and close cleanly in development
  and AOT on both hosted runners, and Ctrl-C (SIGINT) exits 0 on macOS. Hosted
  VMs, not physical machines.
- **Displays** ([#299](https://github.com/0xPlayerOne/bun-native/issues/299)).
  Wayland display changes are advertised and qualified on two headless sway
  outputs with mixed integer scales and hotplug; a removed output now fails
  closed instead of reporting a stale scale. X11 monitor changes are limited by
  the pinned GPUI backend; macOS and Windows migration and hotplug need a
  two-monitor machine.
- **Accessibility and input methods** ([#241](https://github.com/0xPlayerOne/bun-native/issues/241)).
  Orca speech for focus, typing, selection and a modal dialog gates Native Linux
  in development and AOT, after a host fix for content re-exposed under a closed
  modal. macOS Korean composition passes on hosted CI as a non-gating step.
  VoiceOver, NVDA and Windows Korean composition still fail there and remain
  experimental ([native text](../native-text.md#screen-reader-speech)).
- **Performance** ([#244](https://github.com/0xPlayerOne/bun-native/issues/244)).
  The comparison now runs on hosted macOS and Windows. Windows exposed disposed
  view retention in React and intermittently Solid AOT
  ([#629](https://github.com/0xPlayerOne/bun-native/issues/629)), which blocks any
  Windows support claim.

Still blocking a wider release: [#296](https://github.com/0xPlayerOne/bun-native/issues/296)
(not reproduced since November 6; trace in place),
[#629](https://github.com/0xPlayerOne/bun-native/issues/629), VoiceOver and NVDA
speech and Windows IME under [#241](https://github.com/0xPlayerOne/bun-native/issues/241),
release identities under [#249](https://github.com/0xPlayerOne/bun-native/issues/249),
physical-machine runs, and Babel 8 for the Solid compiler, which no published
preset supports yet ([#316](https://github.com/0xPlayerOne/bun-native/issues/316);
a weekly audit job reports when one does).

## Revision for ADR 0021 acceptance (2026-11-12)

[ADR 0021](0021-platform-release-readiness.md#acceptance-2026-11-12) is
accepted. Under it, Linux x64 X11 is release-ready. Wayland is supported where
the pinned GPUI allows. macOS ARM64 is supported as a preview, except for
notarized distribution, which needs the owner's Developer ID. Windows still
waits on [#629](https://github.com/0xPlayerOne/bun-native/issues/629). This
record stays the statement of the preview's general scope.

## Risks, unsupported cases and follow-up

Revisit this decision when any blocking risk closes with linked evidence, when
#244 records a hosted comparison, when #241 or #247 complete, or when a protocol
bump lands. The [#245](https://github.com/0xPlayerOne/bun-native/issues/245)
acceptance checkboxes for accessibility, security and measured performance stay
open until those dependencies are demonstrated.
