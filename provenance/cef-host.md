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
