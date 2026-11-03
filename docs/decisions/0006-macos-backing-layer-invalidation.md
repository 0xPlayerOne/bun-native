# 0006 — Invalidate the owned macOS backing layer after external commits

Status: proposed correction; current hosted native/AOT acceptance is required.

## Recorded failure

PR #322 run 41708732840 received real pointer input and all 32 native edits.
Its first frame request was delivered; revision 2 was committed and acknowledged,
but the next-frame callback and complete paint never arrived within the unchanged
deadline. The retained trace had remaining capacity and shutdown completed with
zero ownership counters. Neither the earlier refresh-only change nor the later
coalesced frame callback established correctness. These failures remain failed.

## Decision and source boundary

The pinned GPUI macOS view is layer-backed and uses a custom `displayLayer:`
delegate with a `DuringViewResize` view redraw policy. A view invalidation alone
is not a direct invalidation of this backing layer. After committing a batch,
keep GPUI entity notification and window refresh, then call `setNeedsDisplay()`
on the exact owned view's backing layer. Core Animation coalesces that dirty flag
and invokes GPUI's existing display delegate in a normal deferred display pass.
The pinned delegate performs the actual GPUI draw/present and restores its frame
source; this change does not call a drawing or presentation function directly.

This is an explicit native surface invalidation strategy, not a claim that the
internal cause of the display-link stall has been fully attributed. There is no
fallback renderer, timer, poll loop, input retry, altered focus/geometry, or
relaxed paint/deadline assertion. Remove the superseded FrameDemand callback and
its tests; the actual native layer controls replace its ownership/coalescing
coverage rather than keeping another unqualified path.

The source inspection is bound to Zed revision
`ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`, particularly
`crates/gpui_macos/src/window.rs` (backing-layer setup and `display_layer`),
`crates/gpui_macos/src/display_link.rs`, and `crates/gpui/src/window.rs`.
Apple defines the layer invalidation contract in
[CALayer setNeedsDisplay](<https://developer.apple.com/documentation/quartzcore/calayer/setneedsdisplay()>).

## FFI and lifecycle

A private macOS-only `bun-native-macos-surface` crate checks main-thread authority
and the AppKit handle variant before one documented borrowed NSView cast. A
missing layer is an explicit error. The borrowed handle guarantees the NSView
lifetime for the synchronous call; no raw pointer, retained layer, callback or
task escapes. The host and protocol retain `unsafe_code = forbid`; only this
narrow platform crate allows its annotated production dereference. Exact
objc2, AppKit, QuartzCore and raw-window-handle versions already in the native
lockfile are reused. Linux and Windows do not load this dependency.

All production native crates and source files are included in the existing
native/AOT source manifests. Historic evidence is not rewritten. The bounded
opt-in diagnostic records `layer_invalidated`, which is not a paint result.
Only the independent complete native-paint records can satisfy that gate.

## Verification

Actual SDK controls check deferred delivery to a real CALayer delegate,
independent surfaces, 1,000 coalesced invalidations, rearming and unbacked-view
rejection. The same control with the invalidation omitted must fail the dirty
state assertion. The control delegate commits its empty contents to complete
the native display operation; it is not a GPUI or physical-presentation test.
Wrong-platform and worker-thread tests protect the borrowed native boundary.

The unchanged real GPUI development/AOT input, full-tree paint, close/reopen,
negative-paint, protocol, security and CodeQL checks remain mandatory. No source
or SDK-only result qualifies a missing native GUI observation. Any local
permission limitation is reported separately from the hosted input qualification.
