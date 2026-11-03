# GPUI native host

This binary owns the native UI event loop and GPU renderer. The Bun application
owns application state and sends commands over its private child-process pipes.
The host has no browser, web server or second JavaScript engine.

## Build and run

Framework contributors build the pinned host explicitly:

```sh
cargo build --locked -p bun-native-host
BUN_NATIVE_HOST="$PWD/target/debug/bun-native-host" \
  bun examples/native-window/main.ts
```

Normal TypeScript edits rerun Bun and reuse this binary. They do not invoke Cargo.
Production application compilation is a separate `bun compile` step; a Rust host
build does not establish Bun AOT acceptance.

Rust is pinned in the repository toolchain file. GPUI and `gpui_platform` come
from Zed revision `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`. One root Cargo
workspace and lockfile cover the protocol and renderer. The fast CI lane selects
`-p bun-native-protocol`; the native lane builds and tests the actual GPUI host.
For an optimized host, use `cargo build --locked -p bun-native-host --release`
and select `target/release/bun-native-host` explicitly.

Linux requires development libraries for fontconfig, FreeType, Wayland and
xkbcommon/X11, plus a working Vulkan device or software implementation. The
X11 acceptance harness additionally needs Xvfb, Openbox, xdotool, ImageMagick,
DBus and fonts. A software-rendered X11 window proves the native rendering/input
path; it does not qualify physical GPU performance or physical keyboard/IME.

## Ownership and protocol

All GPUI entities, windows and text mutation stay on the main thread. One input
worker parses bounded UTF-8 JSON lines; its 64-command queue applies backpressure
to the pipe. One output worker drains a 256-event queue, keeping stdout writes
off the UI thread. An unresponsive output consumer terminates the UI session
when the queue fills rather than allowing unlimited retained events.

The command consumer preserves FIFO order and yields explicitly after 16
commands or four milliseconds of elapsed turn time. It awaits GPUI's
nonzero one-millisecond background timer outside the UI update, allowing the
platform event loop to process input and paint during sustained command traffic.
A ready receive queue does not suspend an async task; draining it without this
yield previously starved native input and paint. The pipe workers remain off the
UI thread, and shutdown skips the extra yield after scheduling its final flush.

The budget is checked between complete commands. It does not preempt one atomic
batch or promise a four-millisecond response deadline. Timer resolution,
rendering work and platform scheduling affect the observed interval. The actual
[scheduling regression](../../tests/native/scheduling.ts) keeps 128 valid
requests in flight while injecting OS input and checks that input and paint
progress before the producer stops. Reports retain acknowledgement throughput
alongside responsiveness; they do not equate acknowledgements with presentation.

`bun-native-protocol` owns the [private v5 contract](../protocol/README.md).
Protocol 5 requires shared layout, interaction and window-display service
capabilities and replaces v4 outright. The
session owns up to 16 windows, each with one box root and at most 4,096 nodes.
Atomic batches create, update, reparent, reorder and delete box, text, button
and input elements. All adapters use this same model and renderer. Neither
Solid nor React introduces a second native implementation.

The service policy is immutable and default-denied. Only
`--bun-native-allow-window-display` enables the owned-window display read;
unknown or duplicate launch arguments fail before GPUI starts. The public
runtime supplies this reserved flag only from its typed permissions option.
The native session checks policy and the live window before reading GPUI
display bounds/scale. No clipboard, file, process or general service endpoint
is exposed. See [native services](../../docs/native-services.md) for precise
errors, lifecycle and pending platform qualification.

Request, window and node IDs are positive JavaScript-safe integers and increase
across the session in separate namespaces. A deleted node or closed window ID
is never reused. Failed batches leave both the model and node allocation
high-water mark unchanged. Preflight validates the complete candidate tree
before a synchronous GPUI update; it does not yield between validation and
commit. Immutable property payloads share `Arc` storage while graph links are
cloned. Opt-in batch evidence records preflight time, operations, nodes and
retained text bytes so this strategy can be measured.

The native view retains input entities by node ID. Their callbacks hold weak
model references and check that the window is active and still owns the node.
Deletion removes the entity and clears its focus. Closing revokes its model
before entity destruction. Button callbacks also check current ownership and
disabled state, including callbacks retained from the previous rendered frame.
Pointer activation and focused Enter/Space use the same event path. Enabled
buttons and inputs are native tab stops; Tab/Shift-Tab traverse the rendered
child order. Container scroll handles are retained by node ID through style
changes and reparenting, reset on the axis disabled by a scroll-mode change, and
removed with their subtree or when scrolling is disabled. GPUI clamps offsets
after viewport/content changes. See the [layout contract](../../docs/native-layout.md).

Native text changes advance only the affected input revision. Every explicit
input `set` must present its current revision, so a delayed app update cannot
overwrite newer native keystrokes. Tree revisions advance once per committed
batch; unrelated label updates are not invalidated by typing. All native UI
events share one monotonic session sequence. Text editing uses GPUI's native input-handler API,
UTF-16/UTF-8 range conversion, grapheme navigation, selection, clipboard and
composition state. The presence of those handlers is not a claim that every OS
IME, assistive technology or input method has passed testing.

Node events capture the committed root-to-target path and tree revision at
emission. Keys use GPUI's pre-keymap observer so consumed Enter/Tab/editing actions
remain observable; logical key-up uses the window's capture phase. Standalone
modifier pseudo-keystrokes are excluded. Native hit-tested pointer capture
selects the deepest visible model node before normal mouse defaults run. Focus
subscriptions are retained with each native control and revoked on removal;
duplicate transition observations are suppressed. All subscriptions filter the
owning window and hold revocable entity/model references. No Bun callback blocks
the native main thread or retroactively cancels editing. See the
[interaction contract](../../docs/native-events.md) for fields and tested limits.

GPUI uses explicit quit mode on every OS, so closing the final window cannot
race Bun's shutdown command. The actual window-close observer emits `closed`.
Shutdown revokes all models, flushes its final acknowledgement, then quits.
Malformed or oversized frames end the channel; valid commands that violate
ownership, revision, lifecycle or resource limits receive typed errors.

Input does not yet scroll horizontally when text exceeds its field.
Full input values are retained and delivered to Bun, while long visual content
clips at the window edge. Scrolling and complete text/IME/accessibility
qualification belong to BN4 #241. Native Tab navigation is implemented; focus rings, automatic scrolling to an
offscreen tab stop and platform widget accessibility semantics remain separate work.

## Evidence

The OS-input harness supplies `BUN_NATIVE_EVIDENCE_LOG` and
`BUN_NATIVE_EVIDENCE_NONCE`. With both set, a GPUI paint callback appends changed
native state as nonce-tagged `rendered` events with `stage: "native-paint"`,
window/tree revisions and complete node snapshots. Unchanged tree/input revision
states are deduplicated. Evidence records are capped at 65,536 bytes; a larger
snapshot produces an explicit `status: "omitted"` record with the reason
`evidence_record_limit`, never a partial snapshot that could satisfy an assertion.
Batch timing and actual window GPU adapter metadata are separate records.
A distinct deduplicated `layout` record captures actual logical bounds, ancestor
clip intersections, viewport/scale, retained scroll offsets and native focus
from the same paint pass. Geometry is limited to 128 model nodes; larger trees
produce explicit `layout_node_limit` omission records. No extra layout elements
are created, and geometry is not collected when evidence is disabled.
The Bun fixture separately records delivered native input and application state.
Paint traversal alone is not display presentation: the harness must also capture
the actual window and correlate OS input with the expected painted state.
Instrumentation performs bounded serialization and file I/O on the UI thread;
performance reports must distinguish instrumentation enabled from disabled.

Headless protocol tests, successful compilation, X11 software rendering and
physical native GUI verification are distinct evidence levels. Consult the PR
and repository testing documentation for the checks actually executed.

## Source attribution

The editable-input implementation is adapted from the pinned GPUI example and
retains its Apache-2.0 provenance in `NOTICE` and `LICENSE-APACHE`. Bun Native adds
bounded values, IPC events, command-driven state and separates painting from
editing. Other host code is covered by the repository MIT license.
