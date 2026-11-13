# BN0 native evidence

Historical BN0 records. They are preserved byte for byte and are not regenerated
by current source.

| Record                                                                    | Content                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`native-smoke-linux-x64.json`](native-smoke-linux-x64.json)              | First real GPUI smoke observations on Linux x64 (development-profile host, llvmpipe). Explained in the [BN0 integration report](../../docs/records/bn0-integration.md). |
| [`release-linux-x64-2026-10-31/`](release-linux-x64-2026-10-31/README.md) | Hosted release-host baseline capture: summary, 12 per-trial reports, compiler diagnostics, linkage and build environment.                                               |

To take a new matched development/AOT baseline from current source, follow
[`NATIVE_BASELINE.md`](../NATIVE_BASELINE.md). Keep new results in a new
directory; do not overwrite these records.
