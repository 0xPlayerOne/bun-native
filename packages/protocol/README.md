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

| Export                                                                                                                                | Purpose                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`                                                                                                                    | Current wire version, sent in the `hello` command; see [Native host protocol](../../docs/native-abi.md)                                                                                                                                                                               |
| `REQUIRED_CAPABILITIES`                                                                                                               | Capabilities a host must report before a session starts                                                                                                                                                                                                                               |
| `encodeFrame(value)`                                                                                                                  | Serialize one JSON value plus newline; rejects non-JSON values and oversized frames                                                                                                                                                                                                   |
| `FrameDecoder`                                                                                                                        | Incremental decoder: `push(chunk)` returns complete frames, `finish()` ends the stream                                                                                                                                                                                                |
| `parseCommand(value)`, `parseEvent(value)`                                                                                            | Validate an unknown value as a `Command` or `NativeEvent`, or throw `ProtocolError`                                                                                                                                                                                                   |
| `parseElement(value)`                                                                                                                 | Validate one `Element` and its `Style`; the result is frozen, and parsing it again returns it without revalidation                                                                                                                                                                    |
| `ProtocolError`                                                                                                                       | Thrown for every framing or schema violation                                                                                                                                                                                                                                          |
| `DEFAULT_LIMITS`, `MAX_OPERATIONS`, `MAX_FRAME_BYTES`, `MAX_EVENT_FRAME_BYTES`                                                        | Wire limits; a command payload is at most 16 MiB, an event payload at most 64 KiB and a batch at most 16,384 operations                                                                                                                                                               |
| `MAX_TEXT_BYTES`                                                                                                                      | Per-string UTF-8 limit for element text and values                                                                                                                                                                                                                                    |
| `ERROR_CODES`                                                                                                                         | Error codes a host may report                                                                                                                                                                                                                                                         |
| `MAX_CLIPBOARD_BYTES`, `MAX_GLOBAL_SHORTCUTS`                                                                                         | Service limits for clipboard text and owned global shortcuts                                                                                                                                                                                                                          |
| `MAX_NOTIFICATIONS`, `MAX_NOTIFICATION_*_BYTES`                                                                                       | Service limits for owned notifications and their title/body                                                                                                                                                                                                                           |
| `GLOBAL_SHORTCUT_KEYS`, `NOTIFICATION_DISMISSALS`                                                                                     | Accepted shortcut keys and notification dismissal reasons                                                                                                                                                                                                                             |
| `MAX_FILESYSTEM_ROOTS`, `MAX_FILE_GRANTS`, `MAX_FILE_CHUNK_BYTES`, `MAX_DIRECTORY_ENTRIES`, `FILE_ACCESS`                             | Filesystem grant limits and root access modes                                                                                                                                                                                                                                         |
| `parseFilesystemRoots`, `filesystemRootArgument`, `filesystemRootsFromArguments`, `parseRootId`, `parseFilePath`, `fileResultAnswers` | Validate filesystem roots, launch arguments, grant paths and file results                                                                                                                                                                                                             |
| Types                                                                                                                                 | `Command`, `NativeEvent`, `Operation`, `Element`, `Style`, `Limits`, `ErrorCode`, `Capability`, `KeyModifiers`, `PointerButton`, `ServicePolicy`, `ShortcutModifiers`, `ClipboardText`, `NotificationDismissal`, `FileAccess`, `FileKind`, `FileOperation`, `FileResult`, `WriteMode` |

The decoder keeps at most one frame in its buffer. After a `ProtocolError` it
stays closed, so the caller must terminate that session rather than resume it.

```ts
import {
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
} from "@bun-native/protocol";

const frame = encodeFrame(
  parseCommand({ id: 1, type: "hello", protocol: PROTOCOL_VERSION }),
);
const decoder = new FrameDecoder();
const [command] = decoder.push(frame).map(parseCommand);
decoder.finish();
console.log(command?.type); // "hello"
```

## Tests

```sh
bun test tests/protocol
```

These tests cover framing bounds, schema validation for every command and event,
layout styles and service payloads. Rust-side validation is tested separately
with `bun run native:test`.
