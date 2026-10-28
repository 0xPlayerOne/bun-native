# M3 native runtime implementation and acceptance

A supervised Bun backend, prebuilt CEF host, and authenticated complete-runtime cache.

**Status:** macOS and shared-runtime acceptance complete; Windows and Linux native acceptance remain open. Platform results below are not interchangeable.
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

Native contributor builds use Rust 1.91.0 and the committed CEF Cargo lock. They are distinct from consumer app builds. Local Cargo commands use the shared per-user Bunly target cache, and CEF builds default `CEF_PATH` to the versioned CEF subdirectory under that cache. Put the matching contributor distribution there or set `CEF_PATH` to override the location. Set `PYTHON` to the isolated interpreter with the pinned development requirements.

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck:browser
python -m unittest discover -s tests -p '*_test.py'
bun scripts/cargo.ts +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib
bun scripts/cargo.ts +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --all-targets --features packaging -- -D warnings
bun scripts/build-cef-fixture.ts
bun scripts/cargo.ts +1.91.0 build --locked --manifest-path native/cef-host/Cargo.toml --release --features packaging
bun scripts/cargo.ts +1.91.0 run --locked --manifest-path native/cef-host/Cargo.toml --features packaging --release --bin bunly-bundle -- /absolute/private/bundle
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

## Executed macOS acceptance

The final native matrix executed from clean commit `925aadf3c37ff41dbd8d26aeec5738795743a32e` on macOS arm64. The actual CEF library exports report **CEF 154.0.34 / Chromium 154.0.8037.98**, commit 3633; the application embeds Bun **1.4.3**. Local ad-hoc signatures were independently verified; no Apple Developer account or distribution certificate was used.

- **11 packaged trials passed:** three ordinary installed launches, last-window shutdown, three rejected unsafe switches, wrong runtime version, absent Bun, absent renderer helper, and a restored-installation launch. All positive runs use an unrelated working directory and an empty compiler PATH. The source prebuild remained unchanged.
- **120 actual create/close cycles** were exercised across the five positive packaged runs and the acquired offline runtime. Multiple windows/views, concurrent closure, navigation generation, callback detachment, Bun timer responsiveness and final resource counts were verified.
- **Four fault cases passed:** actual backend exit, backend exit with a child retaining its pipe, injected renderer termination and GPU recovery. Expected failures exit nonzero with explicit host acknowledgement; GPU recovery exits cleanly. No timeout, observed orphan or cleanup survivor passed acceptance.
- **Explicit development-origin policy passed:** allowed resources and redirects remain functional, while the forbidden server received **zero** requests from redirected requests, subframes, scripts or fetches.
- **Full-size acquisition passed:** 183,752,621 compressed bytes, 421,647,872 expanded tar bytes, 530 declared members, one HTTPS download, unchanged offline cache inode, no-compiler offline native launch, active-lease cleanup refusal, corrupted-cache rejection and explicit removal.
- **Real disk-full recovery passed:** a separately mounted 64 MiB filesystem reached actual ENOSPC after the capacity preflight. Partial extraction never became reusable; staging was cleaned, insufficient capacity then rejected before transport, and acquisition plus offline reuse succeeded after removing the test filler. The disposable volume detached successfully.

The bundled native helpers requested and entered their CEF sandbox bootstrap. Recorded renderer and GPU samples in the final positive packaged runs report Seatbelt presence. Utility-process startup samples include negative states and remain visible; sampling is not a continuous security guarantee or an assertion that every helper has an identical sandbox policy.

`evidence/m3-macos` retains six compressed report collections, their original/redacted/stored hashes, and all 44 changed execution-source file hashes/Git blobs. Private paths and ephemeral fixture tokens are redacted, not outcomes. Reproduce the acceptance summary with:

```sh
python scripts/report_m3_acceptance.py
```

The verifier rejects incomplete/duplicate trials, missing clean shutdown, forced exit, unobserved faults, incomplete offline acquisition and failed disposable-volume cleanup. The native reports explicitly do **not** claim Windows or Linux runtime acceptance.

## Historical platform disposition at PR #78

The Linux limitation below records that earlier execution environment. Current
Linux acceptance and the still-open Windows boundary are documented in
[M3 native platform acceptance](m3-native-platform-acceptance.md); the failed
container result is not discarded or relabeled.

**#12, #15, #16 and #17:** implementation and declared macOS/shared-runtime acceptance are supplied. They can close when this PR lands. This does not introduce persistent sessions, a renderer-native authority bridge, native PTYs, production signing or release publication.

**#13 / Windows:** the current source passes Windows x64 API/Clippy checks with CEF's `dox` feature. That does not link/run the Windows bootstrap or execute job/process/sandbox behavior. No Windows machine was connected, so current native execution, DPI/input and prebuilt consumption remain open.

**#14 / Linux:** the current source builds an actual Linux x64 CEF executable under Debian 12, running through Docker x64 emulation on the ARM64 Mac. The isolated Xvfb launch ran as an unprivileged user with sandboxing enabled. The first launch identified missing root-owned 4755 sandbox-helper configuration; after supplying that documented prerequisite inside the private container, Chromium still aborted because the container denied namespace creation (`Operation not permitted`). No `--no-sandbox`, privileged container, extra capabilities or disabled seccomp policy was used. This is recorded as failed runtime qualification, not a passing browser test. A Linux environment supporting CEF's namespace sandbox and the declared display stack is still needed; native Wayland and hardware-GPU support are not inferred.

The Linux source snapshot predates formatting-only fixture changes in the committed matrix; native Rust source identities are recorded separately. Existing historical Windows/Linux smoke evidence is not relabeled as testing this new implementation. **M3 remains open until its two platform issues meet their native acceptance.**

## Final complete-checkout validation

The final tree passes 441 TypeScript tests (6,483 assertions across 47 files), strict typechecking, Oxlint, browser-only typechecking, AST boundaries and compiler-free SDK builds; 114 Python tests; 38 macOS native Rust tests; and the native packaging Clippy/fmt checks. Linux x64 compilation and its 37 native unit tests also pass in the separately labeled emulation profile. Windows/Linux cross-target `cef/dox` Clippy checks pass but do not execute or link a browser.

The code and evidence are delivered through PR #78. CI billing remains paused. No hosted Actions run was manually dispatched, no production signing or release was performed, and no Adea configuration or external application process was changed. Root JavaScript dependencies, lockfile and `.github` workflows remain unchanged.
