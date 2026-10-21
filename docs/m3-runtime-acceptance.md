# M3 native runtime implementation and acceptance

A supervised Bun backend, prebuilt CEF host, and authenticated complete-runtime cache.

**Status:** Implementation and native macOS qualification in progress; platform-specific results below are not interchangeable.
**Base:** `652b4aa91afb5cd51c364a2e1d9cbb81235481fa` (merged M2 closeout).
**Scope:** Issues #12–#17. No production signing, publication, or Adea migration.

## Native ownership and shutdown

CEF Views owns native windows and child views on its UI thread. A bounded queue carries commands from a single supervised Bun subprocess; dedicated blocking pipe threads do not poll the idle application. Backend exit is monitored independently of pipe EOF, because a surviving child can retain inherited descriptors. POSIX exit observation reserves the backend PID until its process group is stopped and reaped. Windows uses a kill-on-close job and a native process-handle wait. These policies do not promise to recover deliberately escaped/detached processes; broader process supervision is M5.

Window/view creation and close acknowledgements are asynchronous. The native registry rejects invalid ownership and closing handles; the SDK coordinates concurrent disposal and removes callbacks before notifying observers. Navigation is serialized and associated with its own load generation rather than a previous document's aborted load. Same-document fragment navigation is explicitly unsupported rather than reporting a fabricated new document.

Shutdown closes browser views and windows, completes request-context connection cleanup while CEF can still dispatch, then crosses IO and UI barriers before leaving the message loop. The shutdown deadline is an owned native thread, not a delayed CEF task that itself prevents Chromium's queue drain. A deadline, forced backend termination, renderer failure, or incomplete resource registry remains a failure; the smoke verifier requires the final clean host and backend exit records.

On macOS, the ephemeral-only host uses process-local noninteractive Keychain behavior for its lifetime. It grants no access, reads no credential itself, and changes no ACL or trust store. The previous setting is restored after CEF shutdown. This avoids an unattended Chromium credential-consent prompt blocking shutdown. Persistent sessions and app-specific credential storage are not qualified by this decision and remain M4. The renderer and helper process sandboxes remain enabled.

## Resource origin and development boundary

The `app` scheme registers **STANDARD**, **SECURE**, **CORS_ENABLED**, and **FETCH_ENABLED**; it does not bypass CSP or claim service-worker support. Only the `ui` host receives the packaged asset factory. Assets are declared by a digest inventory; path containment, file type, MIME, conditional requests and single-range requests are checked before serving bytes. Hidden paths, source maps, backend configuration, symlink escapes and unlisted files are rejected. Assets load in place from the installation, not by extracting a new app copy on every launch.

M3 allows packaged `app://ui` resources and `about:blank`. An exact `http://127.0.0.1:<port>` origin can be declared in the development runtime configuration, never injected as an implicit environment fallback. Navigation, redirects, child frames and subresources must remain within the allowed policy. Native handlers deny unsolicited permissions, downloads, popups and external protocol execution. No renderer-to-native bridge is installed. Broader remote browsing and authorized capability grants remain M4/M7.

The public fixture checks JavaScript modules, Unicode assets, conditional and range responses, missing/private paths, iframe behavior, and absence of Bun/Node globals. Native fixtures additionally cover resize/focus API calls, multiple child views, queued navigation, closing owners, repeated disposal, handler detachment, and twenty create/close cycles. API invocation is not a claim of manual keyboard, physical DPI, accessibility or hardware-GPU conformance.

## Full-runtime acquisition

The schema-2 `cef-runtime` manifest is separate from the M1 64 MiB probe format. It pins Bun, CEF, Chromium, native ABI, cef-rs commit, target and toolchain, plus every file digest/mode, directory and relative symlink. Ed25519 authentication is checked against caller-supplied trust roots before transport. The resolver accepts explicitly allowed HTTPS origins with bounded redirects and exact compressed/expanded lengths.

Strict USTAR/gzip extraction streams data with bounded buffers. Unknown members, traversal, case aliases, hard links, unsafe permissions, cycles, writes through symlinks and mismatched runtime configuration fail. Valid relative links are created last. All locales and declared notices are retained; separate debug-symbol bundles are excluded explicitly. Full-runtime qualification uses temporary test signing keys and a scoped local TLS certificate, not a production trust-root distribution claim.

Per-artifact kernel locks release on process death. Acquisition stages atomically, cleans abandoned transactions only while owning the lock, validates existing cache contents before reuse, and preserves shared leases during use. Cleanup cannot remove an actively leased entry. Disk capacity accounts for the archive, block-rounded output and an explicit reserve; real ENOSPC aborts without publishing a partial runtime. The private per-user cache is not a security boundary against malicious same-user code racing filesystem mutation. Power-loss durability of directory metadata is not claimed.

Compiler-free commands:

```sh
bun scripts/cef-runtime.ts acquire trusted-policy.json /absolute/private/cache
bun scripts/cef-runtime.ts inspect trusted-policy.json /absolute/private/cache
bun scripts/cef-runtime.ts remove trusted-policy.json /absolute/private/cache
```

The policy supplies the signed envelope, expected identity, explicit public trust roots and allowed origins. `inspect` is offline and verifies bytes; it does not merely check directory existence. Installed applications never download a missing engine or invoke a compiler.

## Contributor and acceptance commands

Native contributor builds use Rust 1.91.0 and the committed CEF Cargo lock. They are distinct from consumer app builds. Set `CEF_PATH` to the contributor download cache and `PYTHON` to the isolated interpreter with the pinned development requirements.

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck:browser
python -m unittest discover -s tests -p '*_test.py'
cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib
cargo +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --all-targets --features packaging -- -D warnings
bun scripts/build-cef-fixture.ts
cargo +1.91.0 build --locked --manifest-path native/cef-host/Cargo.toml --release --features packaging
native/cef-host/target/release/bunly-bundle /absolute/private/bundle
```

The native pre-commit router preserves Foundry's format/lint/type/Python checks and directs Cargo checks to the independent native workspaces. It does not skip hooks or replace validation with no-ops.

macOS acceptance, after copying the prepared resources into the assembled app and local ad-hoc signing:

```sh
bun scripts/qualify-cef-prebuilt.ts /absolute/private/bundle/bunly_host.app
bun scripts/qualify-cef-development.ts /absolute/private/bundle/bunly_host.app
python scripts/qualify-cef-faults.py /absolute/private/bundle/bunly_host.app --bun /absolute/pinned/bun
bun scripts/qualify-cef-acquisition.ts /absolute/private/bundle/bunly_host.app
python scripts/qualify_cef_storage.py --bun /absolute/pinned/bun
```

The last command uses only a disposable 64 MiB volume. It distinguishes a real write-time disk-full failure, low-space rejection before transport, cleaned staging and successful recovery/offline reuse. Its content and transport are synthetic storage fixtures; the separate acquisition runner executes a real full CEF application after authenticated HTTPS acquisition and offline reuse.

## Platform evidence boundary

macOS arm64 execution, Linux x64 execution and Windows x64 execution must each be identified by actual target, OS, display stack and sandbox evidence. Cross-target Rust API/Clippy checks are compile checks, not native runtime acceptance. Container emulation is not native hardware performance. No sandbox-disabling flag, certificate requirement bypass or floating runtime substitution is permitted to make a test pass.

Windows uses CEF's supplied sandbox bootstrap executable loading the application DLL through `RunWinMain`; direct unsandboxed entry is rejected. Linux initially requires an unprivileged user, X11 (including explicitly identified Xwayland) and functioning Chromium sandbox prerequisites. Native Wayland, all Linux distributions, ARM64 Windows, hardware acceleration and physical DPI changes are not inferred from headless or API-level tests.

Final execution identities, results and issue dispositions are recorded after qualification; incomplete platform acceptance must remain open.
