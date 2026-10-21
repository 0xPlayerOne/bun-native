# Documentation

Current architecture and contributor guides, with historical evidence kept distinct.

**Checkpoint:** M1–M3 complete for the declared acceptance profiles; M4 not yet complete.

## Start here

[Architecture](architecture.md) defines the host, packages and trust boundaries.
[Contributing](../.github/CONTRIBUTING.md) is the single contribution policy.
[Validation](validation.md) lists current commands and evidence limits.
[Code Foundry](code-foundry.md) explains deterministic sync and contributor hooks.
[Manual native qualification](manual-native-qualification.md) runs disposable
Windows, Linux and macOS cloud tests without local VMs.

## Accepted milestone records

| Record                                  | Scope                                                    |
| --------------------------------------- | -------------------------------------------------------- |
| [M1 completion](m1-completion.md)       | Host decision, native probes and foundational contracts  |
| [M2 completion](m2-completion.md)       | Local reference baselines and measurement infrastructure |
| [M3 completion](m3-completion.md)       | Declared native CEF platform and lifecycle acceptance    |
| [Foundation audit](foundation-audit.md) | Post-M3 hygiene, sync and dependency-security review     |

The detailed M2/M3 acceptance reports and `evidence/` retain original source
identities, failed attempts and qualification boundaries. Completing a milestone
does not imply production signing, final performance superiority, or platform
coverage outside its stated profile.

## Active technical guides

[Packaged origin](packaged-origin.md), [artifact acquisition](artifact-acquisition.md),
[RPC](rpc.md), [streams](streams.md), and [provenance](provenance.md) describe their
implemented surfaces and remaining limits. [M4 progress](m4-progress.md) and
[M5 progress](m5-progress.md) are partial implementation notes, not closeout claims.

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
