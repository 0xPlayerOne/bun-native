# Bun Native provenance and third-party code

This file is the active provenance policy for the new Bun Native implementation. The prior Bunly/CEF source inventory and historical M1/M2 decisions are retained in Git history, not active architecture guidance.

## Rules

- Preserve upstream copyright notices, license requirements and attribution when copying or adapting GPUI, Zed, other native rendering source, framework adapters, dependencies, examples or benchmark fixtures.
- Inspect licensing and binary redistribution requirements before importing a crate, package, asset or prebuilt native library. Track exact upstream project, revision, license, copied files and local changes.
- Do not represent competitors' implementation or benchmarks as original Bun Native work. Comparable benchmark runs must be independently reproduced under the documented workload.
- Remove provenance entries for code **no longer shipped** from the active inventory when old Bunly/CEF code is deleted, while preserving historical evidence in Git history.
- Reconcile [LICENSE](../LICENSE), [NOTICE](../NOTICE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) with actual native artifacts before distribution.
- Keep credentials, signing keys, personal machine paths and third-party private code out of the repository.

## New source inventory

**Not yet populated.** BN0's native host/toolchain and BN1's bridge implementation must create a versioned record of external source actually copied or bundled. Reference-only research links are not copied code.

## Required record format

| Component                          | Upstream/revision | License | Files or binaries used | Changes | Shipped target |
| ---------------------------------- | ----------------- | ------- | ---------------------- | ------- | -------------- |
| _Populate as implementation lands_ |                   |         |                        |         |                |

See [architecture](architecture.md), [releasing](releasing.md) and [BN7 docs/provenance #254](https://github.com/0xPlayerOne/bun-native/issues/254).
