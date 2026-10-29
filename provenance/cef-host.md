# CEF host provenance

The CEF binding/tool dependency is pinned to tauri-apps/cef-rs commit
`a46b48c6221f99414a5c6b37ff86491772f9b0a2` (released workspace 156.0.0+156.0.7,
CEF 156.0.7 / Chromium 156.0.8078.17). The previous qualified runtime used
`163744c8286d5f593d89202c7807751a7898db28` (154.5.0+154.0.34); its retained
qualification and transport measurements remain historical evidence, not results
for the upgraded browser.
Repository: https://github.com/tauri-apps/cef-rs
License: Apache-2.0 OR MIT. Upstream notices must accompany binary distributions.

The AppKit CEF protocol subclass in `native/cef-host/src/mac.rs` adapts the
`examples/cefsimple/src/mac/mod.rs` protocol/event-loop pattern at the original
`163744c8286d5f593d89202c7807751a7898db28` revision. The Views delegate, helper and
Windows `RunWinMain` integration were originally based on that revision's examples.
The runtime upgrade does not relabel the provenance of those existing adaptations. Bunly's control protocol, registry and public-asset resolver
are repository implementation, not a copied Mirin SDK.

Mirin's `crates/mirin-core/src/scheme.rs` was inspected for current cef-rs method
signatures and scheme registration. Its permissive local-network switches,
filesystem fallback and renderer bridge are not adopted.

CEF/Bun/native-helper binaries are obtained by the contributor build pipeline;
none are committed as repository source. Public runtime signing/publishing is
not enabled by this work. Application assembly consumes prebuilt components.

## Download completion diagnostics

The download timeout diagnostics are Bunly-authored. The pinned sources below
were inspected to identify CEF's existing child-launch callback, Chromium's exact
quarantine utility subtype, and its position after download-completion gates.
No upstream implementation was copied. The diagnostic reads only fixed native
callback fields and counts recognized launches; it does not change Chromium's
download or Windows Attachment Services behavior.

- https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/chrome/chrome_content_browser_client_cef.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/content/browser/service_host/utility_process_host.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/download/internal/common/download_item_impl.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/services/quarantine/public/mojom/quarantine.mojom

## Download staging filename

The private staging target preserves the validated final basename so Chromium
and Windows Attachment Services receive the intended filename during annotation.
This Bunly-authored change follows the pinned rename/annotation flow and the
documented Windows filename and extension policy inputs; no upstream code was
copied. It does not establish a cause for any historical download timeout.

- https://github.com/chromium/chromium/blob/156.0.8078.17/components/download/internal/common/download_file_impl.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/services/quarantine/quarantine_win.cc
- https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iattachmentexecute-setlocalpath
- https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-attachmentmanager

## Parent-window close references

The guarded close batch and overlay reattachment in Bunly's host are authored
implementation based on pinned CEF `47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`
behavior. No upstream implementation is copied:

- [Alloy browser host](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/alloy/alloy_browser_host_impl.cc):
  `TryCloseBrowser` can return false after a synchronous `CloseContents`
  transition has accepted close and requested another parent close. Bunly
  preserves that nested request through one deferred UI retry.
- [Views platform delegate](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/browser_platform_delegate_views.cc):
  `CloseHostWindow` calls the owning widget's close operation.
- [Overlay view host](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/overlay_view_host.cc):
  cleanup detaches overlay contents and resumes their ownership for reuse;
  `Close` does not repeat that cleanup while its widget is already closing.
- [Window API](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/views/cef_window.h)
  and [View API](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/views/cef_view.h):
  the same parent owns reattached content, with attachment and parent identity
  read back before the retired overlay-controller wrapper is released.

## Native menu input driver

The contributor-only macOS menu input driver in
`native/cef-host/src/window_commands_macos.rs` is Bunly-authored code using the
pinned `objc2-app-kit` 0.3.2 bindings and AppKit's documented event queue. The
Chromium 156.0.8078.17 `ui/views/controls/menu/menu_runner_impl_cocoa.mm` nested
task behavior and CEF `47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`
`libcef/browser/views/view_util_mac.mm` NSView handle conversion were inspected;
their implementations were not copied. The driver is limited to four local
events for an already-authorized fixture popup and does not qualify physical
input or invoke application command callbacks directly.

The production macOS cancellation wake in `native_menu_wake.rs` is Bunly-authored
code using the existing pinned `objc2-core-foundation` 0.3.2 dependency. It follows
Apple's documented `CFRunLoopPerformBlock` copy and `CFRunLoopWakeUp` semantics in
Cocoa common modes. The pinned Chromium menu runner and `ui/base/cocoa/menu_utils.mm`
were inspected to keep ordinary CEF task dispatch outside the native menu loop;
their implementation was not copied. The wake performs only exact owned popup
cancellation, never general task dispatch or browser/window destruction.

- https://developer.apple.com/documentation/corefoundation/cfrunloopperformblock(_:_:_:)
- https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/RunLoopManagement/RunLoopManagement.html
- https://github.com/chromium/chromium/blob/156.0.8078.17/ui/base/cocoa/menu_utils.mm
The text status-item adapter in `native/cef-host/src/status_items_macos.rs` is
Bunly-authored code using pinned `objc2-app-kit` 0.3.2 declarations and Apple's
documented `NSStatusBar`, `NSStatusItem` and `NSControl` APIs. It copies no upstream
implementation. The retained action target holds a weak Rust callback owner;
actual status-bar removal precedes owner release. Contributor `performClick`
input exercises AppKit target-action dispatch and makes no physical-input claim.

## Cookie-provider format references

The protected-cookie verifier is Bunly implementation using pinned Chromium
156.0.8078.17 format/behavior references, not copied provider code:

- https://github.com/chromium/chromium/blob/156.0.8078.17/net/extras/sqlite/sqlite_persistent_cookie_store.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/os_crypt/async/browser/keychain_key_provider.mm
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/os_crypt/async/browser/dpapi_key_provider.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/os_crypt/async/browser/freedesktop_secret_key_provider.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/os_crypt/async/browser/posix_key_provider.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/components/os_crypt/async/common/encryptor.cc
- https://github.com/chromium/chromium/blob/156.0.8078.17/crypto/apple/fake_keychain_v2.mm

Fixed upstream fallback/mock secrets are used solely to reject those canary
encryptions. No actual OS secret or application credential is embedded or read by
the verifier. Chromium/CEF's bundled upstream notices remain required.
