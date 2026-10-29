# M3 completion

Standalone CEF runtime and declared initial native-platform acceptance.

**Date:** October 21, 2026.
**Scope:** M3 #12–#17; functional acceptance, not production-release or performance approval.
**Delivery:** PR #83 completes Windows #13 and the manual hosted test route; M3 closes after merge.

## Delivered runtime

The stable native GUI owner executes one supervised Bun application process,
maintains generation-safe window/view ownership, handles native/browser/backend
shutdown, serves constrained packaged application resources, and acquires/reuses
exact verified CEF artifacts. Normal consumer acceptance uses prebuilt components,
not an implicit Rust, Zig or C++ compilation. macOS/shared-runtime evidence is
preserved in `evidence/m3-macos`; the earlier Linux guest evidence is preserved in
`evidence/m3-linux`.

| Issue | Completed initial outcome                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| #12   | macOS arm64 native owner, helpers, readiness and deterministic shutdown                                                            |
| #13   | Windows x64 sandbox bootstrap, native message loop, standard-user execution and process/token/job acceptance                       |
| #14   | Linux x64 X11 runtime, declared dependencies and observed namespace/seccomp isolation                                              |
| #15   | Multiple windows/child views, asynchronous ownership, navigation generations, disposal and failure convergence                     |
| #16   | Authenticated version-pinned full CEF acquisition, atomic cache use, integrity and disk-full recovery                              |
| #17   | Packaged origin, constrained assets, modules/ranges/cache semantics, development-origin separation and adversarial resource checks |

## Hosted confirmation

All three full jobs passed using standard deadlines and non-emulated target CPUs.
Each contains five successful packaged executions with 20 create/close cycles
apiece, plus startup-rejection tests, development-origin checks, and four actual
process-fault cases. Missing evidence, timeouts, leaked descendants and suppressed
sandbox state cannot count as success.

| Target                       | Hosted run    | Prebuilt cases | Fault cases | Execution source                           |
| ---------------------------- | ------------- | -------------: | ----------: | ------------------------------------------ |
| Windows x64 / `windows-2022` | `39660076479` |             10 |           4 | `307d511e7df820abb6493e67de93aa80a890f54b` |
| Linux x64 / `ubuntu-22.04`   | `39659641250` |             12 |           4 | `1dea25122ea1e1a9f5db827440232c215adf6ec1` |
| macOS arm64 / `macos-15`     | `39660081412` |             11 |           4 | `307d511e7df820abb6493e67de93aa80a890f54b` |

The later source differs in portable test fixtures only: Windows newline/path
handling and the macOS Python launcher-versus-executable assertion. Production
identity and signing validation were not weakened. Initial failed runs remain
identified in `evidence/m3-hosted-runs.json`.

Windows acceptance ran under a new standard local account. Native browser samples
include low-integrity restricted/AppContainer tokens and job membership. The
actual CEF export is 154.0.34 / Chromium 154.0.8037.98, and bundled Bun runtime version is redacted.
No Apple account, production certificate, local x64 emulation or persistent
cloud machine was required. The workflow removes its temporary Windows account
and GitHub disposes of each hosted job environment.

## Reproduce

Use **Actions → M3 native CEF runtime → Run workflow**, or:

```sh
gh workflow run cef-runtime.yml --ref main -f platform=windows -f suite=full
gh workflow run cef-runtime.yml --ref main -f platform=all -f suite=full
python scripts/report_m3_platform.py evidence/m3-windows
python scripts/report_m3_platform.py evidence/m3-linux
python scripts/report_m3_acceptance.py
```

The first two execute new cloud tests. The Python commands independently verify
preserved evidence; replay is never presented as a new OS execution. Manual
workflows retain explicit diagnostic artifacts for seven days. The permanent
Windows reports and their hashes are committed, so issue acceptance does not
rely solely on expiring Actions artifacts.

## Remaining product boundaries

M4 owns native-bound document authority, scoped browser/native permissions,
persistent sessions and production transport integration. M5/M6 own terminals,
streaming and managed backend replacement. M7 #38 and M8 #43 retain physical
input/IME/DPI/accessibility and broader platform/runtime conformance. M8 #41 owns
distribution signing/notarization; M9 #44 owns controlled performance comparisons.

The accepted profiles do not assert native Wayland support, Windows ARM64,
hardware acceleration, physical input-to-photon latency, continuous sandbox
attestation, or production release readiness. Public-origin pages remain
unprivileged; a successful visible browser is not a replacement for M4 security.

Automatic CI's billing pause is unchanged. Manual dispatch is an exact, tested
exception, not a global CI unpause. No local Bunly VM/container was restarted,
no production resources or Adea configuration changed, and nothing was published
as a software release.
