# Native window

The smallest application on the public [`@bun-native/core`](../../packages/core/README.md)
API, with no framework adapter. It opens one window, creates a heading, a click
counter label, an `Increment` button and an editable input in a single native
batch, then updates the label from the button's `click` callback. Closing the
window ends the application, which shuts down its native host.

- `main.ts` owns the application and window lifetime and the event callbacks.
- `content.ts` holds the initial element tree (`mountContent`) and the opt-in
  `recordEvidence` helper that the counter examples and native fixtures reuse.
  Evidence is written only when both `BUN_NATIVE_EVIDENCE_LOG` and
  `BUN_NATIVE_EVIDENCE_NONCE` are set; ordinary launches record nothing.

## Run in development

From the repository root, with the pinned Bun and an existing prebuilt host.
`bun run native:build` builds a release host with Cargo at
`target/release/bun-native-host`; the application itself never invokes Cargo.

```sh
bun install --frozen-lockfile
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" bun run example
```

`bun run example` is the root script for `bun examples/native-window/main.ts`.

## Build an AOT executable

`native-window` is the default entry of the AOT helper. It compiles this entry,
inspects the executable and copies the supplied host into the empty output
directory:

```sh
bun experiments/aot-gpui/build-window.ts \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --outdir /absolute/path/to/empty/native-window-package
BUN_NATIVE_HOST=/absolute/path/to/empty/native-window-package/bun-native-host \
  /absolute/path/to/empty/native-window-package/native-window
```

Windows output names end in `.exe`. See the
[AOT helper](../../experiments/aot-gpui/README.md) for the manifest it records.
A successful build establishes compilation and binary inspection, not native
rendering or input; the native interaction scenarios for this example are
listed in [testing](../../docs/testing.md).
