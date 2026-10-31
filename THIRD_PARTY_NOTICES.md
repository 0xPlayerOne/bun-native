# Third-party inventory

The root package manifest and `bun.lock` record development dependencies. They
are not application runtime dependencies. Their license notices remain with
their distributions. Code Foundry's retained maintenance templates and managed
policy blocks carry the attribution in [NOTICE](NOTICE).

Native dependencies and exact versions belong in `Cargo.lock`. GPUI and
any adapted upstream examples must retain their license and source attribution
when introduced. The native host's pinned source inventory is maintained in
[docs/provenance.md](docs/provenance.md).

The removed Bunly code, CEF integrations, Electron/Electrobun comparison apps,
xterm fixtures and historical notices remain recoverable in Git history before
the BN0 workspace rewrite. None is shipped by this workspace.

Before distributing Bun or native host binaries, include the notices required
by their actual dependency and asset inventories. A development build does not
constitute a completed redistribution, signing or security review.
