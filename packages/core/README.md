# @bun-native/core

The experimental TypeScript and JavaScript API for one owned Bun Native application. It creates native windows and a small shared element tree through the prebuilt Rust GPUI host. It provides owned handles, atomic updates, input revisions and cancellable application listeners.

This workspace package is private at version `0.0.0`; it is not a published stable SDK. SolidJS and React adapters are future consumers of this same API. Neither adapter is implemented by this package.

## Run a consumer

Use the exact Bun toolchain from [the repository instructions](../../docs/toolchain.md) and an already built native host for the target machine. Application edits do not invoke Cargo. In a repository checkout:

```sh
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" bun examples/native-window/main.ts
```

The explicit executable path is trusted configuration. A successful handshake checks protocol compatibility; it does not authenticate an arbitrary executable. `app.capabilities` is a frozen, readonly list containing the required `tree`, `input_revisions`, `layout_v1`, `interactions_v1` and `window_display_v1` features. Launch fails if the host cannot negotiate all five. Feature availability does not grant OS-service authority; see [the trust boundary](../../docs/decisions/0003-bridge-security.md).

```ts
import { createApplication } from "@bun-native/core";

const executable = process.env["BUN_NATIVE_HOST"];
if (!executable) throw new Error("Set an absolute BUN_NATIVE_HOST path");

const app = await createApplication({ executable });
try {
  const window = await app.openWindow({
    title: "Counter",
    width: 560,
    height: 380,
  });
  const { label, button } = await window.batch((batch) => {
    batch.set(window.root, {
      kind: "box",
      style: { direction: "column", gap: 12, padding: 24 },
    });
    const label = batch.create({ kind: "text", text: "Clicks: 0" });
    const button = batch.create({ kind: "button", text: "Increment" });
    batch.append(window.root, label);
    batch.append(window.root, button);
    return { label, button };
  });
  let clicks = 0;
  window.onClick(button, async (event) => {
    if (event.signal.aborted) return;
    clicks += 1;
    await window.batch((batch) =>
      batch.set(label, { kind: "text", text: `Clicks: ${clicks}` }),
    );
  });
  await window.closed;
} finally {
  await app.shutdown();
  await app.closed;
}
```

Plain JavaScript uses the same imports and runtime checks. Add `// @ts-check` and JSDoc types for editor and compiler checking; see [the JavaScript consumer](../../tests/native/javascript.js). [The compile-only TypeScript fixture](../../tests/types/public-api.ts) records accepted calls and rejected type combinations.

## Handles and tree operations

`NativeNode<'box' | 'text' | 'button' | 'input'>` is an opaque identity. Its `kind` is readable, but copying the object does not create another usable handle. Each node belongs to one window and one application session. Passing a foreign, forged or disposed handle fails at runtime, including from JavaScript. Native IDs, request IDs, process streams and GPUI objects are not part of this API.

Every window starts with a root box. Create and attach new elements in the same batch. A committed tree cannot contain unattached nodes or cycles. Only boxes own children; closing the window disposes its root.

| Operation                             | Contract                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `batch.create(element)`               | Creates a typed handle in the candidate tree. Return it from the callback and use it after the batch promise succeeds. |
| `batch.set(node, element)`            | Replaces all properties of the same element kind. Omitted optional properties return to their defaults.                |
| `batch.set(input, element, revision)` | Replaces input properties using its current observed edit revision.                                                    |
| `batch.append(parent, child)`         | Attaches or moves a child to the end of a box.                                                                         |
| `batch.insert(parent, child, index)`  | Attaches or reorders a child; the index is evaluated after detaching it from its old position.                         |
| `batch.remove(node)`                  | Deletes the entire subtree. Its handles and listeners are revoked after successful commit.                             |

`window.batch` callbacks must be synchronous. Their native work is committed atomically, and the returned promise resolves after the native acknowledgement. Fetch or compute asynchronous data before entering the callback. Retaining a `NativeBatch` and using it after the callback returns is an error. If validation or native preflight rejects a batch, its mutations do not commit; escaped handles created by that failed batch are unusable.

Transactions from all windows are serialized in submission order. At most 128 application transactions may be pending, with reserved capacity for closing live windows. The negotiated `app.limits` bound windows, nodes, operations, text, depth and frame size. A batch acknowledgement confirms committed native state; it does not establish when a frame reached the display.

## Input state and callbacks

`window.input(input)` returns an immutable `{ value, revision }` snapshot. Native edits advance that input's revision independently of `window.revision`. Unrelated label updates therefore do not race merely because someone is typing.

To replace an input intentionally, read its revision inside the synchronous batch callback and supply the complete new input properties:

```ts
await window.batch((batch) => {
  const current = window.input(input);
  batch.set(
    input,
    { kind: "input", value: "Replacement", placeholder: "Type here" },
    current.revision,
  );
});
```

The native side rejects a replacement if a newer edit wins the race before commit. Handle that stale-revision error according to the application's intent; do not retry blindly with an old value. An accepted explicit replacement advances the input revision even if its text is unchanged. An input callback already describes a native edit: update application state without echoing the same text back into the native input.

## Shared native events

`window.on(node, type, listener, { capture?: boolean })` registers one binding for that node, event type and phase. It accepts any owned node, including an ancestor box. A new binding replaces the previous binding in that exact slot; it does not replace another event type or phase. The returned unsubscribe is idempotent and cannot remove a replacement. `onClick(button, listener)` and `onInput(input, listener)` are target-specific bubble conveniences using the same registry.

```ts
window.on(
  window.root,
  "key_down",
  (event) => {
    console.log(event.key, event.modifiers.control, event.phase);
  },
  { capture: true },
);

window.on(button, "pointer_up", (event) => {
  console.log(event.button, event.x, event.y);
});
```

| Type                         | Additional fields                      | Meaning                                                                  |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `click`                      | None                                   | Native button activation, including pointer or keyboard activation.      |
| `input`                      | `value`, `revision`                    | Committed native edit; the input snapshot is updated before callbacks.   |
| `key_down`, `key_up`         | `key`, optional `keyChar`, `modifiers` | GPUI logical key/text, including keys used by native actions.            |
| `pointer_down`, `pointer_up` | `button`, `x`, `y`, `modifiers`        | Native hit-tested pointer target; coordinates are window logical pixels. |
| `focus`, `blur`              | None                                   | Retained native focus changed.                                           |

Every event exposes immutable `node` (the native target), `currentTarget`, `path`, `phase`, `treeRevision` and `sequence`. The path is the native committed ancestry at input, root first and target last. `phase` is `capture`, `target` or `bubble`; both target registrations use `target`. Modifiers are a frozen record of `control`, `alt`, `shift`, `platform` and `function`. The API does not fabricate physical key codes or repeat metadata that the current native interception path cannot observe. `keyChar` is optional logical text, not a committed input or IME notification. The current contract does not emit pointer movement/coalescing or scrolling events.

Callbacks run in capture order from root to target, then bubble from target to root. The registration identities and native path are captured when the core ingests an event. A queued event therefore keeps its original route after a keyed move; a new registration does not receive earlier events. Each invocation rechecks revocation. Deleted ancestors are skipped, a deleted target cancels the event, and a disposed handle in an older captured path does not regain authority. Malformed routes, foreign owners, impossible future revisions and invalid input revisions fail the session.

`event.stopPropagation()` prevents delivery to later nodes. At the target it still permits the target's other phase. `event.stopImmediatePropagation()` also stops that remaining target delivery. These controls are effective only while that listener is executing, including while its returned promise is pending. Retaining an event and calling its control methods after that invocation settles has no effect. The controls affect JavaScript dispatch only: native focus, editing and button actions may already have happened across the subprocess boundary. There is no misleading asynchronous `preventDefault` API. GPUI focus notifications follow its rendered-focus phase and may arrive after click; DOM pointer/focus ordering is not promised.

Application callbacks run one at a time in native global event order, across windows. The pending queue is bounded at 128 events, separate from the active dispatch. Each route contains at most 65 nodes, with one capture and one bubble binding per node/type. Overflow fails the session instead of growing memory indefinitely. A callback failure is observed through application shutdown/completion. Sequence numbers count all native UI events, so click-only or input-only listeners can legitimately observe gaps; count activations separately and use input revisions for edit ordering.

Native ingestion is independent of waiting for listener promises. Input snapshots and OS-close events continue to update across windows while an asynchronous listener waits. This does not make synchronous CPU-heavy JavaScript nonblocking: that still blocks Bun's event loop.

Every invocation carries the binding's `event.signal`. Unsubscribe, replacement, deletion of the registered node, window close and application shutdown abort that registration, discard its queued deliveries and release dispatch from an unresolved listener. Deleting an event's target also releases a waiting ancestor callback without revoking that still-live ancestor registration or changing its signal. Use the signal for cancellable work and validate delayed application intent before committing it. Cancellation does not forcibly terminate an arbitrary promise or undo application side effects.

## Lifetime and errors

`window.close()` is idempotent and revokes listeners immediately before its serialized native close. OS close also revokes the window. `window.closed` observes that local lifetime ending; the application owns the host process until shutdown.

`app.shutdown()` is idempotent and can be awaited inside a listener. Await `app.closed` outside that listener to join event ingestion and callback dispatch without a self-deadlock. Normal shutdown clears all seven `app.diagnostics` counters: windows, nodes, callbacks, queued transactions, queued callbacks, active callbacks and service requests. These counters describe owned JavaScript resources; they are not a native memory-leak measurement.

The public package exports the error classes needed to distinguish failures:

| Error                     | Meaning                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NativeStateError`        | Invalid local handles/state, stale input revisions or public queue/model limits; inspect `code`.                                |
| `NativeCommandError`      | A native semantic rejection; inspect its native `code`.                                                                         |
| `NativeHostExitError`     | The native host exited unexpectedly; `diagnostic` is a bounded, redacted exit record (see the qualification matrix).            |
| `ProtocolError`           | A malformed value or broken protocol/channel invariant. Malformed received messages and invalid native events fail the session. |
| `UnsupportedFeatureError` | An unknown native element kind; `feature` is `element:` followed by that kind. It does not trigger a fallback renderer.         |

Protocol incompatibility prevents launch. Recreating an application creates a new session; old handles never become valid in it. An unsupported field within a known element or style is a validation error, not an accepted extension point.

## Owned native services

`window.displaySnapshot({ signal? })` returns deeply frozen native display
`bounds` and the owning window's `scaleFactor`. Launch with
`permissions: { windowDisplay: 'allow' }` to allow it; the default is `deny`.
The Rust host independently checks that immutable policy and the live window.
No per-request option or protocol message can grant access. Both framework
adapters use this same public window method.

`app.serviceCapabilities.windowDisplay` reports implementation availability,
the negotiated permission and `owned_window` scope. The system menu and message
dialog entries explicitly report `unavailable` / `not_implemented`; they have no
placeholder callable methods. Clipboard, global shortcut, file dialog,
notification, drag/drop, filesystem-grant and PTY/process entries report
`available` only when the host negotiates their capability, and `unavailable` /
`unsupported_platform` otherwise. This policy constrains the selected native
host, not trusted Bun code's ordinary OS APIs.

An aborted queued read sends no native command. After submission, cancellation
drains and validates the native response before suppressing delivery. It does
not interrupt synchronous native work. Window/application close revokes result
delivery and prevents new reads. `NativeServiceError` distinguishes
`permission_denied`, `service_unavailable` and `cancelled`, with
`service: 'window_display'`; ordinary ownership and protocol errors remain
distinct. See the [service contract](../../docs/native-services.md) for exact
geometry semantics, error scope and platform qualification. In particular,
the pinned X11 backend reports an X screen, not a physical monitor identity.

### Clipboard text

`window.readClipboardText({ signal? })` returns a frozen `{ kind: 'empty' }`
when no selection owner exists, or `{ kind: 'text', text }` including a valid
empty string. `window.writeClipboardText(text)` requires a separate write
grant. Launch permissions are `clipboardRead` and `clipboardWrite`, each
`allow` or `deny` with default `deny`. On the implemented local Linux X11
backend, `app.serviceCapabilities.clipboardText` reports `available`, both
permissions, `owned_window` scope and backend `x11`. Other targets/backends
report `unavailable` / `unsupported_platform`.

The current payload bound is 8,192 UTF-8 bytes without NUL. Transfers have their
own eight-request queue and a two-second total native deadline, so waiting for
clipboard data does not serialize unrelated tree commits. Read cancellation
before dispatch sends no request; after dispatch it suppresses delivery after
the bounded native reply is drained and validated. Close/shutdown revokes
pending authority. A submitted write has no cancellation option or rollback
promise: a completed copy remains selected until replaced or the host exits.
A write acknowledgement confirms native selection ownership; independent
readers, not cached self-reads, qualify the native transfer.

Clipboard `NativeServiceError.service` is `clipboard_read` or `clipboard_write`.
Its codes distinguish denial, unavailable backend/text format, cancelled read,
total transfer timeout, excessive external payload and native failure. Local
queue saturation and stale handles retain their ordinary `NativeStateError`;
malformed native replies retain `ProtocolError`. The native worker is joined
before shutdown completes. `app.diagnostics.serviceRequests` exposes the
bounded count. See [the full service contract](../../docs/native-services.md).
The [Native Linux workflow](../../.github/workflows/native-linux.yml) exercises
the clipboard against an independent owned X11 peer in development and
inspected AOT; this does not qualify Wayland, macOS or Windows.

### Global shortcuts

```ts
const app = await createApplication({
  executable,
  permissions: { globalShortcuts: "allow" },
});
const window = await app.openWindow({ title: "Launcher" });
const shortcut = await window.registerGlobalShortcut(
  { key: "k", control: true, alt: true },
  (event) => console.log("activated", event.sequence),
);
// Later: delivery stops at once; the promise resolves after the OS release.
await shortcut.unregister();
```

`window.registerGlobalShortcut(options, listener)` registers an OS-wide
combination that activates even while another window or application is
focused. `key` is one of `a`-`z`, `0`-`9` or `f1`-`f12`; `control`, `alt`,
`shift` and `platform` (Super) default to `false`, and at least one of control,
alt or platform is required. Anything else rejects with `TypeError` before a
native request. The `globalShortcuts` launch permission defaults to `deny`.
On a local Linux X11 session `app.serviceCapabilities.globalShortcuts` reports
`available`, the permission, `owned_window` scope and backend `x11`; other
targets report `unavailable` / `unsupported_platform`.

The returned frozen `NativeGlobalShortcut` exposes `key`, `modifiers`, `active`
and an idempotent `unregister()`. Unregistration, owner window close and
application shutdown revoke the handle synchronously and abort the
`event.signal` passed to its listener; no later activation is delivered.
Listeners run on the same serialized callback queue as UI listeners. A
combination already grabbed by another X11 client, or already registered by
this application, rejects with `NativeServiceError` code `conflict` and
`service: 'global_shortcuts'`; denial, unavailable keys/modifiers and native
failure have their own codes. At most 16 registrations exist per application.
See [ADR 0008](../../docs/decisions/0008-native-global-shortcuts.md).

### Notifications

```ts
const app = await createApplication({
  executable,
  permissions: { notifications: "allow" },
});
const window = await app.openWindow({ title: "Builds" });
const notification = await window.postNotification(
  { title: "Build finished", body: "All tests passed" },
  (event) => {
    if (event.type === "notification_activated")
      window.root; /* focus your UI */
    else console.log("dismissed", event.reason);
  },
);
// Later: delivery stops at once; the promise resolves after the server closes it.
await notification.withdraw();
```

`window.postNotification(options, listener)` posts a plain-text desktop
notification owned by the window. `title` is one nonempty line of at most 256
UTF-8 bytes; the optional `body` is at most 2048 bytes and may contain line
feeds but no other control characters. Neither is interpreted as markup, and
there are no action strings, URLs or commands: activation is a typed event.
The `notifications` launch permission defaults to `deny`. On Linux with a D-Bus
session bus `app.serviceCapabilities.notifications` reports `available`, the
permission, `owned_window` scope and backend `freedesktop`; other targets report
`unavailable` / `unsupported_platform`. A bus without a running notification
server rejects with `NativeServiceError` code `service_unavailable`.

The frozen `NativeNotification` exposes `title`, `body`, `activatable` (false
when the server offers no actions), `active` and an idempotent `withdraw()`.
The listener receives `notification_activated` events and at most one final
`notification_dismissed` event (`expired`, `dismissed` or `closed`) when the
server removes it first. Withdrawal, owner window close and application
shutdown revoke the handle synchronously, abort `event.signal` and close the
notification on the server; none outlives its window. At most 32 notifications
are live per application. See
[ADR 0009](../../docs/decisions/0009-native-notifications.md).

### Filesystem grants

```ts
const app = await createApplication({
  executable,
  permissions: {
    filesystemRoots: [
      { id: "workspace", path: "/home/me/project", access: "read_write" },
    ],
  },
});
const window = await app.openWindow({ title: "Workspace" });
const grant = await window.openFileGrant("workspace", { access: "read_write" });
await grant.write("notes/today.md", new TextEncoder().encode("# Today\n"), {
  mode: "truncate",
});
const { bytes } = await grant.read("notes/today.md");
await grant.close();
```

`window.openFileGrant(root, { access })` opens a scoped grant on a directory
named in the immutable `filesystemRoots` launch permission, at no more than its
launch access (default `read`). Paths are relative `/`-joined names; `..`,
absolute paths and empty or control-character names are rejected before any
native request, and the host resolves every path beneath the granted
directory without following symbolic links: Linux with `openat2`, macOS one
name at a time with `openat(O_NOFOLLOW | O_NOFOLLOW_ANY)`. The frozen
`NativeFileGrant` offers `stat`, `list` (pages of 64), `read` and `write`
(16 KiB chunks), `createDirectory`, `remove` and an idempotent `close()`.
Closing the grant, its window or the application revokes it and withholds
late results. Windows and other targets report `unavailable` /
`unsupported_platform`.
See the [service contract](../../docs/native-services.md#filesystem-grants).

### Owned processes

```ts
const app = await createApplication({
  executable,
  permissions: { processes: [{ id: 'git', executable: '/usr/bin/git' }] },
})
const window = await app.openWindow({ title: 'Status' })
const child = await window.spawnProcess(
  'git',
  { args: ['status', '--short'], env: { PATH: '/usr/bin:/bin' } },
  (event) => {
    if (event.type === 'process_output') console.log(new TextDecoder().decode(event.bytes))
    else console.log('exit', event.exit)
  }
)
```

`window.spawnProcess(id, options, listener)` starts an executable named in the
immutable `processes` launch permission. Arguments are an explicit array and
`env` is the complete environment; there is no shell or command string. A
working directory comes only from a live file grant of the same window, and
`terminal: { columns, rows }` runs the child on its own pseudo-terminal. Output
arrives in order in chunks of at most 16 KiB, each acknowledged when its
callback settles, and the exit event is always last. The frozen
`NativeProcess` offers `write`, `closeInput`, `resize`, `signal` (to the whole
process group) and an idempotent `release()`. Releasing it, closing its window
or stopping the application kills and reaps its group. Other targets report
`unavailable` / `unsupported_platform`. See the
[service contract](../../docs/native-services.md#owned-processes).

### File dialogs

```ts
const app = await createApplication({
  executable,
  permissions: { fileDialogs: "allow" },
});
const window = await app.openWindow({ title: "Editor" });
const controller = new AbortController();
const opened = await window.showOpenDialog(
  {
    title: "Open",
    select: "files",
    filters: [{ name: "Text", patterns: ["*.txt"] }],
  },
  { signal: controller.signal },
);
if (opened.kind === "selected") console.log(opened.paths);
const saved = await window.showSaveDialog({
  title: "Save as",
  name: "notes.txt",
});
if (saved.kind === "selected") console.log(saved.path);
```

`window.showOpenDialog(options, { signal })` (`select`: `file`, `files` or
`directory`) and `window.showSaveDialog(options, { signal })` show the
operating system's file chooser, owned by the window. The `fileDialogs` launch
permission defaults to `deny`. On Linux with a D-Bus session bus
`app.serviceCapabilities.fileDialogs` reports `available`, the permission,
`owned_window` scope and backend `xdg_desktop_portal`; other targets report
`unavailable` / `unsupported_platform`. A missing portal rejects with
`NativeServiceError` code `service_unavailable`.

Results are frozen `{ kind: 'selected', paths }` / `{ kind: 'selected', path }`
or `{ kind: 'cancelled' }`. **The paths are data, not filesystem authority**:
nothing is opened, created or granted, and turning a path into a scoped grant
is a separate operation. A window has at most one file dialog. Aborting the
signal, closing the window or shutting down closes the OS dialog. See
[ADR 0013](../../docs/decisions/0013-native-file-dialogs.md).

## Supported scope

The elements are `box`, `text`, `button`, single-line `input` and, when the host advertises `split_v1`, a two-pane `split` with a host-owned draggable divider. `Style` explicitly supports `direction`, `gap`, `padding`, `width`, `height`, `min_width`, `max_width`, `min_height`, `max_height`, `flex_grow`, `flex_shrink`, `align_items`, `justify_content`, `overflow`, `background`, `color` and `font_size`, plus `border_width`, `border_color`, `corner_radius`, `opacity` and `font_weight` when the host advertises `style_decoration_v1`. `defineTheme` and `defaultTheme` resolve named color, spacing, radius and font-size tokens to these plain values in JavaScript. Dimensions are numeric logical native pixels, with `fill` available for width and height; colors are unsigned 24-bit RGB values. These fields are validated and bounded by the [shared layout contract](../../docs/native-layout.md). Scroll overflow is accepted only for `box` and `overlay` containers; leaf element types also enforce this restriction. Hosts advertising `overlays_v1` accept the `overlay` container and `scroll_anchor_v1` the `scroll_anchor` style field; `onDismiss(window, overlay, listener)` reports Escape and backdrop presses. See the [overlay contract](../../docs/native-overlays.md). Styles are shared by every framework adapter.

There is no DOM, HTML, CSS parser, browser navigation, WebView, CEF, React DOM or automatic compatibility with web component libraries. Native service APIs for menus, dialogs, drag/drop and other desktop integrations remain separate roadmap work. The current renderer does not claim complete scrolling, IME, focus traversal or accessibility coverage. See [the native host limitations](../../native/gpui-host/README.md) and [testing evidence](../../docs/testing.md) before treating a platform as supported.

Protocol 11 requires shared layout, interactions and immutable service policy and replaces earlier protocols without a compatibility layer. During this private experimental phase, pin the application packages and native host together at the tested source revision. A package build or type check is not native GUI acceptance; a bundled executable is not proof of Bun machine-code AOT. [ADR 0004](../../docs/decisions/0004-public-api.md) records the API boundary and its tradeoffs.
