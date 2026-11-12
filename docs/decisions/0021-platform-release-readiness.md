# ADR 0021 — Release readiness by platform: Linux and macOS first, Windows waiting

Status: accepted (2026-11-12, see [Acceptance](#acceptance-2026-11-12))

Date: 2026-11-11

Related milestone/issues: BN7 [#245](https://github.com/0xPlayerOne/bun-native/issues/245)
(release-readiness decision), [#249](https://github.com/0xPlayerOne/bun-native/issues/249)
and [#223](https://github.com/0xPlayerOne/bun-native/issues/223) (signing and
artifacts), [#296](https://github.com/0xPlayerOne/bun-native/issues/296),
[#241](https://github.com/0xPlayerOne/bun-native/issues/241),
[#629](https://github.com/0xPlayerOne/bun-native/issues/629),
[#260](https://github.com/0xPlayerOne/bun-native/issues/260). It refines
[ADR 0013](0013-release-readiness.md) (release readiness and supported scope,
the first 0013) and does not replace it.

## Context and constraints

The owner's bar for a first release is that **macOS and Linux are complete**,
that **Windows may wait**, and that the Apple Developer ID and Windows
code-signing certificates are **credentials only the owner can obtain**.
[`0013-release-readiness`](0013-release-readiness.md), last revised for the November 11 close-out
([#628](https://github.com/0xPlayerOne/bun-native/pull/628)), keeps Bun Native an
experimental developer preview and lists the blockers to anything wider.

This record answers a narrower question: per platform, what is supported now,
what is not, and which named step moves each platform. Every claim below cites
evidence already in the repository or its issues at base `2e2334a`; nothing here
is a new measurement. "Supported" keeps `0013-release-readiness`'s meaning: native evidence for
an exact source on the stated environment, not compile success.

## Options considered

1. **Declare Linux and macOS released together now.** Rejected: macOS has
   capability rows that are advertised but never run there (below), so "macOS
   complete" is not demonstrated.
2. **Hold every platform until Windows is ready.** Rejected: it ties Linux and
   macOS to [#629](https://github.com/0xPlayerOne/bun-native/issues/629), which the
   owner's bar explicitly excludes.
3. **Decide per platform**: Linux x64 X11 is the release candidate; macOS ARM64
   is observed with a named list of gaps to close; Windows is explicitly waiting
   on #629 and an owner certificate. Chosen.

## Decision and rationale

### Per-platform scope

| Platform                         | State                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What it still needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64, X11                   | **Supported (preview); release candidate**                                  | `0013-release-readiness` supported rows: core, Solid and React windows, input, layout, paint and close in development and inspected AOT; templates and watch; standalone consumers; display, clipboard, shortcuts and notification services. Since then: Orca speech gates Native Linux, IBus Hangul composition passes ([native text](../native-text.md)), filesystem grants, processes, file dialogs and drag and drop run in the Linux suite ([capabilities by platform](../native-platforms.md#advertised-capabilities-by-platform)).                | [#296](https://github.com/0xPlayerOne/bun-native/issues/296) is open but has not recurred: no `Native open request N timed out` in any failed main Validation since November 6 or in the 60 most recent failed Validation runs on any branch (checked 2026-11-11, [framework audit](../framework-audit.md#first-window-deadline-296)). The first keyless provenance attestation of the host archive runs on the next `main` push ([releasing](../releasing.md#linux-keyless-build-provenance)). Hosted software GPU only.                                                                                                                                   |
| Linux x64, Wayland               | Observed, not supported                                                     | One core case and display changes on headless sway ([ADR 0017](0017-wayland.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | GNOME/KDE, fractional scaling, IME; clipboard, shortcuts, drag and drop and popup windows are X11-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Linux ARM64                      | Unsupported                                                                 | Bun is pinned for it in `toolchain.json`; no GUI evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A native run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| macOS 15 ARM64                   | **Observed, not supported**                                                 | Hosted `macos-15`: core, Solid and React development and AOT windows with OS input and joined cleanup; workspace references with keys, text, wheel, resize and OS close; all four templates; throwaway-identity signed `.dmg` installed and healthy; VoiceOver speech and Korean composition gate Native Platforms (development and AOT, runs 43087027363 and 43093920340, [native text](../native-text.md#screen-reader-speech)). Physical M2 Max clean-clone quick-start without input. `0013-release-readiness` revisions for 0.27.2 and November 11. | (1) `split_v1`, `style_decoration_v1`, `overlays_v1` and the rows that share its qualification, `input_states_v1`, `split_resize_v1` and `accessibility_v1` roles are advertised on macOS but **not run there** ([capabilities by platform](../native-platforms.md#advertised-capabilities-by-platform)); (2) `app_menu_v1`, `task_dialogs_v1`, `context_menus_v1` and `display_details_v1` run on hosted macOS but have no retained source-bound evidence record, so they are **unverified**; (3) clipboard, global shortcuts, notifications and file dialogs are **not implemented** on macOS; (4) **owner-only**: Developer ID signing and notarization. |
| macOS x64                        | Unsupported                                                                 | No GUI evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A native run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Windows x64 (Server 2022 hosted) | **Waiting on [#629](https://github.com/0xPlayerOne/bun-native/issues/629)** | Hosted `windows-2022`: core, Solid and React windows with OS input in development and AOT, all four templates, and a throwaway-identity signed `.zip` installed and healthy (`0013-release-readiness` revisions).                                                                                                                                                                                                                                                                                                                                        | #629 (React, and intermittently Solid AOT, keep disposed views reachable on Windows); NVDA speech and Windows IME fail ([#241](https://github.com/0xPlayerOne/bun-native/issues/241)); **owner-only**: an Authenticode certificate or Trusted Signing account. Deferred by the owner's bar.                                                                                                                                                                                                                                                                                                                                                                 |
| Windows ARM64                    | Unsupported                                                                 | No GUI evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A native run; deferred with Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Signing and artifact trust

| Item                                                | State                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux host archive provenance                       | Keyless Sigstore build provenance through GitHub OIDC on `main` pushes, verified in the job and again before Release Please runs. No credential needed. Attested and verified on `main` (see [Acceptance](#acceptance-2026-11-12)).                     |
| macOS Developer ID signing and notarization         | **Owner-only.** Implemented and exercised with a throwaway identity; ad-hoc `codesign` is unit-tested. No Developer ID signature, notarization or Gatekeeper result exists ([owner steps](../releasing.md#configuring-release-identities-owner-steps)). |
| Windows Authenticode                                | **Owner-only**, and deferred with Windows.                                                                                                                                                                                                              |
| Update-manifest Ed25519 release key                 | **Owner-only** for a real application channel; the repository holds no release key.                                                                                                                                                                     |
| Published host or application artifact on a release | None. A version release attaches no host; the attested Linux archive is a 30-day CI artifact.                                                                                                                                                           |

### What "Linux and macOS complete" will require

Linux x64 X11 moves from preview to a released platform when #296 is closed
with a recorded cause or a documented run of clean main Validations, and the
provenance attestation has verified on `main` at least once. macOS ARM64 moves
from observed to supported when gaps (1)–(4) in its row are each run with
retained evidence or explicitly removed from the advertised capability list,
and the owner supplies the Developer ID identity so that gap (5) produces a
notarized, Gatekeeper-accepted image. Windows is not part of the first release.

## Acceptance (2026-11-12)

The conditions in [What "Linux and macOS complete" will require](#what-linux-and-macos-complete-will-require)
are met for Linux x64 X11 and for macOS ARM64 except the owner-only item. The
per-platform table above records the state when this was proposed; where it
differs, this section governs.

- **Linux x64, X11: supported; release-ready.**
  - Provenance: Native Linux in main Validation
    [43142396083](https://github.com/0xPlayerOne/bun-native/actions/runs/43142396083)
    (`e1b6c60`) attested the host archive (sha256 `eb8930dc…b426`, Rekor
    index 3822959972) and verified it in the job. The release workflow
    [43145047946](https://github.com/0xPlayerOne/bun-native/actions/runs/43145047946)
    verified it again ([releasing](../releasing.md#linux-keyless-build-provenance)).
  - [#296](https://github.com/0xPlayerOne/bun-native/issues/296) closes on the
    documented-clean-runs condition. The cause was measured (first touch of the
    Lavapipe/LLVM closure on hosted VMs) and mitigated by the warm-up step
    (#442). No `Native open request N timed out` appears in any of the 24 failed
    jobs of the 40 most recent failed Validation runs since November 6
    (checked 2026-11-12).
  - The real generated template is packaged into the tar.gz installer,
    installed, launched through the installed verifying launcher, painted under
    Xvfb and removed in a gating Native Linux step
    ([releasing](../releasing.md)). The tar.gz plus `install.sh` is the Linux
    platform installer; `.deb` and AppImage are out of scope.
- **Linux x64, Wayland: supported where the pinned GPUI allows (owner's scope
  decision, 2026-11-12).** Window, input, pixels, text input, display identity,
  changes, migration and hotplug run on headless sway in development and AOT.
  Clipboard, global shortcuts, drag and drop and popup windows stay X11-only
  because GPUI owns the Wayland data device and surface roles; those limits are
  tracked upstream in [#635](https://github.com/0xPlayerOne/bun-native/issues/635)
  and do not count against Linux completeness.
- **macOS 15 ARM64: supported (preview), except notarized distribution.**
  - Gaps (1) and (2): every listed capability now has a retained source-bound
    record from a passing main run
    ([`macos-features-hosted-shard-1.json`](../../tests/native/evidence/macos-features-hosted-shard-1.json),
    [`macos-features-hosted-shard-2.json`](../../tests/native/evidence/macos-features-hosted-shard-2.json);
    [capabilities by platform](../native-platforms.md#advertised-capabilities-by-platform)).
  - Gap (3): clipboard, global shortcuts, notifications, file dialogs and popup
    windows are implemented on macOS and recorded in the same way.
  - `accessibility_lists_v1`, the workspace terminal pane's OS input, and
    display identity and changes gate on hosted macOS as well. What AccessKit's
    macOS adapter does not expose for lists (set size, position, list-level
    selection) is asserted absent, not claimed
    ([native text](../native-text.md)).
  - VoiceOver speech and Korean composition gate Native Platforms.
  - Gap (4) remains **owner-only**: a Developer ID identity, notarization and a
    Gatekeeper-accepted image ([#636](https://github.com/0xPlayerOne/bun-native/issues/636)).
    Until then, macOS artifacts are throwaway- or ad-hoc-signed.
- **Windows** is unchanged: waiting on
  [#629](https://github.com/0xPlayerOne/bun-native/issues/629) and the Windows
  lane follow-up [#638](https://github.com/0xPlayerOne/bun-native/issues/638).
- **Physical hardware** (EDID monitors, physical GPUs and keyboards) is tracked in
  [#637](https://github.com/0xPlayerOne/bun-native/issues/637). All GUI evidence
  above comes from hosted VMs.

### Second architectures (2026-11-12)

- **Linux ARM64 and macOS x64** gain a gating Validation lane,
  [Native Linux ARM64 and macOS x64](../../.github/workflows/native-architectures.yml),
  on GitHub-hosted `ubuntu-24.04-arm` and `macos-15-intel` runners. Each lane
  builds and tests the release host, runs a development and an inspected AOT
  window (Linux: the public API input and lifecycle session under Xvfb; macOS:
  the platform paint and lifecycle smoke on Metal), creates, checks and
  AOT-builds all four templates, and keeps the host archive that the release
  attaches ([releasing](../releasing.md#release-host-archives)). That makes
  both **observed** platforms; they are not supported until the full Linux and
  macOS suites run there too.
- Version releases attach the release host for Linux x64 and ARM64 and macOS
  ARM64 and x64, and publish the `@bun-native` packages to npm with trusted
  publishing ([releasing](../releasing.md#npm-packages)).

## Implementation consequences

- `0013-release-readiness` stays the record of the preview scope; this record is its per-platform
  exit plan. When accepted, `0013-release-readiness` gains a revision pointing here.
- [`docs/compatibility.md`](../compatibility.md) remains the versioned support
  matrix; a row moves only with linked evidence, as before.
- A macOS capability that cannot be run should stop being advertised rather than
  stay "unverified" in a supported release.

## Validation and measurements

No new native measurement. The #296 recurrence check and the provenance wiring
are recorded in [framework audit](../framework-audit.md) and
[releasing](../releasing.md).

## Risks, unsupported cases and follow-up

- All GUI evidence is from hosted runners with software or paravirtual GPUs,
  plus one physical Mac run without input; physical-GPU behavior is unmeasured
  ([#244](https://github.com/0xPlayerOne/bun-native/issues/244)).
- #296 is intermittent; absence over five days is not a cause.
- Babel 8 for the Solid compiler remains excluded
  ([#316](https://github.com/0xPlayerOne/bun-native/issues/316)).
- Accept this record, or revise it, when the first `main` provenance run
  completes, when #296 closes, or when any macOS gap closes.
