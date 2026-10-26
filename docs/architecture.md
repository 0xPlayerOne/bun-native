# Bunly architecture

A stable desktop host with replaceable Bun application behavior.

**Status:** M1–M3 are complete for their declared acceptance profiles. M4 delivery and its final-head merge gate are recorded in [M4 completion](m4-completion.md); [M5 completion](m5-completion.md) records native stream/terminal/service integration and measured load; production release qualification remains separate.
**Scope:** Accepted host architecture and boundaries. See [M3 completion](m3-completion.md) for native platform evidence and limitations.

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

The accepted baseline is a prebuilt Rust GUI/main-thread owner with **one supervised
Bun 1.4.3 subprocess** for application TypeScript. This formalizes the initial CEF
host's existing arrangement, without introducing a Tauri dependency or native
compilation into application builds. Bounded asynchronous IPC keeps native
operations on their owner thread. Host resources and service handlers have
separate lifetimes; managed reconnection/reload still requires M6 implementation.

Node-API/Worker and C-ABI/FFI/Worker modes remain qualified feasibility alternatives.
The tests stop native dispatch before destroying callback owners; neither a
Worker nor an ABI makes native-memory corruption recoverable inside that address
space. We do not select the smallest process count or claim a performance win
from the fixture. See [ADR 0002](decisions/0002-host-qualification.md) and the
[measured closeout](m1-completion.md) for costs, fault boundaries and revisit gates.

M1 has actual Linux/macOS idle counters and all-target functional/resource data.
Windows wakeup measurement is explicitly unsupported, not zero; its controlled
performance/power claims remain gated by #9/#22. M3 owns actual browser/platform
support; the architecture decision does not certify production sandbox or helper
shutdown. The native core uses Rust, but platform shims need not share its language.

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

M1's mock proves state transitions only. The merged CEF implementation binds
renderer messages to native-known view, frame, document generation, exact origin
and session, with capability-gated Bun handlers. It revokes authority on navigation
and close; returning to the original origin does not regrant it. This is not an
isolated-world defense against XSS in a trusted application document. A
frontend-provided descriptor or resource ID is never such a binding.

The M5 native binary adapter reuses that exact document binding while keeping
independent RPC and stream subscriptions, sequences and one-packet admission.
Its frozen renderer closure authenticates the actual current and entered V8
context; the existing lossless stream protocol retains consumer acknowledgment
above native handoff. See [native CEF streams](native-streams.md).

The issue #21 policy increment keeps application-native capabilities separate
from browser/user permissions and binds both to the current native host registry,
main-frame callback, generation, origin and session through a captured opaque
policy scope. The host returns that scope only for a ready document; the backend
revalidates its local document after the asynchronous capture, and every later
private-pipe grant or check must exactly match all native scope fields. Document
identity comes from the merged issue #19 native authority, not a provisional token. Navigation start and close revoke the scope.
It is an authorization gate for future OS adapters, not an implementation of
filesystem, process, clipboard, dialog or download APIs; see
[M4 capability policy](m4-capability-policy.md).

## Browser independence

The portable contract covers windows/views/sessions, navigation, explicit
permissions, downloads, snapshots, supported evaluation, and input. Capabilities
are negotiated, unsupported calls fail, and engine extensions have an explicit
namespace. No CEF objects or raw CDP targets appear in application handles.

The mock supports lifecycle/navigation/ephemeral sessions only. CEF is backend one
and additionally implements explicit persistent sessions, cookie CRUD, HTTP-cache
clearing and flush. Complete profile clearing is an explicitly confirmed offline
operation, not a selective live HTML5 clear. Persistent cookies remain disabled by
default and require opt-in OS-provider policy plus native/persisted proof before
admission; see [M4 browser sessions](m4-browser-sessions.md) and
[protected persistent cookies](session-credentials.md).
WebView2, WKWebView, and WebKitGTK are later adapters, not silent runtime fallbacks.
A future system-webview build must include no hidden CEF payload or download.

## Session network policy

CEF sessions optionally declare exact HTTPS or numeric-loopback HTTP origins.
The immutable native context policy applies to navigation, redirects, browser
resources and context-level worker requests. Defaults remain local-only.
Network access never grants an application bridge, and navigation revokes old
authority before remote content is admitted. This is not a WebSocket/WebRTC or
OS-level network firewall; see [M4 network policy](m4-network-policy.md).

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
it only after confirming no writer is active. The M3 CEF cache is a separate authenticated full-runtime path with archive
containment, exclusive staging, leases, corruption checks and offline reuse; see
[M3 runtime acceptance](m3-runtime-acceptance.md). Production update recovery
and power-loss guarantees remain M8 work.

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
hypotheses, not measured Bunly advantages. M2 supplies local baselines and
measurement infrastructure; quiet controlled calibration remains M9 work. M9 decides continue,
narrow, or stop against Electrobun, not only smaller experimental projects.
