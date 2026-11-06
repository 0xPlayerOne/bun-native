# Solid counter

A small [`@bun-native/solid`](../../packages/solid/README.md) application that
exercises the adapter's core behavior in one window:

- a click counter, where each `Increment` press also reorders a keyed `<For>`
  list (`Alpha`, `Beta`, `Gamma` becomes `Gamma`, `Alpha` and back);
- an editable native input whose `onInput` event is stored directly in a
  signal, with an echo label;
- `createEffect` and `onCleanup` for the owner and for each keyed row.

On the first click the example itself checks the root's mutation diagnostics:
the keyed update must move one row, remove one row and set one label without
recreating native nodes. On window close it disposes the root and fails if any
row or the owner survived. It reuses the opt-in `recordEvidence` helper from
[`native-window/content.ts`](../native-window/content.ts).

## Run in development

Solid JSX must first be compiled with the official universal transform. From
the repository root, with the pinned Bun and an existing prebuilt host:

```sh
bun install --frozen-lockfile
bun scripts/solid-build.ts examples/solid-counter/main.tsx "$PWD/.bun-native/solid-counter"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host bun .bun-native/solid-counter/application.js
```

The output directory argument must be absolute. Running `main.tsx` directly
with Bun is not supported, because it skips the Solid JSX transform.

## Build an AOT executable

The AOT helper's `solid` entry runs the same build script, compiles the
generated module and inspects the result:

```sh
bun experiments/aot-gpui/build-window.ts \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --entry solid \
  --outdir /absolute/path/to/empty/solid-counter-package
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host \
  /absolute/path/to/empty/solid-counter-package/solid
```

The host is referenced in place rather than copied. Windows output names end in
`.exe`. The [Solid package README](../../packages/solid/README.md) describes
the build pipeline and its validation.
