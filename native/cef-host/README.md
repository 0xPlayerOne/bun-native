# Native CEF host

Framework-contributor build, not an application-developer compiler requirement.
This crate is an independent workspace so CEF dependencies do not enter the M1
probe or the browser SDK. The first CEF host uses the already-qualified native
owner / one supervised Bun subprocess path. Native GUI work stays on CEF's UI
thread; blocking protocol pipes run on dedicated threads with bounded queues.

The Worker/native-library candidate remains in the M1 probes. Adopting the
process fallback for CEF bring-up is not a speed or memory claim. It avoids
binding CEF teardown to experimental Worker/FFI callback-owner destruction.

CEF and the macOS helper keep sandbox support enabled. On Windows the native
library is entered by CEF's supplied sandbox bootstrap through RunWinMain.
Direct unsandboxed Windows execution is rejected. CEF Views supplies native
window/view composition; no Tauri application framework is involved.

The independent Cargo lock is committed and contributor checks use Rust 1.91.0.
Production artifact trust and portability are not established by compilation alone.
See ../../docs/m3-runtime-acceptance.md for acquisition, shutdown, origin policy,
platform boundaries and executable qualification commands.

## Windows CRT ownership

The repository's `.cargo/config.toml` selects `+crt-static` for the declared
`x86_64-pc-windows-msvc` contributor target. The prebuilt `bunly_host.dll` must
not depend on a separately installed `VCRUNTIME140.dll`/MSVC redistributable.
Build from this checkout (or preserve the same target flags when producing an
artifact elsewhere); the consumer never needs Cargo, a C++ compiler, or an
automatic redistributable installer. Other targets retain their existing flags.

A real cross-link and PE import/export inspection qualify the contributor
artifact only. Windows startup, sandbox-token, Unicode-path and lifecycle tests
still require execution on Windows; neither the configuration test nor an API
type-check substitutes for those results. Use the CEF distribution's actual
`bootstrap.exe` as `bunly_host.exe`, alongside the DLL and bootstrap manifest,
as the pinned upstream packager does. Do not use the Rust diagnostic executable
as a substitute bootstrap or remove sandbox support to make it launch.
