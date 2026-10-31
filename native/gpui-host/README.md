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

`bun-native-protocol` owns the wire schema and limits: 65,536 bytes per JSON
payload, JavaScript-safe positive request IDs, 256-byte titles and 16,384-byte
text values. The session requires protocol-1 `hello` before opening one window.
Hello responds with `ready` and `ack`; `open` with `opened`; updates and close
with `ack`. The actual window-close observer emits `closed`. Closing permits a
subsequent open. GPUI uses explicit quit mode on every OS, so closing its final
window cannot race Bun's shutdown command. Shutdown flushes its final
acknowledgement before quitting.
Malformed or oversized frames end the channel; valid commands in an invalid
state receive typed errors.

The initial window contains a Bun-controlled label, pointer-activated button and
editable native input. Text editing uses GPUI's native input-handler API,
UTF-16/UTF-8 range conversion, grapheme navigation, selection, clipboard and
composition state. The presence of those handlers is not a claim that every OS
IME, assistive technology or input method has passed testing.

The BN0 input does not yet scroll horizontally when text exceeds its field.
Full input values are retained and delivered to Bun, while long visual content
clips at the window edge. Scrolling and complete text/IME/accessibility
qualification belong to BN4 #241. Native input events must not be echoed as
unversioned value replacements: a delayed echo can overwrite newer keystrokes;
BN1 #228 owns the revision contract for controlled inputs.

## Evidence

The OS-input harness supplies `BUN_NATIVE_EVIDENCE_LOG` and
`BUN_NATIVE_EVIDENCE_NONCE`. With both set, a GPUI paint callback appends changed
native state as nonce-tagged `rendered` events with `stage: "native-paint"`.
The Bun fixture separately records delivered native input and application state.
Paint traversal alone is not display presentation: the harness must also capture
the actual window and correlate OS input with the expected painted state.

Headless protocol tests, successful compilation, X11 software rendering and
physical native GUI verification are distinct evidence levels. Consult the PR
and repository testing documentation for the checks actually executed.

## Source attribution

The editable-input implementation is adapted from the pinned GPUI example and
retains its Apache-2.0 provenance in `NOTICE` and `LICENSE-APACHE`. Bun Native adds
bounded values, IPC events, command-driven state and separates painting from
editing. Other host code is covered by the repository MIT license.
