# Third-party inventory

Bunly's runtime source contains no vendored competitor implementation or browser
distribution. Prior-art references and immutable revisions are recorded in
`provenance/references.json` and `benchmarks/references.json`.

Development dependencies are recorded by the root package manifest and Bun
lockfile. Their licenses remain with their distributions. The native probe uses
the Rust standard library (MIT OR Apache-2.0); corresponding license texts:
https://github.com/rust-lang/rust/tree/1.85.1
Its source has no third-party Cargo dependencies.

M2 benchmark-only dependencies are separated from consumer workspaces:

- Electron 44.9.3 and its runtime/download dependencies, under `benchmarks/adapters/electron`.
- Electrobun 2.0.3-beta.26's published bootstrap and downloaded devkit, under `benchmarks/adapters/electrobun` and generated `.bunly` data.
- xterm 5.5.0 under `benchmarks/fixtures`.
- psutil 7.0.0 in the contributor/CI Python environment.

Their frozen Bun locks or explicit CI pins identify the tested distributions;
licenses and third-party notices remain in those distributions. CEF/Chromium has
its own third-party notices beyond the framework's top-level MIT license. These
benchmark applications are not publicly distributed by Bunly, included in the
Bunly SDK build, or evidence of a completed public-redistribution license review.

The CI native artifact packer emits minimal SBOM inputs and separates native
debug symbols. This is an internal qualification artifact, not a complete public
runtime distribution or certified production SBOM.

Before Bun, CEF/Chromium, helpers, optional native modules, codecs, or copied
platform integration code are shipped by Bunly, extend the inventory and include
their actual required notices. Production artifact trust and signing are separate
from M1's ephemeral test keys and M2's upstream development application builds.
