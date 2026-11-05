# @bun-native/protocol

`@bun-native/protocol` is the private, dependency-free TypeScript side of the
Bun-to-native-host wire contract. It defines the command, event, element and
service schemas, validates untrusted values against them, and frames them as
bounded JSON lines. It has no process, platform or framework code.

Applications should not import it. Use [`@bun-native/core`](../core/README.md),
which re-exports `ProtocolError` and the public element/style types; only
`@bun-native/runtime` and `@bun-native/core` depend on this package. The
package-boundary check (`bun run check:boundaries`) forbids it from importing
any other workspace package or platform module.

The full wire contract, including handshake, ownership and error semantics, is
described in [Native host protocol](../../docs/native-abi.md). The Rust host
validates the same messages independently in `native/protocol`.

## Exports

| Export                                                | Purpose                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`                                    | Current wire version (`8`), sent in the `hello` command                                                                                                                                                         |
| `REQUIRED_CAPABILITIES`                               | Capabilities a host must report before a session starts                                                                                                                                                         |
| `encodeFrame(value)`                                  | Serialize one JSON value plus newline; rejects non-JSON values and oversized frames                                                                                                                             |
| `FrameDecoder`                                        | Incremental decoder: `push(chunk)` returns complete frames, `finish()` ends the stream                                                                                                                          |
| `parseCommand(value)`, `parseEvent(value)`            | Validate an unknown value as a `Command` or `NativeEvent`, or throw `ProtocolError`                                                                                                                             |
| `parseElement(value)`                                 | Validate one `Element` (`box`, `text`, `button`, `input`) and its `Style`                                                                                                                                       |
| `ProtocolError`                                       | Thrown for every framing or schema violation                                                                                                                                                                    |
| `DEFAULT_LIMITS`, `MAX_OPERATIONS`, `MAX_FRAME_BYTES` | Wire limits; a frame payload is at most 65,536 bytes and a batch at most 256 operations                                                                                                                         |
| `MAX_TEXT_BYTES`                                      | Per-string UTF-8 limit for element text and values                                                                                                                                                              |
| `ERROR_CODES`                                         | Error codes a host may report                                                                                                                                                                                   |
| `MAX_CLIPBOARD_BYTES`, `MAX_GLOBAL_SHORTCUTS`         | Service limits for clipboard text and owned global shortcuts                                                                                                                                                    |
| `MAX_NOTIFICATIONS`, `MAX_NOTIFICATION_*_BYTES`       | Service limits for owned notifications and their title/body                                                                                                                                                     |
| `GLOBAL_SHORTCUT_KEYS`, `NOTIFICATION_DISMISSALS`     | Accepted shortcut keys and notification dismissal reasons                                                                                                                                                       |
| Types                                                 | `Command`, `NativeEvent`, `Operation`, `Element`, `Style`, `Limits`, `ErrorCode`, `Capability`, `KeyModifiers`, `PointerButton`, `ServicePolicy`, `ShortcutModifiers`, `ClipboardText`, `NotificationDismissal` |

The decoder keeps at most one frame in its buffer. After a `ProtocolError` it
stays closed, so the caller must terminate that session rather than resume it.

```ts
import {
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'

const frame = encodeFrame(parseCommand({ id: 1, type: 'hello', protocol: PROTOCOL_VERSION }))
const decoder = new FrameDecoder()
const [command] = decoder.push(frame).map(parseCommand)
decoder.finish()
console.log(command?.type) // "hello"
```

## Tests

```sh
bun test tests/protocol
```

These tests cover framing bounds, schema validation for every command and event,
layout styles and service payloads. Rust-side validation is tested separately
with `bun run native:test`.
