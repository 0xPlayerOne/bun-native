# Bun Native's pinned HAL patch

This directory records the provenance of the adjacent `wgpu-hal` copy for [Bun Native #370](https://github.com/0xPlayerOne/bun-native/issues/370). The 86 upstream files come from WGPU `cddb2f5d80dc0009b2ef6767635140cacf90a007`; the package's original MIT and Apache-2.0 license files are retained unchanged. This is the HAL crate alone, not a WGPU or GPUI upgrade.

Two reviewed patches modify only `src/gles/egl.rs`:

- `construction-rollback.patch` retains the existing display mutex while initializing, records a reference only after successful initialization, and owns the reference/context through fallible construction until `Inner` accepts them.
- `pbuffer-owner-release.patch` releases the successful owner's optional dummy pbuffer before the existing context and display cleanup, including when another owner keeps the display alive.

The original constructor errors, backend selection, robustness fallback and successful creation path are preserved. The pre-existing `EglContext` cloning caveat is unchanged. These fixes have deterministic actual-constructor/drop controls through an isolated fake EGL ABI in [research PR #373](https://github.com/0xPlayerOne/bun-native/pull/373): the baseline has eleven failing invariants and one passing normal-owner control; construction rollback makes eleven pass while retaining the separate pbuffer failure; both fixes make all twelve pass. Those controls do not qualify real drivers or establish a cause for the unrelated startup delay in #296.

`Cargo.toml.upstream` and `workspace.toml.upstream` preserve both original manifests. The adjacent standalone `Cargo.toml` expands their inherited metadata and dependencies, unions inherited and local features, and preserves target conditions/default-feature settings. Its five sibling dependencies (`naga`, `naga-types`, `wgpu-naga-bridge`, `wgpu-sync`, `wgpu-types`) explicitly retain the original Git URL and exact `cddb2f5` revision. They must not silently become registry or separate path packages. The crate has its own workspace boundary; Bun Native's three workspace members remain unchanged.

Run `python3 scripts/quality/verify-wgpu-vendor.py` from the checkout to verify the complete inventory, original Git blob/SHA-256 hashes, materialized manifest and both patches. Verification reverses the reviewed patches in an owned temporary copy and requires the result to match the pristine upstream EGL blob. It never modifies the supplied package or any shared Cargo checkout. The hashes and tree identity are recorded in `upstream.json`.

The upstream `trunk` file was also inspected at `66d5a64f2e0d81619bcc1be87f3155c24a94ddc1`: its EGL blob `f9895609fb62bb2423262cbcb6ac66f825b1bb40` and SHA-256 `2663a1da95a05dc6f0ce33f1479934cf7a67736973dc353c3ac90073260e865b` match the pinned file exactly. That checked revision does not contain these fixes. Adoption here does not change the upstream repository.

## Bun Native integration evidence

`tests/native/evidence/wgpu-hal-linux-graph.json` records the Linux graph comparison: 485 packages and 1,307 dependency edges, identical node features/edges after the sole HAL source identity replacement. All 484 non-HAL package records are unchanged; the lockfile changes only by removing the HAL's Git source line. The standalone manifest also received independent declaration-by-declaration comparison across all target, build and development dependencies.

`tests/native/evidence/wgpu-hal-linux-build.json` binds successful release host compilation and workspace all-target Clippy to clean source `4200185c53a31db131c11749217ae74431d619e5`, equivalent published source `707e58cb02d9552ebe3166109aed408620ef396e`. The release host is 29,500,976 bytes with SHA-256 `ec0bbe8b15a5a4e12c3e0f8c4f01e6c45f61195866c887ecb5ffdeecf6affdbf`. This is compilation evidence, not native execution. The local macOS host cross-check stops at uncached `accesskit_macos 0.26.3`; hosted platform qualification remains necessary.

The subsequent provenance-only change includes vendored manifests, build scripts and source assets in AOT/native diagnostic fingerprints. A fixed inventory fixture and independent filesystem/snapshot controls demonstrate the old omission and the corrected coverage. AOT and diagnostics include all 77 HAL compile inputs; the allocation snapshot's existing recursive Rust inventory is supplemented by the four GLSL assets. Native runtime code and its deadlines are unchanged by this follow-up.
