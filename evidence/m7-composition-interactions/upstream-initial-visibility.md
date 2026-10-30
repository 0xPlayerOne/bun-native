# Pinned initial document-visibility boundary

The retained Linux failures use CEF **156.0.7**, commit
`47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`, and Chromium **156.0.8078.17**.
The loaded `libcef.so` SHA-256 is
`d6ae34b71b65685b9fc84f24b53214cdb71a17ceecca0034c3a95a9d4358d86f`.
They fail the unchanged initial-hidden overlay checkpoint described in the
[attempt record](README.md); they do not qualify menu or dialog execution.

## Source explanation

The pinned [CEF Alloy creation path](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/alloy/browser_platform_delegate_alloy.cc#L33-L59)
constructs default WebContents creation parameters. It does not derive initial
hidden intent from the BrowserView or its native widget.

[Chromium initialization](https://github.com/chromium/chromium/blob/156.0.8078.17/content/browser/web_contents/web_contents_impl.cc#L4493-L4504)
uses that creation flag when establishing the initial document state. Its
[first-visibility guard](https://github.com/chromium/chromium/blob/156.0.8078.17/content/browser/web_contents/web_contents_impl.cc#L12710-L12761)
subsequently ignores hidden/occluded updates until the contents has actually
become visible. Native hiding after creation therefore cannot substitute for
the missing creation-time setting in this interval.

The [CEF overlay controller](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/overlay_view_host.cc#L144-L153)
controls its native widget. It does not recreate WebContents with different
parameters. [Aura's hide path](https://github.com/chromium/chromium/blob/156.0.8078.17/ui/aura/window.cc#L1364-L1397)
also returns when the native window is already hidden. Giving a hidden widget
positive bounds does not supply the creation flag: the
[occlusion tracker](https://github.com/chromium/chromium/blob/156.0.8078.17/ui/aura/window_occlusion_tracker.cc#L473-L491)
treats descendants of a hidden ancestor as hidden.

## Public API boundary reviewed

The inspected creation and visibility APIs expose no initial-hidden parameter
for this windowed Views creation path:

- `CefBrowserView::CreateBrowserView` accepts the client, URL, browser settings,
  renderer information, request context and delegate, without an initial
  document-visibility argument or caller-supplied `CefWindowInfo`.
- Browser settings and Linux window information do not provide that setting for
  this route. `CefView::SetVisible` and `CefOverlayController::SetVisible` control
  existing native views/widgets.
- The browser-created delegate runs after creation; it cannot retroactively
  change the creation parameters.
- `CefBrowserHost::WasHidden` is a windowless-rendering operation. The pinned
  [Alloy implementation](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/alloy/alloy_browser_host_impl.cc#L360-L374)
  rejects its use for this windowed runtime.

This is a source-backed explanation of the observed boundary, not a claim that
every possible upstream implementation was examined. Qualifying the declared
initial-hidden contract requires an upstream correction/API that carries the
intent into creation, or a separately reviewed architectural change. Repeating
hide requests, accepting a contradictory renderer receipt or exposing hidden
content temporarily would not establish the existing contract.

The attempted BrowserView visibility update was disproved by an actual Linux run
and normally reverted. No CEF rebuild, hidden OSR fallback, synthetic visibility
receipt or fixture relaxation is included in the retained outcome.
