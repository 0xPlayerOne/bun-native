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
