# M4 session network policy

Explicit origins and remote-document authority in the native CEF adapter.

**Scope:** Issues #19 and #21; session-bound navigation and HTTP resource handling.
**Status:** Implemented; acceptance is recorded per exact source/platform checkpoint.
**Boundary:** Not a network firewall, a persistent-credential implementation or full M4 closeout.

## Portable configuration

`SessionOptions.network` is optional. Absent configuration preserves local-only
packaged behavior (`app://ui` and `about:blank`) and the existing explicitly
configured development origin. An explicitly configured session can opt into
at most 32 unique, canonical origins:

```ts
const session = await backend.createSession({
  persistence: 'ephemeral',
  partition: 'preview',
  network: { allowedOrigins: ['https://example.com'] },
})
```

Origins must be exact HTTPS origins, or exact `http://127.0.0.1:PORT` origins
with a non-default nonzero port for intentionally permitted local services.
Wildcards, credentials, URL paths, fragments, queries, aliases, duplicate origins,
noncanonical/default ports, arbitrary HTTP hosts and oversized inputs reject.
Each origin is limited to 256 bytes natively. The backend copies and freezes
configuration before the asynchronous native call. An unsupported adapter must
reject `session.network-policy`, not silently ignore the option.

Network access is not application authority. CEF application RPC remains limited
to explicitly trusted `app://ui` main documents. Creating a network-origin view
with application trust rejects natively even when its network origin is allowed.
Navigating a trusted view to a remote page revokes its in-flight RPC and native
policy scope. Returning to the application URL does not restore that authority.

## Native enforcement

Each CEF request context owns an immutable `Arc<NetworkPolicy>`. The same object
is retained by that session's browser request handlers and request-context
handler. UI-thread navigation and IO-thread HTTP resource callbacks therefore
share the same explicit origin list without accessing the UI registry from IO.
Context-level handling covers service-worker requests without a browser/frame.
No global last-selected session or frontend-provided session identifier decides
which policy applies.

Every navigation and resource request validates its current destination.
Resource redirects revalidate the new URL before CEF follows it; a forbidden
redirect is rewritten to a deliberately unsupported scheme so that it fails,
not to a successful empty document. Packaged assets still use the bounded
full-file-verification path. HTTP requests have no reusable packaged asset plan.
Session disposal atomically retires the policy; retained callbacks cannot use an
old context's origin list after retirement. Existing connection shutdown/flush
ownership is unchanged. Already-transmitted requests cannot be recalled.

CEF certificate-error handling remains fail-closed. The network allowlist grants
neither a certificate exception nor native browser permissions. There is no
certificate override, CA installation, trust-store mutation, public debugging
endpoint, proxy substitution or changed sandbox setting in the qualifier.

## Scope limits

This is a navigation and CEF HTTP-resource policy, **not complete network egress
isolation**. WebSocket, WebRTC and other channels not represented by the pinned
CEF resource callbacks are outside this API. Remote browsing must not be treated
as an OS/network sandbox. Browser origin rules and native RPC authority remain
separate protections. Arbitrary code deliberately loaded into the trusted Bun
backend is also outside the hostile-renderer threat boundary.

The application CSP is unchanged and remains restrictive. Allowing an HTTPS
origin in a session does not automatically authorize a packaged application's
scripts to fetch it through CSP, or inject native access into a remote document.
Full persistent credentials, HTML5 clearing and paired transport selection remain
separate M4 requirements. The known intermittent shutdown investigation is not
resolved by a successful network workload.

## Maintained qualification

```sh
bun run qualify:cef-network -- /absolute/path/to/prepared-native-app
```

The command uses an ordinary packaged configuration without the development-origin
fallback. It runs three independent private HTTP origins and an ephemeral,
untrusted TLS endpoint. Controlled assertions cover default denial, per-session
isolation, allowed subresources, denied resource and navigation redirects,
actual cross-origin hostile frames, worker-originated fetch denial, native
certificate denial, navigation-start RPC cancellation, return-to-origin denial,
and convergent resources/listeners. Denied frame navigation requires an actual
native denial receipt rather than a DOM load/error event that CEF cancellation
need not deliver to the parent page.

A separate navigation to `https://example.com/` requires a successful ordinary
HTTPS load and no native RPC binding. This check requires public network/DNS/CA
availability; an unavailable endpoint is a failed environmental qualification,
not an excuse to bypass TLS or invent a passing sample. No production account or
credential is used. Controlled cross-origin assertions remain on local fixtures.

The parent observes server request counts independently. Any forbidden-origin,
wrong-session or untrusted-TLS application request fails the suite. Native
success must include the exact versioned case list, normal backend exit and the
complete ordered teardown sequence. Generic smoke success cannot substitute.
Raw reports are written on failures, input artifacts are unchanged, and generated
TLS keys stay inside the private run directory, outside Git and hosted exports.
The manually dispatched three-platform RPC qualification also runs this network suite.

## Upstream interfaces

The implementation uses the pinned CEF request-context/resource-request handlers,
including context-level callbacks for service-worker requests and
`OnResourceRedirect`'s mutable destination. API references are the installed
`include/cef_request_context_handler.h` and
`include/cef_resource_request_handler.h` from the exact retained CEF distribution.
No upstream implementation code was copied. Current online references:
[request context handler](https://cef-builds.spotifycdn.com/docs/154.0/classCefRequestContextHandler.html)
and [resource request handler](https://cef-builds.spotifycdn.com/docs/154.0/classCefResourceRequestHandler.html).

## Local implementation acceptance

Committed implementation `d9d2f3ae52f16493ac48375216ec86721961a05d` passed the
real network, RPC/session and browser-policy qualifiers on macOS arm64 with
Bun (version redacted) and the existing CEF 154.0.34 distribution. The network suite recorded
two hostile cross-origin frames, two service-worker runs, four allowed data
requests, and zero forbidden, wrong-session or untrusted-TLS application requests.
Ordinary public HTTPS navigation and exact native certificate-denial evidence
also passed. Source identities and input artifacts remained unchanged.

Local validation passed 684 Bun tests and 200 Python tests, 139 overlapping
foundation tests, 3 M1 tests, 98 default CEF tests and 99 contributor CEF tests.
Windows API compilation passed, but actual hosted Windows/Linux execution remains
required. The three early fixture failures are retained, not counted as passes:
waiting for a DOM event after native cancellation, disposing sessions after
last-window shutdown, and counting the fixture's own observer as a resource leak.
The corrected fixture requires native denial receipts, preserves shutdown order,
and removes its own observer before checking resource convergence.

The independent Electron benchmark audit found GHSA-jr5w-w6x2-84p9 on the unchanged
base pin. Its separate remediation is PR #99; this initial checkpoint is not a
clean all-dependency audit. Other completed Bun locks, both Cargo locks and Python
requirements reported no findings. See the
[sanitized evidence](../evidence/m4-network-local-2026-10-23.json) for exact
checkpoints, artifact/report hashes, failed trials and qualification limits.

PR #99's benchmark-only security fix was integrated as clean checkpoint
`71e088b0a0b09f90d90921d308c3374fbcc75ed2`. Native sources remain identical to the
qualified implementation. Full portable validation then passed 685 Bun and 200
Python tests; the independent Electron 44.9.3 audit completed with no findings.
Fresh native network and 11-case RPC/session runs passed again with clean source,
unchanged artifacts and five verified helper completions. The initial advisory
failure remains in the evidence; the integration does not erase it. Hosted
qualification must still execute this final integrated tree before merge.
