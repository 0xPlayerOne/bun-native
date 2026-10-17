# Third-party inventory

M1 contains no vendored competitor code or browser distribution. Prior-art
references and their immutable revisions are in `provenance/references.json`.
A reference is not a claim that the referenced implementation is included.

Development dependencies are recorded by the root package manifest and Bun
lockfile. Their licenses remain with their distributions. The native probe uses
the Rust standard library (MIT OR Apache-2.0); see
https://github.com/rust-lang/rust/tree/1.85.1 for the corresponding license texts.
Its source has no third-party Cargo dependencies.

The CI artifact packer emits a minimal SBOM input manifest and separates native
debug symbols. This is an internal qualification artifact, not a complete public
runtime distribution or certified production SBOM.

Before Bun, CEF/Chromium, helpers, optional native modules, codecs, or copied
platform integration code are distributed, extend this inventory and include
their actual required notices. Do not assume a competitor's MIT license covers
all of its binary dependencies. Production artifact trust and signing are separate
from the ephemeral test keys used in M1.
