# M4 capability and browser policy

Scoped authorization and browser permission decisions at the native boundary.

**Scope:** Issue #21 policy and actual CEF denial callbacks.
**Status:** Integrated with native document authority; platform qualification is recorded per checkpoint.
**Boundary:** Not an M4 closeout or an implementation of M7 OS adapters.

## Boundary and grant model

The native host owns the current `(view, main frame, document, generation,
origin, session)` scope. Policy scopes use the same browser-owned document and
generation as the merged #19 renderer authority. Renderer IDs, frontend objects,
URLs and claimed origins never create authority.
The private Bun backend API validates the real opaque `ViewHandle`, asks the
host for the exact current scope over the inherited control pipe, and rechecks
the same local document after that asynchronous response. A local navigation
epoch also fences capture and grant races before a native navigation event can arrive. It returns a frozen
opaque capability backed only by a backend-private `WeakMap`; structural copies,
forgeries and tokens from another backend have no authority. Every grant,
browser decision and native check requires that captured capability and sends
all native scope fields back for an exact current-document comparison. There is
no implicit recapture when a delayed prompt completes. It cannot capture or
grant before a ready document or during navigation. Navigation, reload,
redirect, browser replacement, view or window close, quit, and renderer termination revoke grants before entering
CEF. Child frames receive no generic grant.

Application-native grants and browser grants are different types. Native grants
cover filesystem read/write, exact executable plus argument vector, clipboard
read/write, open/save dialogs, exact HTTPS external origins, and bounded download
roots. Browser grants cover camera, microphone, display capture, geolocation,
notifications, clipboard, multiple downloads, and pointer lock, with explicit
`ApplicationPolicy` or `UserDecision` provenance. Unknown capabilities and
unknown CEF bit flags deny. User decisions are single-document, single-session
and single-origin; no persistent grant store is implemented.

Authorization is separate from availability. The policy-only
`authorizeNativeOperation(capturedScope, request)` runs the native gate and returns
`unavailable` for a matching grant without executing an OS action. Adapter
capabilities are discovered separately. The M7 [text clipboard adapter](desktop-services.md)
calls this gate immediately before execution and again before returning its
result. The [window command adapter](window-commands.md) uses the separate
`window-commands` grant for registration, popup opening and each actual native
command callback. That grant authorizes no implicit file, clipboard, process or
external URL action. Other adapters must preserve that boundary. Filesystem grants use relative paths under a canonical root,
reject traversal, prefixes, UNC/device forms, reserved Windows names, alias characters and
symlink/reparse components. Directory inspection is capped at 4,096 entries per
component, input paths at 4,096 bytes and 128 components. Requested relative
components are ASCII-only; this deliberately does not advertise general Unicode
filesystem-operation support. The execution-time adapter must still use platform
handle-relative/no-follow primitives. These checks do not claim to defeat an
arbitrary malicious same-user process racing filesystem changes.

## Navigation and browser callbacks

The shipped packaged default remains `app://ui` plus `about:blank`. Development
allows only one exact configured `http://127.0.0.1:PORT` origin. No remote HTTPS
origin allowlist is wired into per-view navigation/subresource callbacks yet;
that acceptance criterion remains open, and the packaged CSP is not expanded.
Credentials, origin-prefix matches, mixed HTTP, `file:`,
`javascript:`, unknown external schemes and non-loopback HTTP deny.

CEF popup/new-window and open-URL-from-tab callbacks deny. Certificate errors
cancel and deny. Media callbacks require a live native main-frame scope, exact
requesting origin and an explicit browser grant. The generic permission-prompt
callback has no requesting-frame provenance and therefore denies unconditionally,
even when the main document has an origin-matching grant. Downloads remain
denied because the M7 destination adapter is unavailable. Debug endpoints and
unsafe sandbox/security switches remain disabled.

## Threat model

- **Hostile remote frames:** remote pages, redirects and subframes may forge
  resource IDs, origins, generations, sessions, prompt IDs or capability names.
  Native callback provenance and exact current scope are required; child frames
  do not inherit main-frame grants.
- **Privileged preload/renderer compromise:** injected preload code and
  compromised renderer JavaScript are untrusted. No frontend descriptor creates
  a grant, and navigation invalidates old authority before replacement content.
- **Local listeners/transports:** a loopback listener may be occupied, DNS-like
  aliases may resolve locally, or messages may be replayed. Only an exact
  configured numeric loopback fixture origin is navigable; this increment adds
  no listener, transport authentication or session persistence.
- **Plugins and external handlers:** plugin content, popups, unknown schemes,
  protocol handlers and client certificates can escape the renderer boundary.
  Browser/plugin content and external dispatch are denied; no generic system-open
  fallback exists. Third-party code explicitly imported into the trusted Bun
  backend inherits that backend's authority; this policy does not sandbox it or
  establish an untrusted application-plugin runtime.
- **Hostile files and processes:** paths may traverse, exploit prefix confusion,
  aliases or symlinks, while arguments may smuggle shell syntax. Paths are
  relative and component-checked; execution is an exact executable and typed
  argument vector, never a shell string. Same-user TOCTOU remains an OS-adapter
  concern and is stated rather than hidden.
- **Caches, profiles and downloads:** cached browser decisions or files could
  outlive a document/session. This increment persists no grants, and downloads
  are unavailable. Existing private-cache ownership and authenticated artifact
  rules remain unchanged.
- **Debug access:** remote debugging ports/pipes and sandbox/security overrides
  remain rejected. No DevTools endpoint is enabled by this policy.

## Validation and limits

Pure Rust tests exercise forged/cross-session/old-generation authority, exact
captured-scope decoding and native dispatch comparisons, grant
revocation, prompt completion racing navigation/close, path and symlink escape,
argument injection, frameless/same-origin-child permission reuse, unknown
capabilities, generation exhaustion and unavailable adapters. Bun tests exercise
the usable private-pipe API, deferred capture/navigation races, copied and
cross-backend scope rejection, and post-navigation stale-scope denial. They do not establish
OS permissions.

For an already prepared native application, the existing development
qualification now drives real CEF permission/media, popup and download callback
paths, plus a denied external-protocol popup attempt and redirect/subresource
policy:

```sh
bun scripts/qualify-cef-development.ts /absolute/path/to/prepared/app
```

The runner requires native denial events for media, generic permission prompts,
popups and downloads, including a same-origin child prompt after the main
document receives a grant. It also requires zero requests to the forbidden
listener and clean native shutdown. Certificate callback wiring is compiled
against the pinned CEF API and remains fail-closed, but an invalid-certificate
case, direct external-protocol callback evidence and remote-HTTPS redirect policy
have not been executed. OS prompts,
filesystem/process/clipboard/dialog adapters, remote HTTPS browsing, persistent
browser decisions, issue #92 teardown are not
qualified here and remain open.

## Integrated native qualification

The development-origin fixture now requires exact native receipts for media,
frame-unattested generic permission, popup and download denial. It waits for one
backend arming response rather than polling. A main-document geolocation decision
is deliberately configured before a same-origin child requests permission; that
child is still denied. Allowed redirects, forbidden network destinations and
stale policy scopes after navigation are exercised against actual CEF.

Script-only popups can be blocked by Chromium before Bunly's popup handler runs.
The contributor `rpc-qualification` feature therefore includes one fixed native
activation command: it invokes `Runtime.evaluate` with `userGesture` for the
fixture's named button, after validating the captured scope and explicit
loopback development origin. This is not hardware-input qualification. There is
no caller-supplied expression, public debugging port or page-callable test API.
Ordinary host builds exclude the command. The exact popup-denial receipt is still
required; neither a JavaScript `null` result nor an unobserved callback suffices.

The manually dispatched three-platform RPC qualification also runs this policy fixture. The
wrapper requires its exact schema-3 record, zero requests at the forbidden
server, normal process exit and all ordered native teardown phases. Source hashes
and the input artifact are checked across the run. A missing callback, duplicate
record, stale scope, native failure or changed input remains a failed trial.
The native RPC/session fixture remains a separate required regression. The current
qualification schema is 3; the earlier schema-2 checkpoint is retained below.

## Threat-model boundary

Untrusted pages, child frames and stale documents cannot grant themselves native
operations. The inherited application-to-host pipe and application backend remain
trusted; permission provenance identifies which trusted application API supplied
a decision, not an OS-attested proof that a person clicked a prompt. The policy
never uses a page-supplied view identifier as authority. Same-origin code that
controls an already trusted application document shares that document's trust;
this is not an isolated-world defense against application XSS.

Filesystem grants are bounded structural authorization checks, not open file
descriptors or an implementation of the future OS adapter. Same-user filesystem
replacement races must be handled at the actual operation boundary. Unknown
operations and unimplemented adapters cannot report successful execution merely
because a grant matches. Complete remote HTTPS/redirect qualification, secure
persistent credential providers, and the transport decision remain separately
tracked M4 work; this increment does not silently complete them.

## Local implementation checkpoint

The implementation pass ran pinned Bun runtime (version redacted) and Rust 1.91.0 against the existing
CEF 154.0.34 distribution. `check:portable` passed 679 Bun tests and 200 Python
tests; `check:foundation` passed 139 overlapping Bun tests. `check:ci:native`
passed both workspaces, including 93 CEF tests, strict Clippy and release builds.
The contributor probe configuration also passed strict Clippy and native tests.
The focused policy acceptance parser rejects missing or duplicate callback
receipts, fabricated success, forbidden traffic and incomplete native teardown.

The first real CEF callback fixture exposed script-only popup suppression before
Bunly's callback. Native mouse/key experiments did not reliably activate the
window on the local machine and remain failed diagnostic trials. The final fixed
native user-activation fixture completed all four denial callbacks, allowed and
rejected redirect cases, stale-scope rejection and clean ordered teardown. A
separate 11-case native RPC/session regression also passed during integration.
Final committed-source runs and hosted results must be recorded separately; these
implementation observations are not cross-platform qualification by themselves.

The clean implementation checkpoint `db87cc4377755b31a7e3eabd006a8dde929d24b9` passed the final
schema-2 policy qualifier and all 11 macOS RPC/session prebuilt cases. Both runs
retained clean before/after source identities and unchanged input artifacts.
The policy run observed all four denial callbacks, stale-scope rejection, zero
forbidden-origin requests and ordered clean shutdown. The RPC run qualified all
five positive launches and all five helper/clone completions, with six expected
startup rejections. Fresh audits of the root plus three independent Bun locks,
both Cargo locks and Python requirements reported no findings. The
[sanitized checkpoint](../evidence/m4-native-policy-local-2026-10-23.json) preserves
hashes, results and failed preparation/activation experiments. No failed trial was
reclassified as passing; hosted execution remains a separate merge requirement.

## Cross-platform acceptance correction

The initial hosted acceptance at `8cbae969661cae4748a9c8c93dd6a942d113de11`
failed rather than qualifying all targets. Windows exposed signed C enum
constants against an unsigned permission bitmask. The adapter now widens both
representations losslessly to `i64`; zero and every unknown bit remain denied.
An actual Windows-target API check and platform-independent mask regressions
cover the correction; cross-compilation is not Windows execution acceptance.

The Linux and macOS fixture rejected the media request before the native permission
callback. The old page suppressed the capture error, so its exact device/OS reason
was not recorded; requiring physical capture prerequisites made this test unsuitable
for hardware-free runners. The contributor-only
`rpc-qualification` build now enables Chromium's synthetic capture devices only
for the explicitly requested development fixture. The actual Bunly media
permission callback must still deny the request. No fake permission UI,
auto-grant switch, OS permission, sandbox change, or real device access is used.
Ordinary native builds contain neither this device setup nor its diagnostic.
The fixture verifies the native setup receipt and its schema-3 result records
`synthetic-device-real-permission-callback`. Older schema-2 results and missing
media provenance cannot satisfy the new acceptance parser.

The initial hosted macOS RPC run separately missed every short-lived cleanup
helper in its fixed launch matrix. It remains a failed coverage qualification,
not a native RPC failure or a positive helper observation. The existing
same-suite positive helper requirement and every actual cleanup failure check
remain unchanged. A subsequent passing run must retain its own source/artifact
identities and coverage; it cannot erase the original failed run.

The retained hosted failures are run `40006086014` (native execution and Windows
build) and `40006086239` (Windows API check). Local correction runs and final-head
hosted results are separate evidence; neither unsupported M4 capabilities nor
the historical shutdown investigation are resolved by these fixture corrections.

The clean correction checkpoint `eb3abbe8f58613be7311481f390109257f05c4dd`
passed schema-3 native policy qualification and all eleven macOS RPC/session
cases, including five positively verified helper/clone completions. The ordinary
build passed its eleven-case prebuilt suite and rejected the contributor media
fixture requirement. This negative control is an expected backend rejection,
not a clean native-policy qualification. Local validation passed 679 Bun tests,
200 Python tests, 139 overlapping foundation tests, both native workspaces
(3 M1 and 94 default CEF tests), and 95 contributor CEF tests. Fresh advisory
checks reported no findings. The Windows-target API check passed after the
lossless mask correction; actual hosted Windows execution remains separate.

The [correction evidence](../evidence/m4-policy-platform-corrections-2026-10-23.json)
retains the initial hosted failures, the local Python-environment setup failure,
and the bounded-tail negative-report replay limitation. Native source, input
artifacts, and raw reports remain identified by exact hashes. No failed native
trial was reclassified or removed.

## Windows relative-path normalization correction

The next hosted matrix at `02da9d7` completed both native policy and RPC suites
on Linux and macOS. Windows then exposed a separate real validation defect:
`Path::components` split a backslash path before the per-component backslash
check could see it. The original rejection test failed; it was not skipped or
changed to accept that alias. Run `40023786793` preserves that result.

Relative capability requests now validate their raw spelling before any
platform path normalization. They use forward-slash separators on all targets;
backslashes, duplicate separators, dot components, drive/stream syntax, reserved
names, control characters and existing bounded alias rules deny. Absolute trusted
grant roots and executable paths retain their platform-native syntax. Pure raw
validation tests cover the same Windows spellings even on Unix, and real
filesystem tests preserve the containment, case and symlink requirements.
No filesystem adapter or same-user race guarantee is implied by this correction.

Clean checkpoint `f2173716f1a04e5260b3ad736ec1382875680481` passed fresh native
policy qualification, eleven RPC/session cases with five positively verified
helper completions, and the ordinary host's eleven prebuilt cases. The ordinary
host again rejected the contributor-only setup requirement. Portable validation
passed 679 Bun and 200 Python tests; the 139 foundation tests overlap the ordinary
suite. Both native workspaces passed (3 M1 and 95 default CEF tests), as did
96 CEF tests with contributor probes and the Windows-target API check. Native
policy/ordinary binaries, clean source identities, raw reports and the previous
Windows failure remain separately fingerprinted in the correction evidence.
Current-head hosted execution is still required before merging this correction.

## Session-origin follow-up

The subsequent network increment adds explicit per-session origins and real CEF
cross-origin, worker, certificate and revocation qualification. See
[M4 session network policy](m4-network-policy.md) for the API, acceptance evidence
and limitations. Earlier checkpoint statements above describe those earlier
restricted builds, not the new optional session configuration. Network permission
never creates native RPC or browser-permission grants.
