/**
 * One layout/style scene qualified through core, Solid and React in an
 * isolated Xvfb + openbox session. Real XTEST input (xdotool) drives clicks,
 * divider drags, wheel and Tab; geometry, focus and the committed element
 * tree come from the host's nonce-tagged paint evidence, so no adapter or
 * node identity is needed to observe the result. Each run writes a
 * structural snapshot that `layout-style-compare.ts` compares across
 * adapters and native scale factors.
 *
 * On macOS the same scene runs in the hosted runner's GUI session with
 * CoreGraphics input and an Accessibility window resize through the bounded
 * SDK helper, and `screencapture` pixels of the owned window
 * (tests/native/macos-window-input.ts). The native scale factor is the
 * display's backing scale, read independently from the capture.
 */
import {
  createApplication,
  defineTheme,
  SPLIT_DIVIDER,
  type NativeWindow,
  type Style,
} from '@bun-native/core'
import type { RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MacWindow, type Point } from './macos-window-input.ts'

export type SceneState = { theme: 'light' | 'dark'; ratio: number }
export const initialScene: SceneState = { theme: 'light', ratio: 0.5 }

const tokens = {
  space: { sm: 8, md: 12 },
  radii: { md: 6 },
  fontSizes: { body: 18, lg: 22 },
} as const
const themes = {
  light: defineTheme({
    ...tokens,
    colors: {
      surface: 0xf4f5f7,
      text: 0x17212b,
      paneA: 0xe2e8f0,
      paneB: 0xdbeafe,
      wide: 0xf9c8c8,
      accent: 0x2255cc,
      on_accent: 0xffffff,
      divider: 0x8792a2,
      field: 0xffffff,
    },
  }),
  dark: defineTheme({
    ...tokens,
    colors: {
      surface: 0x101418,
      text: 0xe8ecf0,
      paneA: 0x1f2933,
      paneB: 0x243b53,
      wide: 0x7b341e,
      accent: 0x5b8def,
      on_accent: 0x0b1020,
      divider: 0x52606d,
      field: 0x0b1020,
    },
  }),
}

export const LABELS = {
  header: 'Layout contract',
  a1: 'A1',
  wide: 'Wide clipped content that overflows its pane',
  a2: 'A2',
  b1: 'B1',
  done: 'Done',
  status: 'Status',
} as const
export const MIN_PANE = 80
export const INPUT_VALUE = 'B'
/** The style each adapter's render root gives its ownership container. */
export const CONTAINER = { width: 'fill', height: 'fill' } as const satisfies Style

/** Every style in the scene, resolved from the active theme's tokens. */
export function sceneStyles(state: SceneState) {
  const theme = themes[state.theme]
  return {
    root: theme.style({
      direction: 'column',
      width: 'fill',
      height: 'fill',
      padding: 'md',
      gap: 'sm',
      background: 'surface',
      color: 'text',
      font_size: 'body',
    }),
    header: theme.style({ height: 32, font_size: 'lg', font_weight: 700 }),
    split: theme.style({
      width: 'fill',
      height: 200,
      border_width: 1,
      border_color: 'divider',
      background: 'divider',
    }),
    paneA: theme.style({
      direction: 'column',
      width: 'fill',
      height: 'fill',
      gap: 'sm',
      padding: 'sm',
      overflow: 'scroll_y',
      background: 'paneA',
    }),
    button: theme.style({ width: 120, height: 36 }),
    wide: theme.style({ width: 420, height: 28, background: 'wide', overflow: 'hidden' }),
    spacer: theme.style({ width: 40, height: 240 }),
    paneB: theme.style({
      direction: 'column',
      width: 'fill',
      height: 'fill',
      gap: 'sm',
      padding: 'sm',
      background: 'paneB',
    }),
    input: theme.style({ width: 'fill', height: 36, background: 'field' }),
    accent: theme.style({
      width: 120,
      height: 36,
      corner_radius: 'md',
      border_width: 2,
      border_color: 'divider',
      background: 'accent',
      color: 'on_accent',
    }),
    footer: theme.style({ direction: 'row', gap: 'sm', height: 44, align_items: 'center' }),
    done: theme.style({ width: 120, height: 36, opacity: 0.9 }),
    status: theme.style({ flex_grow: 1, height: 28 }),
  } satisfies Record<string, Style>
}

export interface MountedScene {
  update(state: SceneState): void | Promise<void>
  /** A framework view owns its subtree; core returns undefined. */
  view?: RenderRoot
}
export type SceneMount = (window: NativeWindow) => Promise<MountedScene>

const TITLE = 'Layout style qualification'
const WIDTH = 480
const HEIGHT = 340

type Rect = [number, number, number, number]
type Layout = {
  tree_revision: number
  layout: {
    status: string
    scale_factor: number
    viewport: [number, number]
    focused_node_id: number | null
    nodes: { node_id: number; bounds: Rect; ancestor_clip: Rect }[]
    scrolls: { node_id: number; offset: [number, number]; maximum: [number, number] }[]
  }
}
type RenderedNode = {
  node_id: number
  element: { kind: string; text?: string; style?: Record<string, unknown>; ratio?: number }
  children: number[]
}
type Rendered = { tree_revision: number; nodes: RenderedNode[] }
type Structure = { element: RenderedNode['element']; children: Structure[] }

export async function qualifyLayoutStyle(
  adapter: 'core' | 'solid' | 'react',
  mount: SceneMount
): Promise<void> {
  const output = process.env['BUN_NATIVE_LAYOUT_EVIDENCE']
  const mode = process.env['BUN_NATIVE_LAYOUT_MODE']
  const executable = process.env['BUN_NATIVE_HOST']
  // The host inherits these from the launching environment; Bun.spawn does
  // not observe later process.env mutation.
  const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
  const mac = process.platform === 'darwin'
  let scale = Number(process.env['GPUI_X11_SCALE_FACTOR'] ?? '1')
  if (
    !output ||
    !isAbsolute(output) ||
    !statSync(output).isDirectory() ||
    !executable ||
    (mode !== 'development' && mode !== 'aot') ||
    (mac
      ? !process.env['BUN_NATIVE_PLATFORM_HELPER'] || process.env['GPUI_X11_SCALE_FACTOR']
      : !process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']) ||
    !isAbsolute(evidenceLog) ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    (scale !== 1 && scale !== 2)
  )
    throw new Error(
      mac
        ? 'macOS needs an evidence directory and log, nonce, host, mode and the OS input helper'
        : 'An isolated X11 display, evidence directory and log, nonce, host, mode and scale 1 or 2 are required'
    )

  const started = performance.now()
  const outcomes: Record<string, unknown> = {}
  const snapshots: Record<string, unknown> = {}
  const outcome = (name: string, value: unknown) => {
    outcomes[name] = value
    console.log(
      JSON.stringify({ adapter, outcome: name, atMs: Math.round(performance.now() - started) })
    )
  }

  async function run(command: string[]): Promise<string> {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
    return stdout.trim()
  }
  async function waitFor<T>(check: () => T | undefined, description: string, timeout = 5_000) {
    const until = performance.now() + timeout
    for (;;) {
      const value = check()
      if (value !== undefined) return value
      if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
      await Bun.sleep(10)
    }
  }
  function records<T>(type: string): T[] {
    let text = ''
    try {
      text = readFileSync(evidenceLog, 'utf8')
    } catch {
      return []
    }
    const result: T[] = []
    // The host appends whole lines while this polls: a last line without its
    // newline is still being written and is read on the next poll.
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (!line) continue
      const value = JSON.parse(line) as { nonce?: string; type?: string }
      if (value.nonce === nonce && value.type === type) result.push(value as T)
    }
    return result
  }
  const latestRendered = () => records<Rendered>('rendered').at(-1)
  function find(predicate: (node: RenderedNode) => boolean): RenderedNode {
    const node = latestRendered()?.nodes.find(predicate)
    if (!node) throw new Error('No matching rendered node')
    return node
  }
  const labelled = (text: string) => find((node) => node.element.text === text).node_id
  const ofKind = (kind: string) => find((node) => node.element.kind === kind)
  /**
   * Wait until the committed revision has painted and the latest geometry
   * satisfies the check. Geometry records are deduplicated (an unchanged
   * layout is not repeated), so the latest one is the displayed state and an
   * older match would be stale.
   */
  async function painted(window: NativeWindow, check: (layout: Layout) => boolean = () => true) {
    return waitFor(() => {
      if ((latestRendered()?.tree_revision ?? -1) < window.revision) return undefined
      const latest = records<Layout>('layout')
        .filter((entry) => entry.layout.status === 'complete')
        .at(-1)
      return latest && check(latest) ? latest : undefined
    }, 'native paint evidence at revision ' + window.revision)
  }
  function bounds(layout: Layout, id: number): Rect {
    const node = layout.layout.nodes.find((entry) => entry.node_id === id)
    if (!node) throw new Error('No painted bounds for node ' + id)
    return node.bounds
  }
  const near = (actual: number, expected: number, description: string, tolerance = 1) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${description}: ${actual} is not within ${tolerance} of ${expected}`
    )

  /** The committed tree and its geometry by structural path, without node ids. */
  function structure(layout: Layout) {
    const rendered = latestRendered()
    assert.ok(rendered, 'rendered evidence exists')
    const byId = new Map(rendered.nodes.map((node) => [node.node_id, node]))
    const owned = new Set(rendered.nodes.flatMap((node) => node.children))
    const roots = rendered.nodes.filter((node) => !owned.has(node.node_id))
    assert.equal(roots.length, 1, 'one window root')
    const geometry: Record<string, Rect> = {}
    const build = (node: RenderedNode, path: string): Structure => {
      const painted = layout.layout.nodes.find((entry) => entry.node_id === node.node_id)
      if (painted)
        geometry[path] = painted.bounds.map((value) => Math.round(value * 100) / 100) as Rect
      return {
        element: node.element,
        children: node.children.map((child, index) => build(byId.get(child)!, path + '/' + index)),
      }
    }
    return { tree: build(roots[0]!, 'root'), geometry }
  }

  let windowId = ''
  let macWindow: MacWindow | undefined
  const at = ([x, y]: [number, number]) => [
    String(Math.round(x * scale)),
    String(Math.round(y * scale)),
  ]
  const centre = ([x, y, width, height]: Rect): [number, number] => [x + width / 2, y + height / 2]
  const click = async (point: [number, number], button: '1' | '4' | '5' = '1') => {
    if (macWindow) await macWindow.click([Math.round(point[0]), Math.round(point[1])], button)
    else await run(['xdotool', 'mousemove', '--window', windowId, ...at(point), 'click', button])
  }
  const press = async (...keys: string[]) => {
    if (macWindow) await macWindow.press(...keys)
    else await run(['xdotool', 'key', '--clearmodifiers', ...keys])
  }
  async function drag(from: [number, number], to: [number, number]) {
    if (macWindow) {
      const path: Point[] = [0, 1, 2, 3, 4].map((step) => [
        Math.round(from[0] + ((to[0] - from[0]) * step) / 4),
        Math.round(from[1] + ((to[1] - from[1]) * step) / 4),
      ])
      await macWindow.drag(path)
      return
    }
    await run(['xdotool', 'mousemove', '--window', windowId, ...at(from), 'mousedown', '1'])
    for (let step = 1; step <= 4; step++) {
      const point: [number, number] = [
        from[0] + ((to[0] - from[0]) * step) / 4,
        from[1] + ((to[1] - from[1]) * step) / 4,
      ]
      await run(['xdotool', 'mousemove', '--window', windowId, ...at(point)])
      await Bun.sleep(30)
    }
    await run(['xdotool', 'mouseup', '1'])
  }
  /** Capture the owned window and read displayed pixels as 0xRRGGBB. */
  async function capture(name: string, points: [number, number][]) {
    const file = join(output!, `${adapter}-${name}.png`)
    if (macWindow) {
      const shot = await macWindow.capture(file)
      return { size: shot.size, pixels: points.map((point) => shot.pixel(point)) }
    }
    await run(['import', '-window', windowId, file])
    const size = (await run(['identify', '-format', '%w %h', file])).split(' ').map(Number)
    const pixels: number[] = []
    for (const point of points) {
      const [x, y] = at(point)
      const text = await run(['convert', file, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-'])
      const hex = /#([0-9A-Fa-f]{6})/.exec(text)
      if (!hex) throw new Error('Unreadable screenshot pixel: ' + text)
      pixels.push(Number.parseInt(hex[1]!, 16))
    }
    return { size, pixels }
  }
  /**
   * Native paint evidence precedes presentation. Capture until the scene's
   * own surface is displayed at its padded corner, then read the points.
   */
  async function screenshot(name: string, surface: number, points: [number, number][]) {
    const until = performance.now() + 5_000
    for (;;) {
      const result = await capture(name, [[4, 4], ...points])
      if (result.pixels[0] === surface) return { size: result.size, pixels: result.pixels.slice(1) }
      if (performance.now() > until) {
        let detail = ''
        if (macWindow) {
          const file = join(output!, `${adapter}-${name}.png`)
          const stale = await macWindow.staleCapture(file, [[4, 4]])
          detail = ` (window ${stale.window[0]}, display ${stale.display[0]})`
        }
        throw new Error(
          name + ' never displayed its surface: ' + result.pixels[0]!.toString(16) + detail
        )
      }
      await Bun.sleep(50)
    }
  }
  async function resize(width: number, height: number) {
    if (macWindow) return macWindow.resize(width, height)
    await run([
      'xdotool',
      'windowsize',
      '--sync',
      windowId,
      String(width * scale),
      String(height * scale),
    ])
  }

  const app = await createApplication({ executable })
  try {
    assert.ok(app.capabilities.includes('split_v1'))
    assert.ok(app.capabilities.includes('style_decoration_v1'))
    const window = await app.openWindow({ title: TITLE, width: WIDTH, height: HEIGHT })
    const scene = await mount(window)
    let state = initialScene
    const update = async (next: Partial<SceneState>, committed: () => boolean, what: string) => {
      state = { ...state, ...next }
      await scene.update(state)
      await waitFor(() => (committed() ? true : undefined), what)
    }

    const initial = await painted(window, (entry) => entry.layout.nodes.length > 10)
    if (mac) {
      // The display's backing scale, measured from a capture of the window.
      macWindow = await MacWindow.open(TITLE, executable, () => {
        const latest = records<Layout>('layout').at(-1)
        return latest ? latest.layout.viewport : [WIDTH, HEIGHT]
      })
      scale = (await macWindow.capture(join(output, `${adapter}-scale.png`))).scale
      assert.ok(scale === 1 || scale === 2, 'a 1x or 2x backing scale: ' + scale)
    }
    assert.equal(initial.layout.scale_factor, scale, 'native scale factor')
    const id = await waitFor(() => {
      try {
        const split = ofKind('split')
        const [paneA, paneB] = split.children
        if (paneA === undefined || paneB === undefined) return undefined
        return {
          split: split.node_id,
          paneA,
          paneB,
          a1: labelled(LABELS.a1),
          a2: labelled(LABELS.a2),
          wide: labelled(LABELS.wide),
          b1: labelled(LABELS.b1),
          done: labelled(LABELS.done),
          header: labelled(LABELS.header),
          input: ofKind('input').node_id,
        }
      } catch {
        return undefined
      }
    }, 'the committed scene')
    const names = new Map<number, string>([
      [id.a1, 'A1'],
      [id.a2, 'A2'],
      [id.split, 'divider'],
      [id.input, 'input'],
      [id.b1, 'B1'],
      [id.done, 'Done'],
    ])
    if (!mac) {
      const windows = (
        await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])
      ).split('\n')
      assert.equal(windows.length, 1, 'exactly one owned window named ' + TITLE)
      windowId = windows[0]!
      await run(['xdotool', 'windowactivate', '--sync', windowId])
    }
    const first = await painted(window, (entry) => entry.layout.viewport[0] === WIDTH)
    snapshots['initial'] = structure(first)

    // Split geometry: the declared ratio divides the space after the divider.
    const splitBox = bounds(first, id.split)
    const a = bounds(first, id.paneA)
    const b = bounds(first, id.paneB)
    const available = splitBox[2] - 2 - SPLIT_DIVIDER
    near(a[2], available / 2, 'leading pane at ratio 0.5')
    near(b[2], available / 2, 'trailing pane at ratio 0.5')
    near(b[0] - (a[0] + a[2]), SPLIT_DIVIDER, 'divider thickness')
    outcome('splitRatio', { split: splitBox, paneA: a, paneB: b })

    // Clipping: the overflowing text is painted only inside its pane.
    const wide = bounds(first, id.wide)
    assert.ok(wide[0] + wide[2] > b[0] + 170, 'the wide row extends past its pane')
    const light = themes.light.tokens.colors
    const clipped = await screenshot('clipping', light.surface, [
      // Above the glyphs: only the row background is displayed here.
      [wide[0] + 6, wide[1] + 2],
      // Right of B1, which shares this row, but still under the unclipped row.
      [b[0] + 160, wide[1] + 2],
    ])
    assert.deepEqual(clipped.size, [WIDTH * scale, HEIGHT * scale], 'physical capture size')
    assert.equal(clipped.pixels[0], light.wide, 'visible part of the wide row')
    assert.equal(clipped.pixels[1], light.paneB, 'the row is clipped at its pane edge')
    outcome('paneClipping', { wide, paneB: b, pixels: clipped.pixels.map((p) => p.toString(16)) })

    // Focus order follows rendered order across both panes, with the split
    // divider between them, and wraps.
    await click(centre(bounds(first, id.a1)))
    await painted(window, (entry) => entry.layout.focused_node_id === id.a1)
    const order: string[] = ['A1']
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'shift+Tab']) {
      const previous = order.length
      await press(key)
      const next = await painted(
        window,
        (entry) =>
          entry.layout.focused_node_id !== null &&
          names.get(entry.layout.focused_node_id) !== order[previous - 1]
      )
      order.push(names.get(next.layout.focused_node_id!)!)
    }
    assert.deepEqual(order, ['A1', 'A2', 'divider', 'input', 'B1', 'Done', 'A1', 'Done'])
    outcome('focusOrder', order)

    // Scrolling within a pane, retained by node identity across later updates.
    for (let index = 0; index < 3; index++) await click(centre(a), '5')
    const scrolled = await painted(window, (entry) =>
      entry.layout.scrolls.some((scroll) => scroll.node_id === id.paneA && scroll.offset[1] < 0)
    )
    const offset = scrolled.layout.scrolls.find((scroll) => scroll.node_id === id.paneA)!.offset[1]
    outcome('paneScroll', { offset })

    // A real divider drag resizes both panes; minimums bound the drag.
    const dividerAt = (layout: Layout): [number, number] => {
      const leading = bounds(layout, id.paneA)
      return [leading[0] + leading[2] + SPLIT_DIVIDER / 2, leading[1] + leading[3] / 2]
    }
    const before = await painted(window)
    const from = dividerAt(before)
    await drag(from, [from[0] + 80, from[1]])
    const dragged = await painted(
      window,
      (entry) => Math.abs(bounds(entry, id.paneA)[2] - (a[2] + 80)) <= 2
    )
    const draggedWidth = bounds(dragged, id.paneA)[2]
    await drag(dividerAt(dragged), [WIDTH - 2, from[1]])
    const clamped = await painted(window, (entry) => bounds(entry, id.paneB)[2] < MIN_PANE + 2)
    near(bounds(clamped, id.paneB)[2], MIN_PANE, 'trailing pane minimum')
    await drag(dividerAt(clamped), [
      dividerAt(clamped)[0] - (bounds(clamped, id.paneA)[2] - draggedWidth),
      from[1],
    ])
    const settled = await painted(
      window,
      (entry) => Math.abs(bounds(entry, id.paneA)[2] - draggedWidth) <= 2
    )
    const userWidth = bounds(settled, id.paneA)[2]
    outcome('dividerDrag', {
      dragged: draggedWidth,
      minimum: bounds(clamped, id.paneB)[2],
      userWidth,
    })

    // Theme tokens switch every color in one ordinary update; the dragged
    // ratio and the pane's scroll offset survive because neither was redeclared.
    await update(
      { theme: 'dark' },
      () =>
        latestRendered()?.nodes.some(
          (node) => node.element.style?.['background'] === themes.dark.tokens.colors.surface
        ) === true,
      'dark theme commit'
    )
    const dark = await painted(window)
    near(bounds(dark, id.paneA)[2], userWidth, 'user ratio kept across a theme switch')
    const darkScroll = dark.layout.scrolls.find((scroll) => scroll.node_id === id.paneA)!
    assert.equal(darkScroll.offset[1], offset, 'pane scroll kept across a theme switch')
    const header = bounds(dark, id.header)
    const themed = await screenshot('dark-theme', themes.dark.tokens.colors.surface, [
      [header[0] - 4, header[1] + 4],
    ])
    assert.equal(themed.pixels[0], themes.dark.tokens.colors.surface, 'dark surface displayed')
    outcome('themeSwitch', { pixel: themed.pixels[0]!.toString(16), paneA: bounds(dark, id.paneA) })

    // A newly declared ratio replaces the user's drag.
    await update(
      { ratio: 0.25 },
      () => latestRendered()?.nodes.some((node) => node.element.ratio === 0.25) === true,
      'ratio commit'
    )
    const declared = await painted(
      window,
      (entry) => Math.abs(bounds(entry, id.paneA)[2] - available / 4) <= 1
    )
    snapshots['declared'] = structure(declared)
    outcome('declaredRatio', { paneA: bounds(declared, id.paneA) })

    // An actual window-manager resize keeps the ratio over the new space.
    await resize(640, HEIGHT)
    const wider = await painted(window, (entry) => entry.layout.viewport[0] === 640)
    const widerSplit = bounds(wider, id.split)
    near(bounds(wider, id.paneA)[2], (widerSplit[2] - 2 - SPLIT_DIVIDER) / 4, 'ratio after resize')
    snapshots['resized'] = structure(wider)
    await resize(WIDTH, HEIGHT)
    const restored = await painted(window, (entry) => entry.layout.viewport[0] === WIDTH)
    near(bounds(restored, id.paneA)[2], available / 4, 'ratio after restoring the size')
    outcome('resize', { wider: bounds(wider, id.paneA), restored: bounds(restored, id.paneA) })

    await window.close()
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert.ok(
    Object.values(app.diagnostics).every((count) => count === 0),
    'ownership released'
  )
  outcome('ownershipReleased', app.diagnostics)
  writeFileSync(
    join(output, `layout-style-${adapter}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        adapter,
        mode,
        scale,
        platform: process.platform,
        bun: process.versions.bun,
        revision: Bun.revision,
        display: mac
          ? 'hosted macOS GUI session; screencapture of the owned window'
          : 'isolated Xvfb with openbox',
        input: mac
          ? 'CoreGraphics and Accessibility resize through scripts/quality/native-platform-macos.m'
          : 'XTEST via xdotool',
        ...(macWindow ? { osInput: macWindow.log } : {}),
        geometry: 'nonce-tagged native paint evidence',
        outcomes,
        snapshots,
      },
      null,
      2
    ) + '\n'
  )
  console.log(`Layout style qualification passed (${adapter}, scale ${scale})`)
}
