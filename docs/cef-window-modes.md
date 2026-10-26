# Native CEF window-mode prerequisite

This extension advances #27. It does not close #27/M5 or qualify terminal load.
It is deliberately on `CefBackend`, with no new `BrowserBackend` capability.

```ts
const before = await backend.windowState(window)
const immediate = await backend.minimizeWindow(window, { signal })
const restored = await backend.restoreWindow(window, { signal })
await backend.showWindow(window, false) // existing hide operation
await backend.showWindow(window, true)  // existing show operation
```

Each state is a frozen, strictly validated object of booleans: `visible`, `active`,
`minimized`, `maximized`, `fullscreen`. These are actual CEF Views getters on the
UI thread. An invisible window is not necessarily minimized; an inactive window
can be visible. Native visibility is not page visibility or evidence of physical
presentation, focus, occlusion, or foreground interaction. On the first local macOS
checkpoint the visible window was **inactive**; the final committed-source run
was active while visible. Neither establishes foreground load acceptance.

`minimizeWindow` and `restoreWindow` return immediate readback after requesting the
action. CEF's void action return is not evidence that an asynchronous OS transition
completed. `restoreWindow` invokes CEF Restore (minimized/maximized state); it is
not a substitute for `showWindow(true)` after hide. A subsequent `windowState`
reads current state without caching intent. The caller must independently await
its required transition within a finite deadline. No runtime polling is added.

Handles must be the exact live opaque object from this backend. Forged, foreign,
wrong-kind, closing and disposed handles fail, including a close racing readback.
The private inherited-pipe request carries only a native registry lookup ID. The
UI owner revalidates its live window before and after an action. No page PID,
platform handle, script expression, or portable capability is introduced. These
operations use existing ordinary-request quotas and transport deadlines.
Cancellation rejects the wait, does not promise to undo an already dispatched
native action, and retains the request reservation until native acknowledgment
or the original deadline. Native shutdown deadlines are unchanged.

## Native API provenance

The pinned cef-rs `a46b48c6221f99414a5c6b37ff86491772f9b0a2` generated bindings
were checked for macOS arm64/x64, Linux arm64/x64, and Windows arm64/x64:
`minimize(&self)` / `restore(&self)` return unit; `is_visible`, `is_active`,
`is_minimized`, `is_maximized`, `is_fullscreen`, `is_closed`, `is_valid` return
`c_int`. The inherited view getter and window getters are used directly.
`can_minimize(&self, Option<&mut Window>) -> c_int` is explicitly enabled;
the generated Rust default returns zero.

CEF 156.0.7's installed `include/views/cef_window{,_delegate}.h` documents
activation, bounds, closing and fullscreen callbacks, but no general minimized
completion callback. The qualifier therefore waits on the separate renderer
visibility event and then reads the native state once. It never infers minimized
from an activation or bounds callback. See the
[CEF window delegate contract](https://cef-builds.spotifycdn.com/docs/154.0/classCefWindowDelegate.html)
for callback semantics; the local pinned headers/bindings, not the online version,
are the build authority. No upstream implementation was copied.

## Functional qualifier and integration

```sh
bun run qualify:cef-window-modes -- /absolute/path/to/current-source-prepared-app
```

The caller builds the current native host/helper separately. This command never
compiles native code. It copies the prepared artifact into a unique private run,
bundles the fixed fixture and its current bootstrap/runtime code, writes asset
hashes, and ad-hoc signs only its private macOS copy using the existing helper.
Input and prepared inventories plus before/after source fingerprints and exported
CEF version evidence are retained. Do not supply an old executable and use current
TypeScript hashes to claim a new native implementation was tested.

One sequence exercises visible → hidden → shown → minimized → restored. The
fixed packaged page reports initial `document.visibilityState` and subsequent
`visibilitychange` callbacks through the existing native-authorized RPC binding.
The backend verifies exact view ownership and sequence, then reads native state.
There is one 10-second sequence deadline, no polling/sleeps, no retry-to-green,
no disabled background throttling and no Chromium flag changes. Unsupported or
missing state/visibility events fail qualification; they never become a pass.
The action receipts are retained separately from the fresh state observations.
The acceptance parser requires all five states, independent page correlation,
normal backend exit, empty output reservations, ordered native shutdown and
observed process cleanup. Every failed run remains in `.bunly/m5/window-modes`.

The load integration can use these exact runtime methods on its already-owned
window, retain the immediate action receipt, await its own page-visibility gate,
and call `windowState` before accepting load in that mode. Keep hidden and
minimized separate. Do not label the inactive visible checkpoint foreground.
This fixture has no terminal workload and does not alter #115's 32-KiB/eight-chunk
budgets, scheduler, observer, or the parallel load fixture.

## Disposable Linux window manager

Xvfb supplies an X server, not a window manager. CEF delegates minimize/restore
to Chromium's native widget. Bare Xvfb is insufficient evidence that a real
managed desktop cannot minimize. The existing hosted full suite uses bare Xvfb;
it has not executed this new prerequisite. Linux remains **not executed**, not
an unsupported platform claim.

For this qualifier only, provision `xvfb` and `openbox` in the disposable runner
image (for example `sudo apt-get install -y xvfb openbox` during runner setup),
then run as the ordinary non-root test user:

```sh
python scripts/qualify-cef-window-modes-linux.py --disposable-runner \
  --bun /absolute/pinned/bun /absolute/current-source/bunly_host
```

The wrapper owns a fresh Xvfb display and Openbox process, uses `-displayfd` and
Openbox's startup hook for finite readiness rather than sleeps, creates a private
minimal WM config, and tears down only its recorded process groups. Logs and
cleanup status are retained. Missing packages/readiness fail explicitly. It does
not attach to an existing desktop, install a service, modify global settings,
disable sandboxing, or make an ordinary Bunly app depend on Openbox. The wrapper
itself still needs actual Linux execution; static/unit checks are not that gate.

## Local committed-source checkpoint

[Retained evidence](../evidence/m5-window-modes-local.json) binds implementation
`288d34f755d82f1c6db9524c42fc3a54398e03a0` to a clean-source macOS arm64 native
run, unchanged input/prepared inventories, built host/helper hashes and the
unchanged retained CEF framework. All five native states and page visibility
receipts passed, with zero pending/delivery reservations, normal backend exit,
ordered shutdown and no surviving owned processes. Notably, Restore immediately
returned `minimized: true`; the subsequent visibility callback and native readback
proved `visible: true, minimized: false`. The earlier preparation failure and
dirty-source checkpoint remain fingerprinted. This evidence does not replace
current integration-head Linux/Windows execution or combined #27 load acceptance.
