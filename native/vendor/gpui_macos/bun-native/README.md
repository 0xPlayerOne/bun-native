# Bun Native's patched `gpui_macos`

This directory records the provenance of the adjacent copy of zed's `gpui_macos` crate. The upstream files come from zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` (`crates/gpui_macos`), the same revision every other GPUI crate in Bun Native's lockfile uses. The crate's Apache-2.0 license file is retained as a regular file. This is the one crate alone, not a GPUI upgrade. The root `Cargo.toml` patches it in by path for the zed Git source.

## The patch

`metal-display-link-switch.patch` changes three files and nothing else:

- `src/display_link.rs` adds `disable_metal_display_link()`, a process-wide switch, and `metal_display_link_enabled()`, which is `MetalFrameSource::is_available()` unless the switch is set.
- `src/window.rs` asks `metal_display_link_enabled()` instead of `MetalFrameSource::is_available()` when a window chooses its frame source.
- `src/gpui_macos.rs` re-exports the switch.

When the switch is set before a window opens, that window takes the path this crate already takes on macOS 12 and 13, where `CAMetalDisplayLink` does not exist: the shared `CVDisplayLink` registry paces its frames and the renderer draws into the layer's `nextDrawable`. No new frame path or timer is added, and no frame decision changes. Without the switch, behavior is upstream's.

## Why

The host sets the switch only when the system's Metal device is the `Apple Paravirtual device`, the virtual GPU of the hosted macOS runners ([`src/frame_pacing.rs`](../../../gpui-host/src/frame_pacing.rs)). Every other device keeps GPUI's `CAMetalDisplayLink`.

Upstream introduced the `CAMetalDisplayLink` path in zed #65472, two weeks before this revision, and measured it only on macOS 27 with real Apple GPUs; that PR lists macOS 14 and 15 as not yet measured. On hosted macOS 15 with the paravirtual device, windows paced by it stopped showing new frames:

- Run 43120540995 (overlays, AOT): both the window capture and a capture of the display itself (`screencapture -R`) still showed the editor's "h" frame 2 s after the modal dialog was painted. The host's presentation records show the first missing frame was drawn by a display-link update, six display-link frames followed, then a synchronous `displayLayer:` frame, and none of them reached the screen. The Metal renderer logged no skipped or failed frame, and the host answered shutdown at once.
- The display link kept handing out drawables after the freeze, so the presents were consumed rather than blocked on drawable exhaustion. The layer no longer showed any frame presented to it, whichever path presented it. This part is inferred from the records, not observed inside Core Animation.
- Earlier hosted runs ended the same way: overlays at "hel", and the Solid layout-style fixture on its light theme after the dark-theme paint.

Whether `CVDisplayLink` pacing keeps every frame on screen on that device is for the next hosted run to show, through the same unchanged pixel assertions and presentation records.

## Files

`Cargo.toml.upstream` and `workspace.toml.upstream` preserve both original manifests. The standalone `Cargo.toml` expands their inherited metadata and dependencies. It unions inherited and local features and keeps target conditions, optional flags and default-feature settings. The five sibling zed crates (`gpui`, `gpui_apple`, `gpui_util`, `collections`, `scheduler`) keep the original Git URL and exact revision. The crate has its own workspace boundary.

`upstream.json` records the byte size and SHA-256 of every upstream file and of zed's workspace manifest. Every file outside the three patched ones and `Cargo.toml` is byte-identical to upstream. Reversing the patch on the vendored `src` reproduces upstream exactly:

```sh
work=$(mktemp -d) && cp -r native/vendor/gpui_macos/src "$work/" &&
  patch -R -p1 -d "$work" < native/vendor/gpui_macos/bun-native/metal-display-link-switch.patch &&
  diff -r "$work/src" "$ZED_BA63A022/crates/gpui_macos/src"
```

The lockfile changes only by dropping `gpui_macos`'s Git source line and adding it to the host's dependencies.
