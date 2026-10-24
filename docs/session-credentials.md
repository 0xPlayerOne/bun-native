# Protected persistent cookies

An explicit OS-provider policy, verified before application cookie profiles open.

**Status:** Implementation under qualification; not an enabled-by-default capability.
**Scope:** Issue #20. Synthetic proof tests are not OS-provider or release acceptance.

## Application contract

Persistent sessions keep cookies disabled unless `persistentCookies: 'os-protected'`
is requested. The backend must advertise `session.protected-cookies`, and the
installed native runtime must separately declare `credential_policy` with a stable
`applicationId` and a platform-matching provider. Missing configuration, unavailable
protection or verification failure rejects the request; there is no plaintext or
basic-store fallback. No renderer can supply provider policy or access the proof
context. Trusted application backend code remains outside the hostile-renderer
boundary, as in the existing capability model.

Provider values are `macos-keychain`, `windows-dpapi`, and
`linux-secret-service`. macOS configures CEF 156's service name as
`Bunly APPLICATION_ID Safe Storage` and its account name as `APPLICATION_ID`.
Windows relies on the root's DPAPI-wrapped key; this is user-level protection, not
Chrome's separate privileged app-bound encryption service. Linux must explicitly
acknowledge `sharedKeyScope: 'chromium-user-shared'`: the pinned Secret Service
provider shares Chromium's user key identity. It is not per-application OS-key
isolation. Native code selects the Secret Service backend; a fallback fails proof.

The private root binds its policy before CEF initialization. Protected application
profile markers refuse a changed identity/provider or reopening with cookies
disabled. Existing unqualified profile contents are not migrated or overwritten
implicitly. Key identity changes require a new owned root or a separately designed
migration. Per-profile reset deliberately preserves the root policy binding and
the OS key; it is not an identity migration. The internal proof partition is
reserved and cannot be erased through the application-profile reset API. Ordinary origin storage is not claimed
to be encrypted merely because cookies are.

## Admission and lifecycle

A single hidden, native-owned request context writes a random, nonsecret canary
cookie for an unreachable `.invalid` origin. The context has no renderer/view and
is denied by ordinary session/view operations. Native callbacks require the exact
cookie's readback and actual flush completion. A ready proof on restart must be
read rather than overwritten; losing its encryption key cannot manufacture a new
success. The trusted Bun runtime then opens only this bounded canary SQLite file
read-only and validates schema, owner, row identity, empty plaintext, ciphertext
layout and selected provider. It never reads an application's cookie database or
an OS secret. Windows additionally requires the pinned DPAPI key envelope.

AES-CBC version tags alone are insufficient: known basic/empty/mock encryption
keys are rejected by comparing the entire decrypted canary. Synthetic random
ciphertexts test parser behavior only and cannot qualify an OS provider. The
native host admits protected application contexts only after its callback proof
and the trusted-runtime receipt both complete. Concurrent creation coalesces to
one attempt; failure is retained for the backend lifetime, not retried until a
lucky pass. Initialization, disposal and shutdown remain native-owned and bounded
by the existing request/watchdog model.

The proof context is retained for the host lifetime and counted independently in
native diagnostics. Normal application operations cannot dispose it. It is closed
through the existing context/connection teardown during host shutdown. There is
no extra runtime process, polling service, external debug port or native compiler
invocation in this path.

## Qualification boundary

Actual provider tests belong on disposable GitHub-hosted runners, with synthetic
cookies, an isolated temporary macOS keychain or Linux Secret Service, and the
existing Windows standard-user worker. Developer/personal keychains and real
accounts must not be accessed to qualify this feature. Restart persistence,
profile separation, explicit clear/flush, changed identities and unavailable
providers must be exercised before this increment is considered complete.

## Pinned upstream references

The implementation follows CEF 156.0.7 / Chromium 156.0.8078.17 behavior:

- `chromiumembedded/cef`'s application-specific Keychain settings (CEF PR #4247).
- `net/extras/sqlite/sqlite_persistent_cookie_store.cc`: schema 24 includes a domain
  SHA-256 prefix, clears the plaintext column when encryption succeeds, and skips
  commits when encryption fails.
- `components/os_crypt/async/browser/keychain_key_provider.mm`,
  `dpapi_key_provider.cc`, `freedesktop_secret_key_provider.cc`, and
  `posix_key_provider.cc`: platform keys, tags and fallback boundaries.
- `crypto/apple/fake_keychain_v2.mm` and
  `components/os_crypt/async/common/encryptor.cc`: fixed mock/legacy keys.

These are policy and format references, not substitute native execution evidence.

## Enumeration completion and diagnostics

CEF's pinned cookie implementation sends `GetCookieList` and `FlushCookieStore`
as separate asynchronous operations. A flush callback is not proof that an earlier
cookie enumeration reply has arrived. Both the canary and ordinary cookie reads
now wait until CEF releases the final visitor reference before scheduling the
flush. This also completes empty enumerations without interpreting an absent
visitor invocation as a successful read. Failed registration does not arm the
completion; the existing request/shutdown deadlines still bound missing callbacks.

Admission errors identify a fixed verification stage, never underlying SQLite/OS
errors, private paths, cookie values or provider secrets. The original Linux
restart admission failure and Windows initial admission failure remain retained
until current-head hosted execution establishes the corrected behavior. No
personal credential store is used for local validation.
