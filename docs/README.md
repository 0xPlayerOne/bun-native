# Documentation

Current architecture and contributor guides, with historical evidence kept distinct.

**Checkpoint:** M1–M6 completion records define their declared acceptance profiles.
[M6 completion](m6-completion.md) records managed reload, the actual
500-replacement workload and distinct controlled relaunch on Linux, macOS and
Windows, plus the separately pinned macOS reference comparison.
[PR #130](https://github.com/0xPlayerOne/bunly/pull/130) is merged. M7 remains in
progress; [desktop window APIs](desktop-window-api.md) and the
[native desktop qualifier](desktop-qualification.md) describe its first increment.
[Native view composition](view-composition.md) describes the next increment's
opt-in panes, clipping, focus, overlay path and remaining desktop qualification.

The [managed development qualification](managed-development-qualification.md)
defines the native 500-replacement and controlled-relaunch workload. The
[common edit outcome comparison](managed-comparison.md) records the separately
pinned Electrobun/Mirin workflow and its measurement limits.
The [five-run retained manifest](../evidence/m6-managed-development/manifest.json)
keeps startup, metadata and last-window shutdown failures beside the later accepted
native and comparison runs; `bun run verify:managed-acceptance` replays them without
implicit source fetch or a new native launch.

[M4 browser sessions](m4-browser-sessions.md) documents the implemented issue #20
session surface, its prepared real-native qualifier, and the remaining macOS
persistent-cookie/storage-clear limitations. Renderer authority remains separate.

## Start here

[Architecture](architecture.md) defines the host, packages and trust boundaries.
[Contributing](../.github/CONTRIBUTING.md) is the single contribution policy.
[Validation](validation.md) lists current commands and evidence limits.
[Code Foundry](code-foundry.md) explains deterministic sync and contributor hooks.
[Runtime foundation audit](runtime-foundation-audit.md) records ownership/cache fixes and local hot-path measurements.
[Message-path audit](message-path-audit.md) covers buffer ownership, bounded framing and RPC decoding.
[Pre-M4 foundation](pre-m4-foundation.md) records the asset, lifecycle and regression pass.
[Foundation performance](foundation-performance.md) documents maintained checks and explicit profiling.
[Manual native qualification](manual-native-qualification.md) runs disposable
Windows, Linux and macOS cloud tests without local VMs.

## Accepted milestone records

| Record                                  | Scope                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------- |
| [M1 completion](m1-completion.md)       | Host decision, native probes and foundational contracts                     |
| [M2 completion](m2-completion.md)       | Local reference baselines and measurement infrastructure                    |
| [M3 completion](m3-completion.md)       | Declared native CEF platform and lifecycle acceptance                       |
| [M4 completion](m4-completion.md)       | Native authority, sessions, transport and provider acceptance               |
| [M5 completion](m5-completion.md)       | Native streams, graphical terminals and service supervision                 |
| [M6 completion](m6-completion.md)       | Managed application generations, retained resources and controlled relaunch |
| [Foundation audit](foundation-audit.md) | Post-M3 hygiene, sync and dependency-security review                        |

The detailed M2/M3 acceptance reports and `evidence/` retain original source
identities, failed attempts and qualification boundaries. Completing a milestone
does not imply production signing, final performance superiority, or platform
coverage outside its stated profile.

[The M6 record](m6-completion.md) maps closed issues #28–#33 to implementation,
retained local evidence and the final hosted acceptance. PR #130 carries the
completed final-head validation and squash-merge record.

## Active technical guides

[Packaged origin](packaged-origin.md), [artifact acquisition](artifact-acquisition.md),
[RPC](rpc.md), [streams](streams.md), [native CEF streams](native-streams.md), and
[provenance](provenance.md) describe their implemented surfaces and remaining limits. [M4 progress](m4-progress.md) and
[M5 progress](m5-progress.md) are partial implementation notes, not closeout claims.
The [authenticated loopback candidate](rpc-loopback.md) and proposed
[transport ADR](decisions/0003-transport-selection.md) define #22's implemented
candidate and the native CEF evidence still required before selection.
[M4 capability policy](m4-capability-policy.md) documents the native authorization
gate, browser callback policy, adversarial model, prepared-host fixture and explicit
M7/OS qualification limits.

[Native assets](native-assets.md) specifies asynchronous verification and resource
bounds. [macOS clone cleanup](macos-clone-cleanup.md) documents the narrow helper
ownership policy and the executable baseline/current qualification command.

Contributor programs under `scripts/` serve live workflows, tests or documented
reproduction paths. They are not application payloads merely because they are in
the repository. Disposable logs, downloaded binaries, fixture apps and test VMs
belong under ignored `.bunly/`, not among those source programs.

## Historical checkpoints

Earlier, superseded progress/validation snapshots live under `history/`:
[M1 validation](history/m1-validation.md),
[M1/M2 progress](history/m1-m2-progress.md),
[second implementation wave](history/validation-m1-m2-wave2.md),
[M2 workbench increment](history/validation-m2-workbench.md), and
[M2 reference/release increment](history/validation-m2-reference-release.md).
Their old status statements describe their original checkpoint; use the current
completion reports and issue tracker for present status.

## Bun-native developer tooling

[Bun-native tooling](bun-tooling.md) documents the qualified checker, bounded file reads,
concurrent builds, measured results and retained security boundaries.

[Formatting](formatting.md) documents the repository-wide Oxfmt gate and the
separate Python/Rust contributor formatters.

[Protected persistent cookies](session-credentials.md) records the explicit OS-provider policy, admission checks and disposable-runner qualification boundary.

- [Complete session storage reset](session-storage-reset.md): explicit offline whole-profile clearing and interruption recovery.

[M4 completion](m4-completion.md) maps native IPC, policy, sessions, credential-provider acceptance and transport selection to the declared functional boundary.

[Native acceptance tooling](native-acceptance-tooling.md) defines the shared M4
suite, sanitized evidence export/replay and the M5 diagnostic handoff.

[M5 completion](m5-completion.md) maps accepted native streams, graphical terminals,
service supervision and measured load to the declared support boundary.
[M5 progress](m5-progress.md) preserves the individual implementation checkpoints.
[Terminal regression review](terminal-regression-review.md) defines retained-evidence
replay and measured review envelopes without inventing a release threshold.

[Managed application generations](managed-generations.md) defines the M6 stable-owner
contract, portable model and failure accounting. [Service reload](service-reload.md)
implements the production generation lifecycle, [managed desktop resources](managed-desktop.md)
provides native reattachment, and [development hosts](development-host.md) documents
verified cache reuse and independent source invalidation.

[Native control admission](native-control-admission.md) documents reserved command
capacity, cancellation/task ownership and the real native saturation fixture.

[Native fault qualification](cef-fault-qualification.md) defines actual readiness,
expected failure/cleanup receipts and the automatic seven-stage native gate.

[Native output admission](native-output-admission.md) documents bounded reverse
pipe ownership, reserved control capacity and active-writer accounting.

[Native process exit](native-process-exit.md) describes the notification-driven
backend shutdown handoff and its unchanged identity and deadline boundaries.

- [Sustained graphical terminal load](terminal-load-qualification.md): visible/hidden real PTY phases, bounded measurements, retained failed trials and historical qualification checkpoints.

[Native window-state terminal load](terminal-window-load.md) defines distinct foreground,
inactive-visible, hidden and minimized execution with actual native and page receipts.

[Reload mechanism qualification](reload-mechanism-qualification.md) defines the
fixed pinned-Bun experiments and their separate synthetic/native acceptance boundaries.
