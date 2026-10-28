# M37 — portable browser actions and secure diagnostics

**Scope:** issue #37. A portable, engine-neutral API for observing and controlling
approved browser views, with the engine-specific details (CEF, CDP) isolated in the
adapter. The raw CDP surface stays an engine-specific debug extension; it is not the
public SDK's only browser-control interface.

**Status:** the browser dispatcher is an unexported prototype exercised with an
injected test adapter. The CEF backend still reports screenshot, evaluation and
input as unsupported. Its string target descriptors and caller-provided context
are not a substitute for native-bound authority. The standalone diagnostic
collector below is implemented and tested, but it is not wired to a browser
adapter or a public debug endpoint. Issue #37 remains open.

## Capabilities

| Action               | Capability           | Requirement                                                             |
| -------------------- | -------------------- | ----------------------------------------------------------------------- |
| `navigate`           | `navigate`           | the target origin must be the view's authorized origin                  |
| `screenshot`         | `screenshot`         | bounded by the policy's maximum size                                    |
| `snapshot`           | `snapshot`           | debug surface: opt-in, authenticated, off in packaged production builds |
| `evaluate`           | `evaluate`           | debug surface, and only an **approved** expression                      |
| `observe-dom`        | `observe-dom`        | observation only                                                        |
| `accessibility-tree` | `accessibility-tree` | observation only                                                        |
| `input`              | `input`              | the view must allow the input capability                                |

A capability the embedder does not implement, or that the view does not allow, is the
explicit `unsupported-capability` error. It is never a silent no-op and never a
pretended CDP compatibility.

## The binding rule

Every action is bound to an authorized `(viewId, sessionId)` pair and to the epoch the
host last observed. A request for another session is `unauthorized-target`; a request
for a superseded epoch is `stale-target`; a navigation that does not advance the
epoch is `navigation-race`; a navigation that leaves the authorized origin is
`cross-origin-frame`. Remote content therefore never gains application-native
authority by being controlled: the authority comes from the host's authorization, not
from the page.

## Diagnostics

`collectDiagnosticBundle` snapshots explicitly supplied Bun-error, renderer-log,
RPC-stage and reload-stage records. It creates no listener and reads no files.
Only the declared record fields are copied. Input accessors, custom iterators,
`toJSON` methods and proxy traps are never invoked; malformed records and optional
fields are omitted with `truncated: true`. The returned bundle, records and stack
frames are frozen.

`maxBytes` must be an integer from 64 through 1,048,576. Both the limit and the
returned `bytes` count refer to **the complete compact JSON serialization of the
returned bundle**, including array punctuation, the metadata envelope and its
own byte-count digits. This corrects the earlier record-only accounting, which
could emit a bundle larger than its reported size. Admission accounts for each
record once and stops before exceeding the byte budget; it does not eagerly
serialize the entire input and repeatedly trim it. At most 256 input records are
examined. Each string is bounded at 8,192 UTF-8 bytes; an oversized string becomes
`[truncated]` as a whole, avoiding a partially retained credential assignment.

Credential-like text and credential-bearing URLs become `[redacted]` (or the
configured public marker). Home paths are redacted inside messages, timestamps,
keys and mapped/captured frame paths, including POSIX, Windows and `file:` forms;
the username is removed. Control characters are normalized before matching.
This is conservative pattern-based redaction of application-selected records,
not a detector for every possible secret or personal datum. Unknown record
properties are discarded instead of being exported accidentally.

The separate `redactDiagnosticValue` helper returns a bounded JSON-safe snapshot:
cycles become `[circular]`, accessors/proxies/unsupported values become
`[unavailable]`, and depth/node/size limits produce `[truncated]`. It examines at
most 256 nodes to depth eight and never calls methods on input values.

### Source maps

`DiagnosticSourceMap` requires a v3 map with an explicit `file` matching the exact
generated frame path. When a bundler omits the optional v3 `file` field, the caller
must bind the supplied map to its known build output; the collector never guesses
a basename or searches the filesystem. Map text and metadata are bounded at
1 MiB, with at most 4,096 source/name entries. Embedded `sourcesContent` is neither
read nor exported. Indexed section maps are not supported by this collector.

Mapping uses the pinned Bun runtime's `node:module` `SourceMap.findEntry`, with
explicit conversion from zero-based map offsets to one-based stack coordinates.
It reports the actual segment's original source and position, without extrapolating
unmapped columns or lines. The earlier helper simply selected `sources[0]` and
kept generated coordinates; that was not source mapping. Missing, malformed,
foreign-file or unmapped input preserves the captured frame. Redaction is applied
after mapping so original source paths receive the same privacy treatment.

The tests include a two-source map with known coordinates and a real map produced
by Bun 1.4.3. They use `findEntry` deliberately: the pinned runtime's `findOrigin`
does not implement the documented Node one-based argument/result shape. There is
no custom resolver, new source-map dependency or invented fallback position.

## Debug endpoints

The debug-only actions (`evaluate`, `snapshot`) require the debug surface to be
enabled, the caller to be authenticated, and the build not to be a packaged production
build. A packaged production build refuses them with `diagnostics-disabled`
whatever the caller asks for.

## Unavailable capabilities

Documented explicitly: no cross-origin observation, no unapproved evaluation, no
screenshot above the bounded size, and no debug surface in a packaged production
build. A future webview adapter is not expected to pretend full CDP compatibility —
it declares the capabilities it implements, and the rest stay named errors.
