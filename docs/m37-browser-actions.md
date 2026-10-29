# M37 — portable browser actions and secure diagnostics

**Scope:** issue #37. The public browser-action contracts and the CEF adapter
are described in [Browser actions](browser-actions.md). The native adapter offers
bounded screenshot, approved evaluation, DOM and accessibility observation, and
synthetic input with document-scoped grants. Its optional development feature
requires both a loopback development origin and an explicit installed manifest
opt-in; the ordinary production profile does not advertise those actions. Raw CDP
is an internal implementation detail and no public debug endpoint is opened.

The earlier dispatcher in `browser-actions.ts` is an unexported test prototype;
its caller-supplied target and context are not native authority and it does not
describe the CEF adapter. Issue #37 remains open for its remaining criteria.

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
by Bun (version redacted). They use `findEntry` deliberately: the pinned runtime's `findOrigin`
does not implement the documented Node one-based argument/result shape. There is
no custom resolver, new source-map dependency or invented fallback position.

## Collection and unavailable capabilities

Import the collector and its types from `@bunly/runtime`. Applications explicitly
select records to collect; the collector does not automatically subscribe to Bun
errors, renderer logs, RPC, or reload events. `ServiceReloadHost` already offers
an optional `onDiagnostic` callback. Callers can adapt its event, stage and
optional detail into a `DiagnosticRecord` with `kind: 'reload-stage'` and a
selected `message`. Its local `detail` may contain sensitive application information, so callers should
select what they include and review the redacted bundle before sharing it.
Existing reload error details can be source-mapped by the reload pipeline; the
collector maps an explicitly supplied frame only when given the matching map.
`renderSourceMappedFrame` returns a raw mapped frame without redaction; use the
collector or apply appropriate redaction before sharing it.
It does not discover or read source maps.

CEF advertises `view.console` and exposes `onViewConsole(view, listener, { signal })`
for explicitly requested messages. It checks the opaque live view handle and removes
listeners on unsubscribe, abort, view close or backend shutdown. The observation
continues across navigation for that view; the native event carries only a bounded
message, not severity, source position, document or origin. It must not be used as
authority. Existing native hosts forward console messages over their private pipe even
without this subscription; the generic native observer can also receive them. The
subscription and bundle collection are opt-in, while native forwarding is not.
The mock backend returns an unsupported capability error. Messages are
raw application data; callers must select and redact them before retaining or
sharing a bundle. Console callbacks also contain thrown or rejected errors and
drop new callback invocations when 128 asynchronous results remain outstanding.

`RpcServerOptions.onDiagnostic` opts in to fixed per-handler `started` and `settled`
records with a bounded elapsed time and a fixed outcome. It contains no method,
request ID, input, output, arbitrary exception or stack. `settled` occurs only
when the handler actually releases its execution slot, including after cancellation;
`success` indicates a validated handler result submitted for delivery, not a
client receipt. Pre-admission rejections have no handler record. Callbacks are
queued outside dispatch; thrown and rejected errors are contained. A full
128-record queue or 128 outstanding asynchronous callback results drops new
observations. These are best-effort diagnostic observations, not an audit log.
`CefBackend.serveRpc` and `serveLoopbackRpc` pass this option to their servers.
Neither observer automatically adds records to the collector or opens an endpoint.

The CEF adapter's development gates, native authority checks, supported operations,
limits and qualification procedure are documented in [Browser actions](browser-actions.md).
An unimplemented adapter capability returns an explicit error. Physical input,
child-frame control and a public CDP or debug server are not provided.
