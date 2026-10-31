# Shared framework renderer

`@bun-native/renderer` is a private adapter implementation package over the public
`@bun-native/core` API. It contains no framework runtime, DOM or native widget
implementation. Solid and React use the same staged nodes, native diff, input
revision rules and lifetime machinery.

The implementation was extracted from the tested Solid adapter when the React
adapter became its second consumer. Framework-specific owner/effect/reconciler
scheduling remains in the adapters.

## Ownership and commits

`createRenderRoot(window, initialize)` owns one independently disposable native
subtree. `initialize` receives its staged `container`, an `onCleanup` registration
and a terminal `fail` callback. Register framework cleanup before evaluating user
components, so an initialization failure can dispose already-created owners.
Asynchronous framework failures call `fail`; it cannot restart a disposed root.

The driver snapshots staged values before awaiting the public-core queue. Only
one native transaction is in flight per root; further changes coalesce into a
subsequent snapshot. Native handles and listener changes are published only after
acknowledgement. A retained keyed sibling subsequence minimizes native moves;
retained descendants are rescued before an obsolete ancestor is deleted.

Every root has `ready`, `closed`, `flush()`, `dispose()` and diagnostics for native
mutations, commits, nodes and listeners. `ready` requires an actual native
acknowledgement; framework adapters must also ensure their initial render has
committed to the staged tree. `flush()` joins currently staged native work. It does
not promise that an asynchronous framework render or a GPU presentation finished.

Unmount revokes callbacks, invokes framework teardown and removes only this
root's subtree. Window close uses the same teardown and removes the completion
observer. An acknowledgement received after close cannot republish handles. The
window completion observer is shared across repeated roots and does not retain
each unmounted root until the window closes.

## Input and events

An initial string input value is permitted. Replacing it later requires an
explicit `{ value, revision }` intent from an observed native state. The captured
revision is never upgraded while waiting for an acknowledgement. Actual native
input events are recognized as observations, so storing an event in framework
state does not echo its value back into the native widget. A copied input state is
an explicit replacement intent and retains its original revision.

Both adapters use the same public-core callbacks and abort signals. Detachment
revokes a registration immediately; changing a callback cannot deliver stale
queued work to its replacement. No OS or service permission is introduced by a
staged node or renderer reference.

`eventProperties` is the shared, immutable mapping from framework property names
to public core event types and capture phases. `EventHandlers` derives each
callback argument from the corresponding `NativeEventMap` member. It covers
`onClick`, `onInput`, `onKeyDown`, `onKeyUp`, `onPointerDown`, `onPointerUp`,
`onFocus` and `onBlur`, plus each property's `Capture` variant. Native boxes can
observe descendant events; handlers are not restricted to button/input leaves.
Private text literals cannot own native registrations.

The shared driver reconciles each node/type/phase registration independently
after native acknowledgement. It passes that registration to `window.on`; the
public core alone captures and validates native ancestry, freezes queued routes,
orders capture/target/bubble callbacks, and applies propagation stops. No adapter
reconstructs a route from its current staged tree. A move preserves the original
queued route; deleting its target or revoking a registration cancels its remaining
authority. Callback replacement never redirects old queued work to a new function.

Input observations are branded before every input callback, including ancestor
capture/bubble callbacks. Passing an actual event back into framework state
therefore remains an observation at every phase. This does not upgrade the
revision of an independently captured value intent.

Propagation stops affect JavaScript dispatch only. They do not cancel native
focus, editing or activation that has already occurred. There is no asynchronous
`preventDefault` contract, DOM synthetic event, physical key code, repeat flag or
continuous pointer-move stream. Framework-specific stable callback wrappers and
event scheduling remain the adapters' responsibility.

## Verification scope

The shared ordering tests enumerate every four-item permutation. Adapter tests
exercise this package over actual public-core IPC to an explicitly headless peer;
they do not claim rendering. Real native fixtures and inspected AOT executions
provide separate acceptance evidence.
