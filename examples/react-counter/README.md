# React counter

A small [`@bun-native/react`](../../packages/react/README.md) application that
exercises the adapter's core behavior in one window:

- a click counter, where each `Increment` press also reorders a keyed row list
  (`Alpha`, `Beta`, `Gamma` becomes `Gamma`, `Alpha` and back);
- an editable native input whose `onInput` event is stored directly in React
  state, with an echo label;
- `useEffect` setup and cleanup per keyed row and for the whole tree.

On the first click the example itself checks the root's mutation diagnostics:
the keyed update must move one row, remove one row and set one label without
recreating native nodes. On window close it disposes the root and fails if any
row effect or the owner survived. It reuses the opt-in `recordEvidence` helper
from [`native-window/content.ts`](../native-window/content.ts).

## Run in development

From the repository root, with the pinned Bun and an existing prebuilt host.
The file selects the React JSX runtime with `@jsxImportSource`, so Bun runs it
directly:

```sh
bun install --frozen-lockfile
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host bun examples/react-counter/main.tsx
```

## Build an AOT executable

The AOT helper's `react` entry transforms this file into a production module at
`development/application.js`, compiles that same module and inspects the result:

```sh
bun experiments/aot-gpui/build-window.ts \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --entry react \
  --outdir /absolute/path/to/empty/react-counter-package
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host \
  /absolute/path/to/empty/react-counter-package/react
```

The host is referenced in place rather than copied. Windows output names end in
`.exe`. The native `counter-click` and `counter-input` scenarios that drive this
example in development and AOT are described in the
[React package README](../../packages/react/README.md#real-native-development-and-aot-fixture).
