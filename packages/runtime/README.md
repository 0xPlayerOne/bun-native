# @bun-native/runtime

`@bun-native/runtime` is the private process transport between Bun and one
prebuilt native host. `NativeHost` spawns the host executable, negotiates the
[protocol](../protocol/README.md) version, limits, capabilities and service
policy, correlates requests with responses, and delivers ordered window events.
It never builds, downloads or locates a host, and it knows nothing about
windows, element trees or frameworks.

Applications should not import it. [`@bun-native/core`](../core/README.md)
owns the only `NativeHost` per application and re-exports `NativeCommandError`.
`createApplication(options)` accepts this package's `HostOptions` as its
`ApplicationOptions`. Within the workspace, only core depends on runtime, and
runtime depends only on `@bun-native/protocol`.

## Exports

| Export               | Purpose                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `NativeHost`         | One owned native process and its bounded, versioned channel                            |
| `NativeCommandError` | A host-reported `error` response, with the protocol `code` and originating `requestId` |
| `HostOptions`        | Launch options (below)                                                                 |
| `ServicePermissions` | Launch-time `allow`/`deny` grants for native services                                  |
| `WindowCommand`      | Commands that `send` accepts, without the request `id`                                 |
| `HostResponse`       | Correlated responses that `send` resolves with                                         |
| `WindowEvent`        | Sequenced, window-scoped events delivered by the async iterator                        |

`HostOptions`:

| Option             | Contract                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executable`       | Required absolute path to an existing prebuilt host. Starting an application never invokes Cargo                                                                                                       |
| `args`             | Optional extra process arguments, passed without a shell. Arguments starting with `--bun-native-` are reserved and rejected                                                                            |
| `requestTimeoutMs` | Per-request deadline, an integer from 1 to 60,000; defaults to 5,000                                                                                                                                   |
| `permissions`      | `windowDisplay`, `clipboardRead`, `clipboardWrite`, `globalShortcuts` and `notifications`, each `'allow'` or `'deny'`. Every service defaults to deny and the policy is fixed for the process lifetime |

## `NativeHost`

`NativeHost.launch(options)` validates the options, spawns the host and sends
`hello` with `PROTOCOL_VERSION`. It resolves only after the host has reported
readiness with every `REQUIRED_CAPABILITIES` entry and a service policy equal to
the requested permissions, then acknowledged `hello`. A failed launch terminates
the process before rejecting. After launch:

- `limits`, `capabilities` and `servicePolicy` expose the negotiated values.
- `send(command)` resolves with the matching response after the native UI thread
  acknowledges it, or rejects with `NativeCommandError`, a protocol error or a
  timeout. At most 128 requests may be pending.
- The host is an `AsyncIterable<WindowEvent>` with exactly one consumer and no
  concurrent reads. More than 128 undelivered events is a protocol error.
- `shutdown()` requests an orderly exit and waits for the process; `exited`
  resolves with its exit code. Any protocol violation, timeout or unexpected
  exit fails the whole session.

## Startup tracing

Setting `BUN_NATIVE_STARTUP_TRACE=1` together with an absolute
`BUN_NATIVE_EVIDENCE_LOG` path and a `BUN_NATIVE_EVIDENCE_NONCE` appends a
bounded record of each startup request phase to that log. It does not change
deadlines or scheduling. See
[native startup diagnostics](../../docs/records/native-startup-diagnostics.md).

## Tests

```sh
bun test tests/runtime
```

These tests run `NativeHost` against a headless protocol peer subprocess; they
do not start a native window.
