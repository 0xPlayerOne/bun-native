# Benchmark dependency and provenance inventory

These dependencies are test infrastructure, not Bunly distribution payloads.
No competitor implementation source is copied into this adapter code.

| Dependency   | Pin    | Use                                | Retained provenance                                                                            |
| ------------ | ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| @xterm/xterm | 5.5.0  | Shared real terminal renderer      | fixtures/bun.lock integrity; installed package metadata and LICENSE                            |
| electron     | 44.9.3 | Actual baseline runtime            | adapters/electron/bun.lock, upstream binary installer/checksums, references.json source commit |
| psutil       | 7.0.0  | Contributor-only external observer | Explicit CI/command pin; installed package metadata and license                                |

Transitive npm dependencies are frozen in each adapter's Bun lock. These locks
are intentionally independent of the consumer SDK lock so normal Bunly development
does not download a competing browser distribution. Python wheel availability and
Python version are recorded by CI; the current Python dependency pin is not a
claim of a fully content-addressed Python toolchain.

Keep the installed Electron/Chromium notices and xterm license with any future
redistribution of their binaries or bundled assets. Currently CI consumes the
packages for tests; no public bundle or release is produced. Benchmark dependencies
must never be added to Bunly's native-runtime artifact manifest by default.

Upstream API examples were consulted at the revisions in references.json. The
adapters are original integration fixtures, not claims of clean-room isolation
from all public documentation. Moving upstream links are not benchmark pins.
