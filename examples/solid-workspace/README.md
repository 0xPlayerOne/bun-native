# Solid conversation workspace

This Adea-inspired native reference app advances [#250](https://github.com/0xPlayerOne/bun-native/issues/250). It is a separate example in Bun Native, with local demo data and deterministic replies. It neither ports nor changes Adea production code.

The app uses the public Solid adapter and shared GPUI `box`, `text`, `button` and `input` primitives. It provides conversation history, per-conversation drafts, a local eight-update reply stream, cancellation, new/close actions, a clear-history confirmation panel, theme switching and a collapsible details pane. History and navigation use real native scroll containers. The flexible conversation pane grows with the window; hide the details pane for more room on small windows. No automatic breakpoint or minimum-window-size API is claimed.

The terminal area explicitly says that PTY and shell execution are unsupported. There is no model backend, network connection, filesystem browser, persistent history or OS dialog. The confirmation panel is part of the application UI. Native service/dialog work remains tracked separately in [#239](https://github.com/0xPlayerOne/bun-native/issues/239); broader adaptive layouts, streaming and themes remain [#257](https://github.com/0xPlayerOne/bun-native/issues/257).

## Run with an existing host

From the repository root, with the pinned Bun and dependencies installed:

```sh
bun scripts/solid-build.ts examples/solid-workspace/main.tsx "$PWD/.bun-native/solid-workspace"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host bun .bun-native/solid-workspace/application.js
```

Build a production AOT executable with the same transformed source:

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry solid-workspace \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir "$PWD/.bun-native/solid-workspace-aot"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host .bun-native/solid-workspace-aot/solid-workspace
```

Output directories must be empty for the AOT helper. Ordinary source edits use the prebuilt host; neither command invokes Cargo. A successful build establishes compilation and binary inspection, not native interaction or release readiness.

## Ownership and bounds

At most one reply and one timer are live. Each callback carries reply and timer identity. Cancelling, switching, creating, closing or clearing a conversation invalidates that identity before publishing new state; disposal cancels without writing into a disposed Solid owner. A queued stale callback cannot consume a newer timer or modify another conversation. Partial replies retain a `Cancelled` label.

The example limits a workspace to 12 conversations, a conversation to 32 messages and a submitted prompt to 240 characters. These keep this small reference workload bounded; they are not a virtualization or long-session performance claim. A keyed conversation pane creates a fresh versioned input owner on selection changes, while drafts remain in the model. The composer reads the latest native input revision before submission and replacement.

## Port inventory

| Source                                                           | Treatment                                           | Purpose                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`, `packages/renderer`                             | Reused unchanged                                    | Shared native window, layout, text, input, events and ownership.                                                                      |
| `packages/solid/src/renderer.ts`, `tests/solid/renderer.test.ts` | Narrow adapter correction and regression            | Accept the official universal compiler's null insertion marker for adjacent dynamic regions; retain non-null anchor ownership checks. |
| `scripts/solid-build.ts`, `experiments/aot-gpui/build-window.ts` | Existing compiler path; new entry and source hashes | Official Solid universal transform, Bun AOT and executable inspection.                                                                |
| `examples/react-workspace/app.tsx`, `main.tsx`                   | Layout/input/lifetime patterns adapted              | Root fill sizing, bounded flexible scroll panes, latest native input intents and joined shutdown.                                     |
| `examples/solid-workspace/model.ts`                              | New                                                 | Conversation policy and owned local streaming simulation.                                                                             |
| `examples/solid-workspace/app.tsx`, `main.tsx`                   | New                                                 | Solid native composition and standalone example lifetime.                                                                             |
| `tests/solid/workspace-model.test.ts`                            | New                                                 | Completion/cancellation, stale delivery, reentrancy, limits and disposal controls.                                                    |
| `tests/solid/workspace-contract.tsx`, `workspace.test.ts`        | New, reuse existing headless IPC peer               | Actual compiled component, versioned drafts, actions and zero-resource teardown.                                                      |

No Adea production source files were copied. No new native widget, framework dependency, runtime bridge or privileged capability was introduced.

## Validation scope

Model tests deliberately drive stale callbacks. The component contract builds the actual example and runs the public Solid/core adapters against the existing headless subprocess peer. It exercises synthetic peer events and real owned timers; it cannot qualify GPUI pixels, native scrolling, focus, OS input or OS window close.

Real native development/AOT interaction evidence is a separate required scope. Physical-device accessibility, screen-reader behavior, IME, macOS/Windows workspace interaction, long-session memory, PTY execution, backend integration and full Adea parity remain unqualified. Keep #250 open until its broader acceptance is demonstrated.
