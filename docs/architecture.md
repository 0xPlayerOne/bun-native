# Bunly architecture

A stable desktop host with replaceable Bun application behavior.

**Status:** M1 contracts and probes; production hosting remains conditional on qualification.
**Scope:** Issues #2–#7. CEF implementation begins in M3.

## Product boundary

Developers write application services and desktop coordination in Bun TypeScript.
Framework maintainers build native infrastructure once per release/target. An
ordinary application build selects prebuilt components; it must not silently
compile native sources when an artifact is missing.

The first differentiation hypothesis is a less disruptive backend edit cycle.
Managed windows, browser sessions, and terminals will eventually have persistent
runtime owners. Replaceable service generations will own handlers, subscriptions,
and disposable work. M1 supplies contracts and resource semantics, not hot reload.

## Package boundaries

`contracts` has no runtime dependencies or host globals. `client` may depend only
on `contracts`. `runtime` owns application resources and may depend on `contracts`.
`artifacts` contains installer-side filesystem/crypto logic. `cli` may use
`artifacts` and `contracts`. Browser code cannot import runtime/native internals,
even through type-only imports or literal dynamic imports. AST checks and a
separate browser-only TypeScript configuration enforce these rules.

Workspace names are private development names, not a claim that npm names are
reserved. Source exports support the monorepo; release exports/declarations are
M8 work.

## Host decision

The leading candidate is a prebuilt native library on the OS main thread with Bun
application code on a Worker. The fallback is a small native executable owning a
Bun subprocess. `native/host-probe` tests real ABI calls, binary input, notification
queues, cross-thread callbacks, timers, cleanup, and process startup without CEF.

The Rust fixture has no third-party crate dependencies. Rust is selected for this
probe because a reproducible standard-library-only implementation is small enough
to audit. It is not a requirement that all future platform shims use Rust.

FFI and Node-API are both tested. Node-API is implemented by Bun; it does not
require shipping Node. The N-API probe deliberately resolves a small public ABI at
runtime so it needs no Node headers or link-time Node library. This handwritten
adapter is an experiment, not the production binding library. M3 must validate
actual browser initialization, platform loops, sandboxing, and native extension
compatibility before adopting a host model.

Sources: [Bun Node-API](https://bun.com/docs/runtime/node-api),
[Bun FFI](https://bun.com/docs/runtime/ffi),
[Bun Workers](https://bun.com/docs/runtime/workers).

## Resource ownership

The registry issues opaque frozen objects and retains data only for live resources.
The public ID is diagnostic information, not authorization. Copied IDs, forged
objects, wrong-kind handles, and handles from another registry are rejected.
Disposed identities remain tombstoned only while callers retain them (WeakMap),
so lifecycle checks do not create a permanent tombstone leak.

A view belongs to one window and one session. Closing a window disposes its views.
A referenced session cannot be disposed. Backend disposal releases windows,
views, sessions, and event subscriptions. App startup rolls back created resources
on failure. Actual native adapters must preserve these observable semantics.

The planned reload manager will separate stable resource ownership from service
callbacks; it will not preserve arbitrary closures, native addons, synchronous
hangs, or irreversible external effects. See #28–#33.

## Trust boundary

Trusted application views declare an exact origin. Navigation to a different
origin revokes the grant; navigating back does not implicitly restore it.
Custom `app:` origins must be compared explicitly, not as the opaque URL origin
string `null`. Remote views never become privileged merely because an agent
controls them.

M1's mock proves state transitions only. It does not authenticate real renderer
messages, isolate hostile JavaScript, or implement a secure preload. Those are
M4's native-bound authority requirements. Future IPC must bind view, frame,
document generation, session, and capabilities at the trusted native boundary.
A frontend-provided descriptor or resource ID is not such a binding.

## Browser independence

The portable contract covers windows/views/sessions, navigation, explicit
permissions, downloads, snapshots, supported evaluation, and input. Capabilities
are negotiated, unsupported calls fail, and engine extensions have an explicit
namespace. No CEF objects or raw CDP targets appear in application handles.

The mock supports lifecycle/navigation/ephemeral sessions only. CEF is backend one.
WebView2, WKWebView, and WebKitGTK are later adapters, not silent runtime fallbacks.
A future system-webview build must include no hidden CEF payload or download.

## Artifact boundary

Artifacts have exact identities: kind, version, ABI, backend, OS/CPU, Bun version,
native toolchain, and CEF version where applicable. M1 deliberately accepts only
`host-probe`/`backend:none`; this cannot masquerade as a shipping desktop runtime.

A manifest is verified with a caller-provided trusted Ed25519 key before archive
bytes are fetched. The signature covers exact payload bytes. A remote checksum is
not treated as a trust root. HTTPS origins are explicitly allowed, redirects are
bounded and revalidated, payload sizes are bounded, and every cached file is
checked against the signed inventory on reuse.

The initial archive profile is restricted USTAR: regular files and directories,
no links, PAX, sparse files, devices, or compressed archives, at most 64 MiB. It is
for small native probes, not CEF acquisition. Extraction uses a new private
staging directory, known manifest modes, exclusive file creation, and atomic
rename. Failed operations clean their staging and lock. A stale lock after process
crash times out rather than risk deleting another writer's lock; inspect/remove
it only after confirming no writer is active. Hard crash/power-loss recovery and
general release archives require additional M3/M8 work.

The cache assumes a private per-user directory. It rejects observed symlinks but
is not a defense against a hostile same-user process racing filesystem changes.
Production key distribution/rotation and update rollback are not implemented by
an ephemeral CI fixture key. See #16 and #42.

## Performance and evidence

Measure cold install, warm launch, edit-to-usable, app build, signing, installer
compression, startup-to-usable, interaction tail latency, process-tree memory,
idle activity, installed bytes, download bytes, and caches separately. Match
browser versions, sandbox settings, frontend assets, and workload correctness.

Provisional goals: roughly 2x better warmed backend iteration or elimination of
disruptive relaunches; no unexplained material startup/memory regression (initial
review threshold around 10%); bounded, lossless required streams. These are
hypotheses to calibrate in M2, not M1 benchmark results. M9 decides continue,
narrow, or stop against Electrobun, not only smaller experimental projects.
