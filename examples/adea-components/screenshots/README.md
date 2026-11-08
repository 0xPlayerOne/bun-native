# Native screenshots

These are a manual local record of the Adea component port running on the real GPUI host. They are not CI evidence: the headless contract test is ([`tests/examples/adea-components.test.ts`](../../../tests/examples/adea-components.test.ts)).

| File               | State                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `01-initial.png`   | Light theme on mount: the header menu trigger, every Button variant, two rows, the composer     |
| `03-streamed.png`  | After typing "Port the composer" and pressing Send: the seven-token reply has streamed in       |
| `04-dark.png`      | After the theme switch: the same rows (no remount) in the dark tokens                           |
| `06-menu-down.png` | The conversation menu open, focus moved by Down to Delete (Rename is disabled)                  |
| `08-dialog.png`    | End then Return chose Delete from the menu, opening the modal Dialog with Close, Cancel, Delete |

## Environment

- Host: `bun-native-host` release build (`cargo build --release -p bun-native-host`) from `main` at `139b180`.
- Bun `1.4.4-canary.1+b1007f117` (the repository pin, from `node scripts/install-bun.mjs`).
- Ubuntu 24.04 container, Xvfb 900×620 window at scale factor 1, openbox window manager, Mesa llvmpipe (LLVM 20.1.2, software Vulkan), so colors are sRGB but antialiasing is the software renderer's.
- Input is real X input (XTest through `xdotool`), not synthetic protocol events.

## Commands

```sh
bun scripts/solid-build.ts examples/adea-components/main.tsx "$PWD/.bun-native/adea-components"
xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- \
  bash scripts/quality/native-linux-session.sh /tmp/adea-session -- bash capture.sh
```

`capture.sh` started the application with `BUN_NATIVE_HOST` and `BUN_NATIVE_EVIDENCE_LOG` set, moved the window to the origin, and captured the root window with ImageMagick `import` after each step:

1. Click the input, type "Port the composer", click Send, wait for the reply.
2. Click "Dark theme".
3. Click "Conversation", press Down; press Escape (the menu closes and focus returns to the trigger).
4. Click "Conversation", press End then Return (Delete opens the Dialog); press Escape (the Dialog closes).
5. Alt+F4.

The evidence log from that run records, in order: renderer `llvmpipe`; `mounted` with 2 rows; `sent`; one batch that created the two new rows, then six single-operation batches (a text `set` per reply version, no node created); `reply-complete` with 4 rows and 0 disposed, followed by a three-operation batch; `theme` dark; the menu overlay opening twice with native focus moving between items; `menu` Delete; `dialog-dismissed`; `native_close_requested`, `native_window_closed`; and `closed` with all 4 rows disposed. The application exited 0 after its own check that no node, timer or row outlived the window.
