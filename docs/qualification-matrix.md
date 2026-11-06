# Security and crash qualification matrix

[Issue #247](https://github.com/0xPlayerOne/bun-native/issues/247) requires a
matrix of native fault, malformed payload, version mismatch, offline launch,
update failure and rollback cases. Each row names the test that decides it.
A row is **passed** only where that test runs and passes; everything else is
**not yet run** or **unsupported**, which is not passed.

Status key:

- **Passed (headless)**: runs in `bun run test` against a real subprocess
  peer. It qualifies the Bun-side transport, not
  GPUI.
- **Passed (Linux native)**: a required step of
  [`native-linux.yml`](../.github/workflows/native-linux.yml) against the
  release `bun-native-host` under Xvfb, in development and inspected AOT.
  **Passed (Linux native, development)** is the same, without an AOT entry.
- **Passed (Rust)**: `cargo test --workspace` in the protocol crate, shared with
  the host.
- **Not yet run**: implemented or planned, but no test decides it yet.
- **Unsupported**: fails closed today; the capability does not exist.

## Native faults and crash diagnostics

An unexpected host exit surfaces as `NativeHostExitError` (exported from
`@bun-native/core` and `@bun-native/runtime`). Its frozen `diagnostic` record
holds only `reason` (`panic`, `signal` or `exit`), `exitCode`, `signal`,
transport `phase`, the number of rejected `pendingRequests`, a Rust
`panicLocation`, a redacted `stderrTail` of at most 32 lines and
2,048 characters, and `stderrTruncated`. `reason` is `panic` whenever stderr
holds a Rust `panicked at file:line:column` report, even for a signalled host;
otherwise `signal` when a signal ended it, else `exit`. Before it is bounded,
the stderr tail has control characters other than newline and tab removed, and
inherited environment values of at least six characters, `NAME=value`
assignments, values after `authorization`, `bearer`, `token`, `secret`,
`password`, `passwd`, `api_key` or `cookie`, and opaque tokens of 32 or more
characters replaced with `[redacted]`. The transport keeps the last 4,096
characters of stderr. When that capture was clipped, its first partial line is
dropped, so a split secret cannot escape value matching, and `stderrTruncated`
is set. The record holds no
environment or command line. Every pending request, the event iterator and
`shutdown()` reject with the same error instance, and the process is reaped.
When stdout closes before the exit status arrives, the transport waits up to
`requestTimeoutMs` for the status, so the failure can carry the diagnostic. If
the process is still alive at that bound, it is killed with a `ProtocolError`.

| Case                                                                                                                                                                                                                                                                 | Status                | Test                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Rust-shaped panic (exit 101) with a request in flight: typed error, panic location, secret/env/bearer redaction, same error everywhere, process reaped                                                                                                               | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `a Rust-shaped panic…`                                                     |
| Signal termination after a panic report (`SIGKILL`; the Bun peer cannot raise a clean `SIGABRT` because Bun's crash handler intercepts it): signal reported, no exit code (POSIX; Windows reports an exit code), redacted                                            | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `a signal-terminated host…`                                                |
| Over 100 KiB of native stderr containing the secret: clipped, partial line dropped, bounded, redacted                                                                                                                                                                | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `unbounded native output…`                                                 |
| Exit during startup: launch rejects with a `starting`-phase diagnostic                                                                                                                                                                                               | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts), [`host.test.ts`](../tests/runtime/host.test.ts)                           |
| Real host stopped (`SIGSTOP`) then killed (`SIGKILL`) under a pending callback and two queued batches: one shared transport failure (a `NativeHostExitError` must report `signal`/`SIGKILL`; EOF `ProtocolError` is also accepted), callback aborted, zero ownership | Passed (Linux native) | [`fault.ts`](../tests/native/fault.ts) `host-crash`, [`native-diagnostics-linux.py`](../scripts/quality/native-diagnostics-linux.py) |
| Real host startup failure (invalid `DISPLAY`) rejects before the timeout                                                                                                                                                                                             | Passed (Linux native) | [`fault.ts`](../tests/native/fault.ts) `startup-failure`                                                                             |
| Unresponsive host, event flood, output held open after exit: bounded failure                                                                                                                                                                                         | Passed (headless)     | [`host.test.ts`](../tests/runtime/host.test.ts)                                                                                      |
| A real GPUI host panic or abort: the host installs no panic hook, so its stderr is the default Rust report that the Bun side redacts                                                                                                                                 | Not yet run           | Needs a test-only fault command in the host. Every injected crash above uses the subprocess peer or a signal.                        |
| OS crash dumps (core files, Windows Error Reporting, macOS crash reports)                                                                                                                                                                                            | Unsupported           | Bun Native neither collects nor uploads dumps. OS-level dumps follow system policy and are not redacted by Bun Native.               |
| macOS and Windows native fault containment                                                                                                                                                                                                                           | Not yet run           | The native fault steps are Linux-only.                                                                                               |

## Malformed payloads at the native boundary

| Case                                                                                                                                                                                                                                                  | Status                             | Test                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40-case shared adversarial corpus (34 rejections: forbidden capabilities, prototype keys, unsafe handles, NUL, unpaired surrogates, non-finite layout; 6 accepted controls) decided identically by TypeScript and Rust; invalid sessions are poisoned | Passed (headless), Passed (Rust)   | [`security.test.ts`](../tests/protocol/security.test.ts), [`security_tests.rs`](../native/protocol/src/security_tests.rs), [`bridge-security.json`](../tests/fixtures/bridge-security.json) |
| Invalid UTF-8/JSON, oversized or unterminated frames, EOF inside a frame, BOM                                                                                                                                                                         | Passed (headless), Passed (Rust)   | [`framing.test.ts`](../tests/protocol/framing.test.ts), [`tests.rs`](../native/protocol/src/tests.rs) `invalid_frames_poison_the_reader`, `oversized_unterminated_frame_…`                  |
| Malformed host output: bad JSON, unknown response id, mismatched owner/revision, duplicate ready, out-of-order sequence                                                                                                                               | Passed (headless)                  | [`host.test.ts`](../tests/runtime/host.test.ts)                                                                                                                                             |
| Release host turns invalid JSON, a forbidden `read_file` command and an oversized unterminated frame into a terminal id-less `invalid_command`, closes output and exits 0                                                                             | Passed (Linux native, development) | [`boundary.ts`](../tests/native/boundary.ts) `invalid-json-frame-is-terminal`, `forbidden-capability-frame-is-terminal`, `oversized-frame-is-terminal`                                      |

## Version and capability mismatch

| Case                                                                                                                                                                       | Status                             | Test                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host reports a newer or obsolete protocol: launch rejects with `ProtocolError` and the process is reaped                                                                   | Passed (headless)                  | [`host.test.ts`](../tests/runtime/host.test.ts) `wrong-version`, `obsolete-version`                                                                       |
| Host lacks a required capability                                                                                                                                           | Passed (headless)                  | [`host.test.ts`](../tests/runtime/host.test.ts) `missing-*`                                                                                               |
| The TypeScript command parser rejects `hello` with protocol 1, 2 or 3, so the client cannot send an obsolete version                                                       | Passed (headless)                  | [`messages.test.ts`](../tests/protocol/messages.test.ts)                                                                                                  |
| Release host answers a newer, older or protocol-1 `hello` with a recoverable `version_mismatch`, then negotiates the current version                                       | Passed (Linux native, development) | [`boundary.ts`](../tests/native/boundary.ts) `version-mismatch-is-recoverable`                                                                            |
| Release host rejects commands before `hello` and a second `hello` with `invalid_state`, and non-increasing request ids with `invalid_command`, keeping the session healthy | Passed (Linux native, development) | [`boundary.ts`](../tests/native/boundary.ts) `commands-before-hello-are-rejected`, `duplicate-hello-is-rejected`, `non-increasing-request-id-is-rejected` |

## Offline launch

| Case                                                                                                                                                                       | Status                                                                                                        | Test                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch, negotiate, round-trip and shut down inside an empty network namespace (`unshare -rn`)                                                                              | Passed (headless) on Linux where unprivileged user namespaces are allowed; reported as skipped elsewhere      | [`offline-launch.test.ts`](../tests/runtime/offline-launch.test.ts)                                                                                                                                  |
| Release GPUI host under Xvfb inside `unshare --map-root-user --net` (only loopback, asserted by the fixture): every boundary case plus a real window open/close round trip | Passed (Linux native, development)                                                                            | [`boundary.ts`](../tests/native/boundary.ts) with `BUN_NATIVE_REQUIRE_OFFLINE=1`, step `Development release-host boundary rejection…` of [`native-linux.yml`](../.github/workflows/native-linux.yml) |
| Offline launch of an inspected AOT application                                                                                                                             | Not yet run                                                                                                   | The boundary fixture runs in development only; the AOT entries are compiled from a fixed list.                                                                                                       |
| Clean-machine install from a local cache                                                                                                                                   | See [`cli-fresh-local-cache-install-2026-11-04.json`](evidence/cli-fresh-local-cache-install-2026-11-04.json) | That evidence covers installation, not network isolation.                                                                                                                                            |

## Capability, provenance and lifecycle boundaries

| Case                                                                                                               | Status                                                                                   | Test                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Services default to deny; only launch permissions grant them, and a host policy that differs from them is rejected | Passed (headless)                                                                        | [`services.test.ts`](../tests/core/services.test.ts) `wrong-policy`, `missing-service`                               |
| Filesystem, process, shell, network, URL, plugin, browser and update bindings                                      | Unsupported (fails closed)                                                               | [`bridge-security.json`](../tests/fixtures/bridge-security.json), [ADR 0003](decisions/0003-bridge-security.md)      |
| Sandbox of trusted Bun application code                                                                            | Unsupported                                                                              | Out of scope for the boundary: see [ADR 0003](decisions/0003-bridge-security.md).                                    |
| Vendored native source provenance                                                                                  | Passed (Python quality suite in [`bun-native.yml`](../.github/workflows/bun-native.yml)) | [`test_native_vendor_provenance.py`](../tests/quality/test_native_vendor_provenance.py), [provenance](provenance.md) |
| Signed or notarized distribution                                                                                   | Unsupported                                                                              | See [releasing](releasing.md).                                                                                       |

## Update failure and rollback

| Case                                                  | Status      | Test                                                                                                                                                                           |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Update manifest integrity, failed update and rollback | Not yet run | [#249](https://github.com/0xPlayerOne/bun-native/issues/249) owns the update path. Bun Native has no update binding today; `install-update` fails closed in the shared corpus. |

## Reproduce

```sh
bun test tests/runtime tests/protocol tests/core/services.test.ts
cargo test --locked -p bun-native-protocol
cargo build --locked -p bun-native-host --release
BUN_NATIVE_HOST=$PWD/target/release/bun-native-host \
  xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' bun tests/native/boundary.ts
BUN_NATIVE_HOST=$PWD/target/release/bun-native-host BUN_NATIVE_REQUIRE_OFFLINE=1 \
  unshare --map-root-user --net \
  xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' bun tests/native/boundary.ts
```

Use the pinned Bun from [`toolchain.json`](../toolchain.json). The Linux native
fault rows run with the `Development and AOT native failure…` step of
`native-linux.yml`; the boundary and offline rows run with its
`Development release-host boundary rejection…` step.
