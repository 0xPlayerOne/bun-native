# CEF host provenance

The CEF binding/tool dependency is pinned to tauri-apps/cef-rs commit
`163744c8286d5f593d89202c7807751a7898db28` (workspace 154.5.0+154.0.34).
Repository: https://github.com/tauri-apps/cef-rs
License: Apache-2.0 OR MIT. Upstream notices must accompany binary distributions.

The AppKit CEF protocol subclass in `native/cef-host/src/mac.rs` adapts the
`examples/cefsimple/src/mac/mod.rs` protocol/event-loop pattern at this revision.
The Views delegate, helper and Windows `RunWinMain` integration follow the same
revision's examples. Bunly's control protocol, registry and public-asset resolver
are repository implementation, not a copied Mirin SDK.

Mirin's `crates/mirin-core/src/scheme.rs` was inspected for current cef-rs method
signatures and scheme registration. Its permissive local-network switches,
filesystem fallback and renderer bridge are not adopted.

CEF/Bun/native-helper binaries are obtained by the contributor build pipeline;
none are committed as repository source. Public runtime signing/publishing is
not enabled by this work. Application assembly consumes prebuilt components.
