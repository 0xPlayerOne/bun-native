# Bun Native's patched `gpui_wgpu`

This directory records the provenance of the adjacent copy of zed's `gpui_wgpu` crate. The upstream files come from zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` (`crates/gpui_wgpu`), the same revision every other GPUI crate in Bun Native's lockfile uses. Upstream's `LICENSE-APACHE` is a symlink to zed's root license; the copy here is that file's content as a regular file. This is the one crate alone, not a GPUI upgrade. The root `Cargo.toml` patches it in by path for the zed Git source, next to [`gpui_linux`](../../gpui_linux/bun-native/README.md) and [`gpui_macos`](../../gpui_macos/bun-native/README.md). It is used on Linux only; macOS and Windows use their own renderers.

## The patch

`shared-pipelines.patch` changes one file, `src/wgpu_renderer.rs`:

- `WgpuPipelines` and `WgpuBindGroupLayouts` derive `Clone` (every member is a reference-counted wgpu handle).
- A thread-local registry keeps, per wgpu device, one set of bind group layouts and the render pipelines built for each (surface format, alpha mode, path sample count, dual-source blending) key. `WgpuRendererCore::new` and the alpha-mode change take their layouts and pipelines from it, building them only on first use.
- Entries hold a `Weak` reference to the device and are dropped once it is gone, so device recovery builds a fresh set for the new device.

Nothing else changes: each window keeps its own buffers, bind groups, atlas bind groups and intermediate textures, and the pipelines are the same objects upstream would have built with the same descriptors.

## Why

Upstream builds the bind group layouts, parses and validates the WGSL module (naga) and compiles every render pipeline in `WgpuRendererCore::new`, once per window, although the device and queue are shared. Round 2 profiling (perf over five window opens on lavapipe) put about 49 ms of UI-thread CPU per window there, about 15 ms of it naga. Bun Native popups are GPUI windows too, so every popup paid it. With the registry, the first window pays it once per device and each later window or popup reuses the result. Measured with round 2's multi-window probe (four windows, close three, reopen; Xvfb and lavapipe, Linux x64 release host, three interleaved runs each): windows 2 to 4 opened in 41–53 ms before and 2.9–5.4 ms after, a reopen after close in 39–44 ms before and 2.6–3.4 ms after. The first window is unchanged (77–99 ms).

Not done: a persistent `wgpu::PipelineCache`. Real Vulkan drivers already keep their own disk caches; a wgpu cache would need a cache directory, invalidation on driver changes and Vulkan-only feature checks, and mainly helps lavapipe CI.

Upstream: the same sharing fits `WgpuContext` (it already shares device and queue) and is worth offering to zed, after which this vendor can be retired.

## Files

`Cargo.toml.upstream` and `workspace.toml.upstream` preserve both original manifests. The standalone `Cargo.toml` expands their inherited metadata and dependencies and keeps target conditions, optional flags and default-feature settings unchanged. The sibling zed crates (`gpui`, `gpui_util`, `collections`) keep the original Git URL and exact revision, and `wgpu` the same gfx-rs revision (still patched by `native/vendor/wgpu-hal`). The crate has its own workspace boundary.

`upstream.json` records the byte size and SHA-256 of every upstream file and of zed's workspace manifest, and the SHA-256 of each patch in the order it applies. `tests/quality/test_gpui_vendor.py` checks the inventory, every hash and the reversed patches on every quality test run. Every file outside `src/wgpu_renderer.rs` and `Cargo.toml` is byte-identical to upstream. Reversing the patch on the vendored `src` reproduces upstream exactly:

```sh
work=$(mktemp -d) && cp -r native/vendor/gpui_wgpu/src "$work/" &&
  patch -R -p1 -d "$work" < native/vendor/gpui_wgpu/bun-native/shared-pipelines.patch &&
  diff -r "$work/src" "$ZED_BA63A022/crates/gpui_wgpu/src"
```

The lockfile changes only by dropping `gpui_wgpu`'s Git source line.
