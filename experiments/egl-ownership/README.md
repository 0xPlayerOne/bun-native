# Pinned EGL ownership experiment

This is private research for [#370](https://github.com/0xPlayerOne/bun-native/issues/370), not a production dependency patch. It exercises the actual `wgpu-hal` EGL constructor and destructor from WGPU `cddb2f5d80dc0009b2ef6767635140cacf90a007` against an owned deterministic EGL ABI library. The shared Cargo checkout, Bun Native dependency declarations and production lockfile remain unchanged.

The pristine `wgpu-hal/src/gles/egl.rs` SHA-256 is `2663a1da95a05dc6f0ce33f1479934cf7a67736973dc353c3ac90073260e865b`. Its display reference count increments before fallible initialization. Later fallible construction also has no owner to release that reference or an already-created context. A separate successful-path control checks that one owner's dummy pbuffer is released while another owner keeps the same display alive.

## What the controls execute

`run.py` archives the exact commit into a fresh owned directory. It adds a private feature, a probe module and a public probe entry to that copy only. `ownership-probe.rs` calls the existing private `Inner::create` and drops its actual returned owners. It reads the real `DISPLAYS_REFERENCE_COUNT`; it does not implement a substitute reference-count model. `fake-egl.c` supplies EGL 1.4 symbols through `khronos-egl`'s existing dynamic loader. Unexpected entry points abort, opaque handle identities and duplicate destruction are checked, and terminating a display with a live context aborts.

The ABI controls cover initialization, vendor/extension/client-API queries, exhausted configuration selection, API binding, context creation and pbuffer creation failures. They also cover a normal successful owner, failure while an earlier owner remains alive, another successful owner after that failure, and the dummy pbuffer's lifetime with two successful owners. Each fixed case runs once in a fresh child process; assertion failures and cleanup calls are preserved.

This tests Rust ownership decisions at real EGL call boundaries. It does **not** test an EGL driver, GPU, display server, native window, performance, or graphics rendering. It provides no evidence that these defects caused the unrelated [#296 startup delay](https://github.com/0xPlayerOne/bun-native/issues/296).

## Reproduce

Use Linux, Python with safe tar extraction, a C compiler, pinned Rust 1.98.1, and an existing WGPU git checkout containing the exact commit. The standalone runner uses the committed experiment lock and the existing Cargo package cache offline. It intentionally avoids the upstream workspace's unrelated dev dependencies; a direct upstream `cargo test --offline --locked -p wgpu-hal --lib --no-default-features --features gles --no-run` attempt failed at dependency resolution because `cts_runner` required uncached `env_logger`.

```sh
python3 experiments/egl-ownership/run.py \
  --source /path/to/read-only/wgpu-checkout \
  --output /path/to/new-owned-baseline-directory \
  --variant baseline

python3 experiments/egl-ownership/run.py \
  --source /path/to/read-only/wgpu-checkout \
  --output /path/to/new-owned-rollback-directory \
  --variant construction-rollback

python3 experiments/egl-ownership/run.py \
  --source /path/to/read-only/wgpu-checkout \
  --output /path/to/new-owned-complete-directory \
  --variant complete-ownership
```

The output directory must not exist. It contains the private source, build, per-case stdout/stderr and `result.json`; remove that owned directory when finished. The script never patches the supplied checkout. Cargo and the compiler are invoked with argument arrays. Compilation uses two jobs and a 120-second command bound; each deterministic child has a ten-second infrastructure bound. These are experiment bounds, not changed native runtime deadlines.

`construction-rollback.patch` is a proposed narrow fix: increment only after initialization succeeds while retaining the same mutex scope, then use a construction guard until `Inner` takes ownership. Failed later construction destroys any acquired context before releasing the display reference. It preserves backend selection, context fallback and the original error.

`pbuffer-owner-release.patch` is a distinct five-line change to the successful `Inner::drop` path. It destroys that owner's optional dummy pbuffer before the existing context destruction and display release, keeping the existing warning-and-continue behavior. The combined variant applies this after construction rollback. It does not change surface creation, thread-current state, the reference-count algorithm, or the pre-existing `EglContext` cloning caveat.

The experiment lock was derived from Bun Native's committed production lock at `3f3d84904a106e9147ccbd5e7bfa4e52065d83ed`, replacing only the pinned WGPU git packages with their private path copies and letting the isolated offline runner prune unused dependencies. It does not replace or update the production lock. The private upstream archive retains WGPU's MIT/Apache-2.0 licensing; patch context comes from that exact source.

## Preserved baseline

The first actual-code baseline reproduced all eight construction leaks and both shared-display failure leaks. The normal successful single-owner control passed. The separate shared-pbuffer control found two live pbuffers after one of two owners was dropped, while the real display reference count and live context count had correctly decreased to one. These are deterministic fake-ABI observations, with no claim about driver allocation sizes. The initial checkpoint remains in history as `e004ca8e8f2c06894e680a0bb0449661a9cb8984`; its equivalent published source is `6d4218dd8b50c73556c69d40221ba2695ed66cc7`.

The committed `baseline.json` and `baseline-transcript.txt` preserve the formatted-source checkpoint: twelve fixed cases, eleven original assertion failures and one successful normal-owner control. `matches_expected_outcomes` means the expected defects were reproduced; it is not a passing ownership or native qualification claim. The receipt records source, compiler, lock, binary and fixture hashes.

## Corrected-source results

Two separate source-bound runs retain the distinction between construction rollback and successful pbuffer ownership:

| Control group                                                                            | Pristine source | Construction rollback only | Both private patches |
| ---------------------------------------------------------------------------------------- | --------------- | -------------------------- | -------------------- |
| Eight injected constructor failures                                                      | 8 fail          | 8 pass                     | 8 pass               |
| Normal single-owner success/drop                                                         | 1 pass          | 1 pass                     | 1 pass               |
| Failed initialize/query with an earlier live owner, followed by another successful owner | 2 fail          | 2 pass                     | 2 pass               |
| Dropped owner's pbuffer while another owner keeps the display alive                      | 1 fail          | 1 fail                     | 1 pass               |

`construction-rollback.json` and its transcript preserve eleven successful cases and the remaining expected pbuffer assertion failure. `complete-ownership.json` and its transcript preserve twelve successful cases. These records include the actual EGL call sequence, real reference counts, opaque fixture resource counts, original constructor errors, exit codes and source/binary hashes. They are not native application or real-driver qualification.

The pbuffer-creation failure now records `destroy-context` before `terminate`, with no display reference or context remaining. A failed initialize/query while another owner is live retains exactly one reference and never terminates the display. With both patches, dropping the first of two successful owners releases exactly its pbuffer and context, leaves one of each alive and does not terminate; dropping the last owner releases both and terminates once.

The fixture intentionally models termination of its unbound resources. The [EGL 1.4 specification, sections 3.2 and 3.5.5](https://registry.khronos.org/EGL/specs/eglspec.1.4.pdf), defines display termination and surface deletion, including deferred deletion for current resources or bound pbuffer buffers. The probe never makes a context/surface current or binds a pbuffer to a texture, so it does not test those deferred-deletion cases. Checking shared pbuffer ownership before final termination prevents the fixture's final display cleanup from masking the missing per-owner release.

The fully patched private `wgpu-hal` also passes `cargo clippy --offline --locked --manifest-path runner/Cargo.toml -p wgpu-hal -- -D warnings`; Rust formatting, the C fixture's `-Wall -Werror` build, Ruff and normal Bun Native hooks pass. The shared WGPU checkout still has the pristine EGL hash and no tracked changes. Production dependency adoption, real-driver qualification, upstream submission and any relationship to #296 remain open decisions outside this experiment.
