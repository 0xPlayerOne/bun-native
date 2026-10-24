# M4 browser sessions (issue #20)

Persistent and ephemeral browser sessions are explicit request-context owners. This
increment implements the issue #20 session path; it does not implement renderer
authority and does not resolve the separate teardown issue #92.

## Portable surface

`SessionOptions` always names a validated partition. Ephemeral sessions reject a
profile root. Persistent sessions require an absolute `persistentRoot`, and the
packaged native process must have started with the exact same
`BUNLY_PROFILE_ROOT`. There is no implicit persistent directory and no conversion
of a temporary ephemeral profile into durable storage.

The CEF backend advertises persistent sessions, portable cookie CRUD, HTTP-cache
clearing, and explicit flush. Cookie enumeration is limited to 128 records and a
48 KiB encoded result. Cookie fields and URLs are bounded and validated before
native dispatch. Complete HTML5 storage clearing is represented by the separate
`session.storage-clear` capability, which CEF does not advertise because pinned
CEF 154 has no public request-context API for that operation.

## Native ownership and paths

Every ephemeral session receives a distinct in-memory CEF request context. Views
share cookies and storage only when they use the same session handle.

A persistent session maps to
`<BUNLY_PROFILE_ROOT>/bunly-profile-<SHA256(partition)>`. The native host requires a normalized,
private, current-user-owned root with Bunly marker metadata. It rejects traversal,
symbolic links, corrupt or mismatched markers, unrecognized nonempty profiles, and
an in-use root/profile lock. Immediate child directories match CEF 154 Chrome runtime requirements; nested paths can silently fall back to off-the-record profiles. Partition hashes prevent case-insensitive and reserved-name aliases. At most 128 distinct profiles are retained per host lifetime, and reopening a disposed partition reuses its lock. Locks are kernel-released after a crash and are retained by
the stable host until after `cef_shutdown`; disposal never deletes a persistent,
live, or unknown profile. CEF's process singleton additionally rejects simultaneous
application instances using the same `root_cache_path`.

Session operations are serialized per context. Disposal first flushes the cookie
store, clears scheme factories, asynchronously closes connections, and retains the
request context and profile lock until CEF acknowledges completion. Whole-host
shutdown waits for active session operations and applies the same flush/close path.
Existing shutdown deadlines remain active and failures stay failures.

## macOS credential boundary

The pinned CEF source exposes no supported setting for an application-specific
macOS Keychain credential identity. Bunly keeps the M3 process-local,
noninteractive Keychain policy, does not create or modify Keychain entries, and
does not select Chromium's mock/plaintext fallback. Persistent request contexts on
macOS therefore disable cookieable schemes and cookie operations fail explicitly.
Persistent localStorage remains supported through the context cache path. This is
not qualification of encrypted persistent cookies.

## Prepared real-native fixture

Build the session application resources with the pinned Bun and build/package the
native host through the existing contributor flow:

```sh
PATH=/absolute/pinned/bun-directory:$PATH \
  bun scripts/build-cef-fixture.ts --application=sessions

bun scripts/qualify-cef-sessions.ts /absolute/path/to/prepared-native-fixture
```

The qualifier uses only private `.bunly/m4-sessions/run-*` profiles. It executes
same-session sharing, cross-session isolation, ephemeral replacement, persistent
restart, cookie CRUD, HTTP-cache clearing, simultaneous-root rejection, graceful
lock release, forced interrupted shutdown and restart, corrupt-root rejection, and
symbolic-link rejection. It retains a JSON report and every failure. A portable
test or `cef/dox` compile is not native acceptance; the report qualifies only the
actual target and fixture it records.

Each process launch writes bounded stdout, stderr, and result metadata into its
private run directory before any assertion is evaluated. Consequently an early
native abort still leaves reviewable evidence even though `report.json` is only
created after every trial passes.

On macOS, the cookie trial covers ephemeral in-memory cookies and the persistent
trial verifies the explicit unsupported diagnostic. Windows and Linux require
their own native executions. Storage-clear remains unsupported, and issue #92
remains independently open.

The layout follows the pinned CEF 8037 `ChromeBrowserContext::InitializeAsync` immediate-parent check. The earlier nested-directory fixture failed its real restart assertion and remains retained as failed evidence.

## Qualified path and completion invariants

Session creation resolves only after CEF's request-context-initialized callback,
validated against the exact native context and deferred to the UI owner thread.
The real persistent fixture exposed the previous early-resolution failure; no
sleep, retry, or enlarged deadline substitutes for initialization.

The maintained runner uses the existing process-tree observer and ordered
shutdown parser. Normal launches require verified helper/clone completion.
Root-lock/path rejections and controlled interruption are separately labeled
negative controls, not successful shutdowns. All outcomes are written even when
an assertion fails, and the supplied native application remains byte-unchanged.
Case-distinct persistent partitions and independent ephemeral cookie stores are
exercised by actual CEF, not only contract mocks. Full HTML5 clearing and secure
persistent cookie providers remain explicitly unsupported.

## Local execution checkpoint

The [sanitized local record](../evidence/m4-sessions-local-2026-10-23.json) preserves ten native functional/negative-control cases at clean source `d6dad359502e0f57bc0dd72c6ea9fc671e2ddce5`, including separate failed nested-profile and early-initialization trials. Secure persistent cookie providers and full HTML5 storage clearing remain open acceptance work under issue #20.

After rebasing on merged #94, 652 Bun tests and 199 Python tests passed. Two fresh native qualification attempts completed their ephemeral session assertions but hit the previously tracked CEF teardown watchdog (#92); both full runs failed and their outcomes are retained in the local evidence record. The native source tree is identical to the earlier ten-case checkpoint. Neither the old pass nor hosted smoke supersedes these later failures.

Windows roots must use an ordinary local drive path. UNC/device namespaces, alternate streams, reserved device names, trailing-dot/space aliases, and reparse-point ancestors are rejected before profile creation. The actual Windows API check exposed a missing `Win32_System_IO` feature for LockFileEx; this is corrected without changing dependency versions. POSIX mode checks are not presented as Windows ACL qualification.

## Credential-provider prerequisite upgrade

The framework contributor dependency now targets released cef-rs
`a46b48c6221f99414a5c6b37ff86491772f9b0a2`, CEF 156.0.7 / Chromium 156.0.8078.17.
This release includes application-specific macOS Keychain service/account fields
from upstream CEF PR #4247. The prior CEF 154 qualification remains historical;
its absence of these fields is not a statement about the newer engine.

The upgrade alone does not enable persistent cookies, access a Keychain item,
relax the noninteractive policy or claim that encrypted storage is qualified.
Real per-platform cookie persistence, provider failure and application-identity
qualification must accompany any later enablement. Full HTML5 clearing remains
a separate API/lifecycle concern; no new complete request-context storage-clear
API is assumed merely from a version change.

### CEF 156 integrated local checkpoint

Clean integrated source `bf8e5eed67704d5b729a23727d58dd33e184b316` passed 704 Bun
and 205 Python tests, both native workspaces (3 M1 and 99 default CEF tests),
and 104 contributor CEF tests with strict Clippy and real builds. The actual
loaded framework reports CEF 156.0.7 / Chromium 156.0.8078.17; its binary identity
probe does not attest the sandbox merely from compilation or a version string.

Real macOS execution passed both CEF transport candidates, the 11-case adversarial
RPC/session matrix, remote-network/redirect/certificate and permission-policy
fixtures, the ordinary 11-case prebuilt matrix, twelve concurrent-asset foundation
launches, and the ten-case session restart/locking/interruption matrix. The
interrupted session remains an expected unclean negative control, not clean
shutdown evidence. Inputs and harness source identities remained unchanged.

The [sanitized runtime-upgrade record](../evidence/m4-cef156-prerequisite-local.json)
preserves report fingerprints, counters, initial historical-replay failures and
the locally rejected hosted-only preparation command. The guard was not bypassed;
a fresh local contributor bundle was assembled instead. The current hosted matrix
must qualify its own exact final head before merge. CEF 154 historical reports and
transport timing distributions are not relabeled as CEF 156 measurements.

## Complete offline profile reset

[Complete session storage reset](session-storage-reset.md) adds an explicit
runtime-only operation that removes every store in one stopped persistent profile
under the native root/profile locks. It does not mislabel partial first-party
clearing as complete HTML5 clearing or delete databases still owned by CEF. Live
`clearSession({storage:true})` remains unsupported; callers must explicitly confirm
whole-profile offline deletion. Recovery intent fences interrupted deletion until
the same explicit reset completes. Other partitions and OS credential keys remain.
The maintained native fixture verifies actual localStorage, IndexedDB, CacheStorage
and service-worker persistence, live-lock rejection, interruption and selective
profile reset. Credential-provider qualification remains a separate M4 concern.
