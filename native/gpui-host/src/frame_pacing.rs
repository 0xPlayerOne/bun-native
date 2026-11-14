//! Which source paces the macOS host's frames.
//!
//! The pinned GPUI (zed `ba63a022`, #65472) paces each window on macOS 14+
//! with a `CAMetalDisplayLink` and draws into the drawables it hands out; on
//! earlier systems it uses the shared `CVDisplayLink` registry and the layer's
//! `nextDrawable`. Upstream measured the new path only on macOS 27 with real
//! Apple GPUs ("Not yet measured: ... macOS 14 and 15").
//!
//! On hosted macOS 15 with the Apple Paravirtual device, a window paced by the
//! `CAMetalDisplayLink` stops showing new frames although GPUI keeps drawing and
//! presenting them: run 43120540995 (overlays, AOT) shows the display itself
//! (`screencapture -R`), not only the window capture, still at the "h" frame
//! after six later display-link frames and a synchronous `displayLayer:` frame
//! were presented; the Metal renderer logged no dropped or failed frame and the
//! host stayed responsive. The display link kept delivering drawables after
//! the freeze, so presents were consumed, not blocked. The first frame that
//! never appeared was drawn in a display-link update, before any synchronous
//! frame, and every later present on that layer, by either path, stayed off
//! screen. The same stale frames ended earlier hosted runs (overlays at "hel",
//! the Solid dark theme). The macOS-paced fixtures pass on that device
//! otherwise, and on Linux.
//!
//! On that device only, the host therefore asks its patched `gpui_macos`
//! (`native/vendor/gpui_macos`) for GPUI's long-standing `CVDisplayLink` path.
//! Every other Metal device keeps GPUI's default.

/// `MTLDevice.name` of the virtual GPU of Apple's Virtualization framework,
/// as the hosted runners report it (`CAMetalLayer.device` in the renderer
/// evidence).
const PARAVIRTUAL_DEVICE: &str = "Apple Paravirtual device";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrameSource {
    /// GPUI's default on macOS 14+.
    MetalDisplayLink,
    /// GPUI's `CVDisplayLink` path, requested by the host.
    CvDisplayLink,
}

impl FrameSource {
    pub(crate) fn for_device(name: Option<&str>) -> Self {
        if name == Some(PARAVIRTUAL_DEVICE) {
            Self::CvDisplayLink
        } else {
            Self::MetalDisplayLink
        }
    }

    /// Whether the host dirties the backing layer so AppKit's deferred
    /// `displayLayer:` pass draws external commits.
    ///
    /// Only the `CAMetalDisplayLink` pauses while idle and needs that pass. The
    /// `CVDisplayLink` keeps ticking and draws any refreshed window on its next
    /// frame. On the paravirtual device a `displayLayer:` pass while the window
    /// was visible was the last frame shown: main run 43152733468 (overlays,
    /// development) painted revision 2 in that synchronous pass 2 ms after the
    /// invalidation and never painted again, so the modal dialog stayed off
    /// screen; the Solid dark theme ended the same way.
    pub(crate) fn invalidates_layer(self) -> bool {
        self == Self::MetalDisplayLink
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::MetalDisplayLink => "CAMetalDisplayLink",
            Self::CvDisplayLink => "CVDisplayLink",
        }
    }
}

#[cfg(target_os = "macos")]
static CHOSEN: std::sync::OnceLock<FrameSource> = std::sync::OnceLock::new();

/// Start the device query while GPUI constructs its platform. Only the owned
/// device name crosses threads; all frame-source changes stay on the UI thread.
#[cfg(target_os = "macos")]
pub(crate) fn begin() -> Option<std::thread::JoinHandle<Option<String>>> {
    std::thread::Builder::new()
        .name("bun-native-metal-device".into())
        .spawn(bun_native_macos_surface::system_metal_device_name)
        .ok()
}

/// Finish on the UI thread before any application window can be opened.
/// A failed spawn or worker panic falls back to the original synchronous query.
#[cfg(target_os = "macos")]
pub(crate) fn finish(worker: Option<std::thread::JoinHandle<Option<String>>>) {
    let device = resolve_device(worker, bun_native_macos_surface::system_metal_device_name);
    let source = FrameSource::for_device(device.as_deref());
    if source == FrameSource::CvDisplayLink {
        gpui_macos::disable_metal_display_link();
    }
    let _ = CHOSEN.set(source);
}

#[cfg(any(target_os = "macos", test))]
fn resolve_device(
    worker: Option<std::thread::JoinHandle<Option<String>>>,
    fallback: impl FnOnce() -> Option<String>,
) -> Option<String> {
    match worker {
        Some(worker) => worker.join().unwrap_or_else(|_| fallback()),
        None => fallback(),
    }
}

/// The frame source chosen by [`finish`], for the renderer evidence.
#[cfg(target_os = "macos")]
pub(crate) fn chosen() -> Option<FrameSource> {
    CHOSEN.get().copied()
}

/// Whether external commits dirty the backing layer, see
/// [`FrameSource::invalidates_layer`]. GPUI's default applies until
/// [`finish`] runs.
#[cfg(target_os = "macos")]
pub(crate) fn invalidates_layer() -> bool {
    chosen().is_none_or(FrameSource::invalidates_layer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_query_joins_and_only_falls_back_on_worker_failure() {
        let worker = std::thread::spawn(|| Some("Apple Paravirtual device".to_owned()));
        let device = resolve_device(Some(worker), || panic!("unexpected fallback"));
        assert_eq!(
            FrameSource::for_device(device.as_deref()),
            FrameSource::CvDisplayLink
        );

        let no_device = std::thread::spawn(|| None);
        assert_eq!(
            resolve_device(Some(no_device), || panic!("unexpected fallback")),
            None
        );
        assert_eq!(
            resolve_device(None, || Some("fallback".into())),
            Some("fallback".into())
        );
        let failed = std::thread::spawn(|| -> Option<String> { panic!("test worker failure") });
        assert_eq!(
            resolve_device(Some(failed), || Some("fallback".into())),
            Some("fallback".into())
        );
    }

    #[test]
    fn only_the_paravirtual_device_leaves_the_metal_display_link() {
        assert_eq!(
            FrameSource::for_device(Some("Apple Paravirtual device")),
            FrameSource::CvDisplayLink
        );
        for name in [
            Some("Apple M4 Max"),
            Some("Apple M1"),
            Some("AMD Radeon Pro 5500M"),
            None,
        ] {
            assert_eq!(
                FrameSource::for_device(name),
                FrameSource::MetalDisplayLink,
                "{name:?}"
            );
        }
        assert!(FrameSource::MetalDisplayLink.invalidates_layer());
        assert!(!FrameSource::CvDisplayLink.invalidates_layer());
        assert_eq!(FrameSource::CvDisplayLink.name(), "CVDisplayLink");
        assert_eq!(FrameSource::MetalDisplayLink.name(), "CAMetalDisplayLink");
    }
}
