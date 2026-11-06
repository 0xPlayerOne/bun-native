# Streaming lists, themes and density

This is the BN4 streaming/virtualization increment for [#257](https://github.com/0xPlayerOne/bun-native/issues/257). It documents an **app-level windowing pattern over the shared renderer**, theme and density tokens, a versioned deterministic streaming fixture that runs under both Solid and React on the same GPUI host, and a bounded native soak in the required Linux job. It adds no element type, wire field, capability or protocol version.

## Why app-level windowing, not a host list primitive

A host virtual list (for example GPUI's `uniform_list`) is not justified yet:

- Each native window accepts at most **4,096 nodes**. A 10,000-message history at three nodes per row cannot be mounted at all, so long lists must window regardless of the host.
- The renderer snapshots its whole subtree on every commit, and the host rebuilds its GPUI element tree from the committed model on every frame. Both costs scale with mounted nodes, so a bounded window bounds both.
- Applications do not observe native scroll offsets or wheel deltas. A host list would need new scroll events, an element kind and a capability, while the windowed pattern needs none of them.
- End-anchored native scrolling (the optional `scroll_anchor_v1` style field, [#457](https://github.com/0xPlayerOne/bun-native/pull/457); see the [overlay contract](native-overlays.md)) pins a native `scroll_y` box to its end. It still mounts every child, so it does not bound node counts. This pattern does not use it.

Reconsider a host primitive when a measured workload needs wheel-driven virtualization or variable-height rows that the app cannot compute.

## The pattern

The reference model is [`tests/native/streaming-list-model.ts`](../tests/native/streaming-list-model.ts). Solid ([`solid-streaming-list.tsx`](../tests/native/solid-streaming-list.tsx)) and React ([`react-streaming-list.tsx`](../tests/native/react-streaming-list.tsx)) render the same native tree from it through their public adapters. Neither one has its own layout or rendering backend.

- **History stays in JavaScript.** The model keeps the append-only message array. Only `rows` visible rows become native nodes (9 comfortable or 14 compact), plus 9 frame nodes.
- **The scroll position is an index anchor**, owned by the application. When following, the anchor tails the stream. A detached anchor does not move when messages are appended, so the visible ids and the selection stay stable while streaming continues.
- **Selection is a stable message id**, not a row position. Up/Down/PageUp/PageDown/Home move it and reveal it by adjusting the anchor; PageUp/PageDown also shift the anchor by one page. Any of these detaches the view, even when it lands on the newest message. Only End re-attaches to the tail. A pointer press on a visible row selects that row through the row's adapter `onPointerDown`.
- **Rows are keyed by message id.** Solid uses `For` over primitive ids. React uses `key={id}` with a content-comparing `memo`. A streamed token therefore updates one existing native text node. Rows are created and removed only when the window shifts.
- **Keyboard routing.** When no control has focus, native key events target the window root, which is outside the render root. The fixture listens there with a single capture listener (`window.on(window.root, 'key_down', …, { capture: true })`).
- **Autoscroll without a scroll offset.** A following list uses `justify_content: 'end'` inside an `overflow: 'hidden'` column, so the newest row stays visible when the OS shrinks the window. A detached list is top-aligned.

### Theme and density tokens

`THEMES` (dark, light) maps semantic tokens such as `background`, `surface`, `selected`, `text`, `muted` and `accent` to 24-bit RGB. `DENSITIES` (comfortable, compact) sets the row count, row height, padding, gap and type sizes in **logical pixels**. GPUI applies the real OS scale factor on top, so density is not the same thing as scaling. Style functions take only the tokens they depend on, which lets both adapters produce identical native styles. F7 toggles the theme and F8 toggles the density in the fixture.

### Differences from CSS, Tailwind and browser layout

These are native style values, not CSS. The [layout contract](native-layout.md) lists every accepted field.

- There are no class names, selectors, cascade, CSS variables or `rem`/`em`/`%` units. Tokens are plain TypeScript values passed into `style`.
- Text inherits color, size and, on a host advertising `style_decoration_v1`, `font_weight`. There is no `line-height`, `text-overflow: ellipsis` or `white-space` control. Clip long text with a fixed-height `overflow: 'hidden'` row.
- There is no `position: sticky`/`absolute`, `scroll-snap`, `overflow-anchor`, `content-visibility`, `IntersectionObserver` or `ResizeObserver`. The app cannot observe its size, so the visible row count comes from density rather than measured height.
- `flex_grow` and `min_height: 0` with `height: 0` give a remaining-space region. `fill` is the parent's full size, not the remaining flex space.
- Native `overflow: 'scroll_y'` boxes keep their own native offset, which the app cannot read. Do not combine them with app windowing in the same list.

## Accessibility, focus and selection impact (gated in #241)

Windowed-out messages have no native node, so assistive technology cannot reach them. The host's AccessKit tree exposes only mounted text, buttons and inputs ([native text](native-text.md#contract), [#241](https://github.com/0xPlayerOne/bun-native/issues/241)), so a visible row reads as its two text labels, with no list semantics. Selection lives in application state and is drawn with the `selected` token. It is not native focus, there is no focus ring, and Tab does not enter rows because rows are not focusable controls. These gaps stay open under #241: an accessible list role, the active-descendant/position-in-set equivalent for the full history, and screen-reader announcement of streamed text. They must be qualified before any accessibility claim. A focused input or button inside a row that gets windowed out is removed and blurred, as the [layout contract](native-layout.md#scroll-clipping-and-lifetime) already describes.

## Versioned fixture

[`benchmarks/streaming-list-fixture.ts`](../benchmarks/streaming-list-fixture.ts) is **version 1**:

- 10,000 history messages of 10 words each.
- A stream of 2,400 tokens requested at 4 ms, one token per tick, with 16 tokens per streamed message (150 new messages).
- Content is a pure function of indices and a fixed seed.

Every framework and mode must end with the same history digest; on version 1 that is `23f90d78`. Comparative measurements ([#244](https://github.com/0xPlayerOne/bun-native/issues/244)) must cite the fixture version and build mode.

## Native soak

[`tests/native/streaming-list.py`](../tests/native/streaming-list.py) drives one adapter and mode inside the isolated session. It does the following, using real XTest input against the owned window:

1. Starts the stream.
2. Detaches with Up ×3 while tokens arrive.
3. Pointer-selects a row.
4. Switches theme and checks the screenshot background against the light token.
5. Switches density.
6. Presses PageUp, Home and Down ×2.
7. Resizes the window through the window manager to 720×480 and then 1180×760.
8. Re-follows with End, waits for the complete stream and closes with Alt+F4.

The fixture enforces the oracle:

- A detached window keeps its anchor, ids and selection on every tick, and makes no create or remove while no navigation commit is in flight.
- Mounted nodes never exceed 9 + 14×3 = 51.
- Row listeners never exceed 14.
- After close, every public owner count is zero.

The controller then requires a passed fixture result and a passed process cleanup. `summarize` requires a single final digest across all runs.

`BUN_NATIVE_FRAME_TRACE=1`, alongside the evidence log, makes the host write one compact `frame` record per native paint callback. Each record carries the tree revision, node count, an elapsed timestamp, and `render_to_paint_ns` (from element-tree construction to the paint callback). The host writes at most 16,384 records per process. While frame tracing is on, the host suppresses the full-tree `rendered` and geometry records, so the evidence writer does not dominate the frames being measured. Frame records are paint callbacks, **not** presentation or vsync timestamps. Software Xvfb has no reliable notion of a dropped frame, so the soak reports interval distributions and fixed descriptive buckets instead of a dropped-frame count.

The required [native Linux job](../.github/workflows/native-linux.yml) runs all four combinations (Solid and React, development and inspected AOT) against its release host. It uploads each `result.json` and `streaming-list-baseline.json`. To run it locally:

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
run=$(mktemp -d "$PWD/.bun-native/streaming.XXXXXX")
bun experiments/aot-gpui/build-window.ts --source "$PWD" --host "$BUN_NATIVE_HOST" \
  --host-profile release --entry solid-streaming-list --outdir "$run/package"
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$run/session" -- \
  python3 tests/native/streaming-list.py --framework solid --mode development \
    --host-profile release --output "$run/development" -- bun "$run/package/development/application.js"
python3 tests/native/streaming-list.py summarize --output "$run/baseline.json" "$run/development/result.json"
```

## Recorded baselines

The [Linux evidence record](evidence/streaming-list-linux-2026-11-05.json) holds a passed local run of all four combinations at commit `1049a3b` (before a rebase onto unrelated main changes; rebased as `6aefa26`), together with the host hash. That run used a **development-profile** (unoptimized) host on Xvfb with Mesa llvmpipe at scale 1, on a shared 4-core VM that other jobs were loading at the same time.

- The paint-callback cadence was about 21–25 frames per second. The p50 interval was 33–46 ms and the p95 interval was 64–79 ms.
- `render_to_paint` p95 was 15–18 ms.
- Update-to-acknowledgement p50 was 1.5–1.9 ms and p95 was 63–79 ms.
- The stream took 11.9–14.1 s and coalesced 2,400 tokens into 935–1,050 commits.
- Host RSS grew by 7–10 MiB over the stream. Host descriptors stayed at 24 and host threads at 35–36 throughout.
- Development Bun RSS peaked at 50 MiB (Solid) and 81 MiB (React). AOT applications peaked at 36–37 MiB.
- Mounted nodes peaked at 51 and listeners at 14 in every run. All four runs ended with the same digest.

An earlier exploratory run on the same machine with less load measured 28–42 frames per second. The machine's load clearly moves these figures, so they cannot be used as acceptance budgets.

These are baselines, not thresholds. Release-host CI artifacts supersede them for comparison. Acceptance budgets must come from repeated release-host runs, not from this single record.

## Unsupported and open

- HiDPI, Wayland, macOS, Windows, physical GPUs, IME and accessibility are not covered.
- Wheel-driven virtualization, variable-height row measurement and native scroll anchoring (`scroll_anchor_v1`) are not part of this pattern.
- Split-pane drag resizing is not covered. Only native flex adaptation to OS resize is exercised.
- Only the 10–15 s bounded soak runs in CI. Extended soak and repeated-teardown runs, CPU/GPU utilization and allocation profiles of this workload remain for #244 and the BN4 checkpoint.
