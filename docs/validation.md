# M1 validation

Separate implemented checks from native and browser support claims.

**Status:** Initial foundation implementation; CI evidence will be attached to the PR.

## Portable checks executed locally

The portable suite passed 34 tests on Node 22.16.0 with TypeScript stripping. A
strict TypeScript 5.8.3 check of the portable code and the browser-only build also
passed. This checks semantics independently of Bun; it does not validate the
pinned Bun 1.4.3 or authoritative TypeScript 7.0.2 toolchain.

Coverage includes lifecycle ordering, stale/foreign/forged handles, dependent
session cleanup, explicit unsupported capabilities, trust revocation, startup
rollback, cancellation, repeated disposal, listener cleanup, typed import
boundaries, signed manifests, archive limits, malicious archive types, unsafe
paths, partial downloads, redirected origins, corrupt caches, offline reuse,
and concurrent cache consumers.

## Native/CI checks

`.github/workflows/ci.yml` runs real Rust native builds and tests, Bun FFI and
Node-API Worker handoff probes, a Bun subprocess fallback, native artifact
packaging, debug-symbol separation, and a verified/offline consumer load on
Linux x64, macOS arm64, and Windows x64. Each run retains raw reports and artifacts.
The workflow is read-only with respect to the repository and uses pinned action
commits. No public publishing or production signing keys are configured.

Qualification passes/failures must be read from the actual run, not inferred from
the presence of workflow files. The native report scope is ABI/thread-handoff
primitives only. Full CEF/AppKit/Win32/GTK integration, actual idle wakeups,
process-tree memory, event-loop responsiveness under browser load, and same-host
service replacement remain later qualification work.

## Known limits

- No actual browser backend, terminal, renderer IPC, or hot reload is implemented.
- No production trust root, key rotation, installer, updater, or signed desktop
  distribution is configured. Test artifacts are not public release candidates.
- Windows cache-symlink attack coverage requires link-capable runner privileges;
  archive symlink rejection is tested on every platform.
- Cache installation handles ordinary errors and cancellation, not arbitrary
  power loss or a malicious same-user process racing filesystem operations.
- M1 does not claim a speed or size win over any competitor. Use M2's equal-workload
  harness before comparing runtime numbers.
