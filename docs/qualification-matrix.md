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
- **Passed (Rust)**: `cargo test --workspace` in the protocol crate, shared with
  the host.
- **Not yet run**: implemented or planned, but no test decides it yet.
- **Unsupported**: fails closed today; the capability does not exist.

## Native faults and crash diagnostics

An unexpected host exit surfaces as `NativeHostExitError` (exported from
`@bun-native/core` and `@bun-native/runtime`). Its frozen `diagnostic` record
holds only `reason` (`panic`, `signal` or `exit`), `exitCode`, `signal`,
transport `phase`, the number of rejected `pendingRequests`, a Rust
`panicLocation` and a redacted `stderrTail` of at most 32 lines and
2,048 characters. Before it is bounded, the stderr tail has inherited
environment values, `NAME=value` assignments, credential-shaped
`token`/`password`/`authorization` values and long opaque tokens replaced with
`[redacted]`. When the 4 KiB capture was clipped, its first partial line is
dropped, so a split secret cannot escape value matching. The record holds no
environment or command line. Every pending request, the event iterator and
`shutdown()` reject with the same error instance, and the process is reaped.
When stdout closes before the exit status arrives, the transport waits up to
`requestTimeoutMs` for the status, so the failure can carry the diagnostic. If
the process is still alive at that bound, it is killed with a `ProtocolError`.

| Case                                                                                                                                                                                                                      | Status                | Test                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Rust-shaped panic (exit 101) with a request in flight: typed error, panic location, secret/env/bearer redaction, same error everywhere, process reaped                                                                    | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `a Rust-shaped panic…`                                                     |
| Signal termination after a panic report (`SIGKILL`; the Bun peer cannot raise a clean `SIGABRT` because Bun's crash handler intercepts it): signal reported, no exit code (POSIX; Windows reports an exit code), redacted | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `a signal-terminated host…`                                                |
| Over 100 KiB of native stderr containing the secret: clipped, partial line dropped, bounded, redacted                                                                                                                     | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts) `unbounded native output…`                                                 |
| Exit during startup: launch rejects with a `starting`-phase diagnostic                                                                                                                                                    | Passed (headless)     | [`host-exit.test.ts`](../tests/runtime/host-exit.test.ts), [`host.test.ts`](../tests/runtime/host.test.ts)                           |
| Real host stopped (`SIGSTOP`) then killed (`SIGKILL`) under a pending callback and two queued batches: typed `signal`/`SIGKILL` diagnostic, callback aborted, zero ownership                                              | Passed (Linux native) | [`fault.ts`](../tests/native/fault.ts) `host-crash`, [`native-diagnostics-linux.py`](../scripts/quality/native-diagnostics-linux.py) |
| Real host startup failure (invalid `DISPLAY`) rejects before the timeout                                                                                                                                                  | Passed (Linux native) | [`fault.ts`](../tests/native/fault.ts) `startup-failure`                                                                             |
| Unresponsive host, event flood, output held open after exit: bounded failure                                                                                                                                              | Passed (headless)     | [`host.test.ts`](../tests/runtime/host.test.ts)                                                                                      |
| A real GPUI host panic or abort: the host installs no panic hook, so its stderr is the default Rust report that the Bun side redacts                                                                                      | Not yet run           | Needs a test-only fault command in the host. Every injected crash above uses the subprocess peer or a signal.                        |
| OS crash dumps (core files, Windows Error Reporting, macOS crash reports)                                                                                                                                                 | Unsupported           | Bun Native neither collects nor uploads dumps. OS-level dumps follow system policy and are not redacted by Bun Native.               |
| macOS and Windows native fault containment                                                                                                                                                                                | Not yet run           | The native fault steps are Linux-only.                                                                                               |

## Malformed payloads at the native boundary

| Case                                                                                                                                                                                                               | Status                           | Test                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 36-case shared adversarial corpus (forbidden capabilities, prototype keys, unsafe handles, NUL, unpaired surrogates, non-finite layout) rejected identically by TypeScript and Rust; invalid sessions are poisoned | Passed (headless), Passed (Rust) | [`security.test.ts`](../tests/protocol/security.test.ts), [`security_tests.rs`](../native/protocol/src/security_tests.rs), [`bridge-security.json`](../tests/fixtures/bridge-security.json) |
| Invalid UTF-8/JSON, oversized or unterminated frames, EOF inside a frame, BOM                                                                                                                                      | Passed (headless), Passed (Rust) | [`framing.test.ts`](../tests/protocol/framing.test.ts), [`tests.rs`](../native/protocol/src/tests.rs) `invalid_frames_poison_the_reader`, `oversized_unterminated_frame_…`                  |
| Malformed host output: bad JSON, unknown response id, mismatched owner/revision, duplicate ready, out-of-order sequence                                                                                            | Passed (headless)                | [`host.test.ts`](../tests/runtime/host.test.ts)                                                                                                                                             |
| Host turns an invalid command frame into a terminal `invalid_command` error and finishes                                                                                                                           | Not yet run                      | Source: `Incoming::InvalidFrame` in [`main.rs`](../native/gpui-host/src/main.rs). No native test sends a corrupt frame to the release host.                                                 |

## Version and capability mismatch

| Case                                                                                                                 | Status            | Test                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host reports a newer or obsolete protocol: launch rejects with `ProtocolError` and the process is reaped             | Passed (headless) | [`host.test.ts`](../tests/runtime/host.test.ts) `wrong-version`, `obsolete-version`                                                                                             |
| Host lacks a required capability                                                                                     | Passed (headless) | [`host.test.ts`](../tests/runtime/host.test.ts) `missing-*`                                                                                                                     |
| The TypeScript command parser rejects `hello` with protocol 1, 2 or 3, so the client cannot send an obsolete version | Passed (headless) | [`messages.test.ts`](../tests/protocol/messages.test.ts)                                                                                                                        |
| Release host answers a mismatched `hello` with `version_mismatch`                                                    | Not yet run       | Source: `Session::dispatch` in [`session.rs`](../native/gpui-host/src/session.rs). The TypeScript client cannot send a mismatched hello, and no native test sends one directly. |

## Offline launch

| Case                                                                                          | Status                                                                                                        | Test                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Launch, negotiate, round-trip and shut down inside an empty network namespace (`unshare -rn`) | Passed (headless) on Linux where unprivileged user namespaces are allowed; reported as skipped elsewhere      | [`offline-launch.test.ts`](../tests/runtime/offline-launch.test.ts) |
| Offline launch of the release GPUI host or an inspected AOT application                       | Not yet run                                                                                                   | Needs the Linux native session inside a network namespace.          |
| Clean-machine install from a local cache                                                      | See [`cli-fresh-local-cache-install-2026-11-04.json`](evidence/cli-fresh-local-cache-install-2026-11-04.json) | That evidence covers installation, not network isolation.           |

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
```

Use the pinned Bun from [`toolchain.json`](../toolchain.json). The Linux native
rows run with the `Development and AOT native failure…` step of
`native-linux.yml`.
