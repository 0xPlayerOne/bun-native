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

M4 renderer RPC uses CEF process messages, not a loopback server. The browser
process owns the one-shot view/main-frame/document binding and the renderer gets
only bounded packet send/subscribe functions in the approved V8 context. Run
`bun run qualify:cef-rpc -- <prepared-app>` for the maintained native roundtrip;
the `cef/dox` build validates APIs but is not execution evidence.
The maintained RPC security fixture uses the explicit contributor-only
`rpc-qualification` feature alongside `packaging`. It injects adversarial native
process messages without adding any page API, and is excluded from normal builds.
For the focused borrowed-function investigation, `rpc-context-diagnostics` includes
those probes and adds capped native context provenance on stderr (32 records per
renderer, 2048 bytes each), without a page API or credential/payload logging.
Prepare a new immutable application for each candidate; do not overwrite an app
already used by a retained qualification report. GUI execution remains separate.
Use a separate target directory for `cef/dox`. `CEF_PATH` can name the exact
retained platform distribution containing its validated `archive.json`, headers,
wrapper sources and framework; pinned cef-rs checks that metadata before reuse.
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

## Native permission-policy qualification

The contributor `rpc-qualification` configuration also supports the fixed
user-activation fixture used by `qualify-cef-development.ts`. It has no arbitrary
evaluation/input parameters, validates the current native document and explicit
development origin, and opens no debugging endpoint. Normal builds exclude it.
The fixture requires actual denial callbacks, revoked captured policy scopes and
ordered teardown. It does not claim hardware input, successful OS permission
prompts or implementation of M7 native operation adapters.

The development-policy qualifier additionally requests synthetic capture devices
in an `rpc-qualification` build with an exact explicit development origin. This
makes real media-denial callbacks testable on hardware-free runners. It does not
auto-grant media permission, enable fake permission UI, open a debugging port, or
ship in an ordinary native build. Schema-3 policy evidence records this fixture
provenance explicitly; it is not hardware-device or OS-permission qualification.

Session network policies are immutable native context owners shared with browser
and context-level IO handlers; they never read the UI registry on the IO thread.
`qualify:cef-network` requires actual cross-origin/worker denial, ordinary HTTPS
verification, certificate rejection, authority revocation and ordered teardown.
It is not general network-egress isolation; see `docs/m4-network-policy.md`.

## Transport contributor boundary

Native-mediated application RPC uses bounded fragmentation over the existing
24 KiB native packets. The transport comparison fixture is compiled only with
`rpc-qualification`: a fixed native throttle method confirms actual Chromium
completion, and the experimental loopback candidate has one configured numeric
CSP endpoint plus a socket challenge confirmed by the exact native document.

The pinned browser also requires loopback network reachability. Qualification
handles only that exact permission type for the named packaged transport fixture
in a local-only ephemeral context with live native authority. CEF supplies no
requesting frame for this prompt; the decision is deliberately described as
top-origin reachability, not as a child-frame capability grant. The socket still
rejects stolen credentials confirmed by another same-origin native binding.
Ordinary native builds exclude this decision, preserve generic prompt denial and
reject experimental loopback setup. A successful contributor comparison does not
qualify this permission path for shipping applications or arbitrary remote pages.

## Opt-in shutdown diagnostics

`shutdown-diagnostics` records the final lifetime of four named Bunly callback
wrapper classes at the final UI fence and around CEF shutdown. Default builds
allocate no audit owner and emit no audit event. These counters do not measure
Chromium internal references or prove that thread-pool work has drained. See
[the investigation](../../docs/cef-shutdown-investigation.md) for the maintained
read-only capture command, unchanged historical failures and current limitations.
