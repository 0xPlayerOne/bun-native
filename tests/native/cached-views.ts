/**
 * Cached child views qualification (native/gpui-host/src/view/caching.rs).
 *
 * Linux only, inside an isolated Xvfb + openbox + DBus session at GPUI's X11
 * scale 1 or 2 (`GPUI_X11_SCALE_FACTOR`), with the session's assistive
 * technology switched off (caching is off while it reads the window). The
 * same scripted scene runs twice, each in a fresh host: once with caching
 * off (`BUN_NATIVE_VIEW_CACHE=0`) and once with it on. The scene is a
 * toolbar, an input, a split and a scroll view of rows, more than 128 nodes
 * so that no layout evidence is captured. Batches touch one node at a time
 * (label text, labels of one row per frame in quick succession, a restyle
 * that resizes a row, an insert and a delete), real OS clicks hit buttons
 * inside unchanged rows, Tab walks the buttons, typing reaches the input, a
 * modal overlay opens, traps Tab and closes, the list scrolls by wheel and
 * `scrollTo`, and the split ratio changes. Both runs must route the same
 * focus, click and input events in the same order and paint pixel-identical
 * window captures at every checkpoint, and the phase trace (`cachedViews`)
 * must show that the caching run replayed cached views and the other none.
 */
import { createApplication, type NativeNode, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { decodePng } from './png.ts'

const output = process.env['BUN_NATIVE_CACHE_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const atspiPython = process.env['BUN_NATIVE_ATSPI_PYTHON']
const scaleSetting = process.env['GPUI_X11_SCALE_FACTOR']
if (
  process.platform !== 'linux' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !atspiPython ||
  (scaleSetting !== '1' && scaleSetting !== '2') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display at scale 1 or 2, evidence directory, host and AT-SPI Python are required'
  )
const SCALE = Number(scaleSetting)
const probe = resolve('tests/native/atspi-probe.py')

const TITLE = 'Bun Native cached views'
const WIDTH = 520
const HEIGHT = 520
const TOOLBAR = 44
const INPUT = 32
const STATUS = 20
const SPLIT = 80
const LIST_TOP = TOOLBAR + INPUT + STATUS + SPLIT
const VIEW = 240
const ROWS = 60
const ROW = 28
const LABEL = 140
const BUTTON = 90
/** The centre of row `index`'s button while rows 0 to 4 keep their height. */
const rowButton = (index: number) => [2 + LABEL + 8 + BUTTON / 2, LIST_TOP + index * ROW + ROW / 2]

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor(check: () => boolean, description: string, timeout = 5_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(20)
  }
}

const rowColor = (index: number) => (index % 2 === 0 ? 0xeef3f8 : 0xf8f1e8)

type Scene = {
  input: NativeNode<'input'>
  status: NativeNode<'text'>
  split: NativeNode<'split'>
  aside: NativeNode<'text'>
  view: NativeNode<'box'>
  rows: NativeNode<'box'>[]
  labels: NativeNode<'text'>[]
  heading: NativeNode<'button'>
}

function scene(
  window: NativeWindow,
  named: <N extends NativeNode>(node: N, label: string) => N
): Promise<Scene> {
  return window.batch((batch) => {
    batch.set(window.root, { kind: 'box', style: { direction: 'column', background: 0xffffff } })
    const toolbar = batch.create({
      kind: 'box',
      style: { direction: 'row', gap: 8, height: TOOLBAR, align_items: 'center', flex_shrink: 0 },
    })
    batch.append(window.root, toolbar)
    batch.append(
      toolbar,
      batch.create({ kind: 'text', text: 'Cached views', style: { width: LABEL } })
    )
    const heading = named(
      batch.create({ kind: 'button', text: 'Add row', style: { width: 100 } }),
      'heading'
    )
    batch.append(toolbar, heading)
    batch.append(
      toolbar,
      named(batch.create({ kind: 'button', text: 'Settings', style: { width: 100 } }), 'settings')
    )
    const input = named(
      batch.create({ kind: 'input', value: '', style: { width: 'fill', height: INPUT } }),
      'input'
    )
    batch.append(window.root, input)
    const status = batch.create({
      kind: 'text',
      text: 'Typed: ',
      style: { height: STATUS, flex_shrink: 0 },
    })
    batch.append(window.root, status)
    const split = batch.create({
      kind: 'split',
      ratio: 0.4,
      min_size: 60,
      style: { height: SPLIT, flex_shrink: 0 },
    })
    batch.append(window.root, split)
    const left = batch.create({
      kind: 'box',
      style: { direction: 'column', gap: 4, padding: 4, background: 0xe8f0e8 },
    })
    batch.append(split, left)
    batch.append(left, batch.create({ kind: 'text', text: 'Sidebar' }))
    batch.append(left, batch.create({ kind: 'text', text: 'Second line' }))
    const right = batch.create({
      kind: 'box',
      style: { align_items: 'center', justify_content: 'center', background: 0xf0e8f0 },
    })
    batch.append(split, right)
    const aside = batch.create({ kind: 'text', text: 'Detail pane' })
    batch.append(right, aside)
    const view = batch.create({
      kind: 'box',
      style: { direction: 'column', overflow: 'scroll_y', height: VIEW, flex_shrink: 0 },
    })
    batch.append(window.root, view)
    const rows: NativeNode<'box'>[] = []
    const labels: NativeNode<'text'>[] = []
    for (let index = 0; index < ROWS; index += 1) {
      const nested = index % 10 === 5
      const row = batch.create({
        kind: 'box',
        style: {
          direction: 'row',
          gap: 8,
          padding: 2,
          background: rowColor(index),
          ...(nested ? {} : { height: ROW }),
        },
      })
      const label = batch.create({ kind: 'text', text: 'Row ' + index, style: { width: LABEL } })
      if (nested) {
        const column = batch.create({ kind: 'box', style: { direction: 'column', gap: 2 } })
        batch.append(column, label)
        batch.append(column, batch.create({ kind: 'text', text: 'Details of ' + index }))
        batch.append(row, column)
      } else batch.append(row, label)
      batch.append(
        row,
        named(
          batch.create({
            kind: 'button',
            text: 'Open ' + index,
            style: { width: BUTTON, height: ROW - 4 },
          }),
          'open ' + index
        )
      )
      batch.append(view, row)
      rows.push(row)
      labels.push(label)
    }
    batch.append(window.root, batch.create({ kind: 'text', text: 'Footer' }))
    return { input, status, split, aside, view, rows, labels, heading }
  })
}

type Capture = { width: number; height: number; pixels: Uint32Array }

/** One run of the scene; returns its routed events and checkpoint captures. */
async function session(caching: boolean) {
  const label = caching ? 'cached' : 'uncached'
  const trace = join(output!, `trace-${label}.json`)
  rmSync(trace, { force: true })
  process.env['BUN_NATIVE_VIEW_CACHE'] = caching ? '1' : '0'
  process.env['BUN_NATIVE_PHASE_TRACE'] = trace
  await run([atspiPython!, '-I', probe, 'disable'])
  const app = await createApplication({ executable: host! })
  delete process.env['BUN_NATIVE_PHASE_TRACE']
  delete process.env['BUN_NATIVE_VIEW_CACHE']
  const events: string[] = []
  const captures = new Map<string, Capture>()
  try {
    const window = await app.openWindow({ title: TITLE, width: WIDTH, height: HEIGHT })
    const names = new Map<NativeNode, string>()
    const name = (node: NativeNode) => names.get(node) ?? 'unnamed'
    const named = <N extends NativeNode>(node: N, label: string) => {
      names.set(node, label)
      return node
    }
    window.on(window.root, 'focus', (event) => void events.push('focus ' + name(event.node)), {
      capture: true,
    })
    window.on(window.root, 'click', (event) => void events.push('click ' + name(event.node)), {
      capture: true,
    })
    const nodes = await scene(window, named)
    window.on(nodes.input, 'input', (event) => {
      events.push('input ' + event.value)
      void window.batch((batch) =>
        batch.set(nodes.status, {
          kind: 'text',
          text: 'Typed: ' + event.value,
          style: { height: STATUS, flex_shrink: 0 },
        })
      )
    })
    const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split(
      '\n'
    )
    assert.equal(ids.length, 1, 'exactly one owned window')
    const xid = ids[0]!
    await run(['xdotool', 'windowactivate', '--sync', xid])
    const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])
    const click = async ([x, y]: number[], button = '1') => {
      await run([
        'xdotool',
        'mousemove',
        '--window',
        xid,
        String(Math.round(x! * SCALE)),
        String(Math.round(y! * SCALE)),
        'click',
        button,
      ])
    }
    const count = (prefix: string) => events.filter((event) => event.startsWith(prefix)).length

    // A capture once two in a row agree, so the paint has settled.
    const checkpoint = async (name: string) => {
      let previous: Capture | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Bun.sleep(attempt === 0 ? 200 : 100)
        const file = join(output!, `${label}-${name}.png`)
        await run(['import', '-window', xid, file])
        const png = decodePng(readFileSync(file))
        const pixels = new Uint32Array(png.width * png.height)
        for (let y = 0; y < png.height; y += 1)
          for (let x = 0; x < png.width; x += 1) pixels[y * png.width + x] = png.rgb(x, y)
        const capture = { width: png.width, height: png.height, pixels }
        if (previous && same(previous, capture) === 0) {
          captures.set(name, capture)
          return
        }
        previous = capture
      }
      throw new Error(`${label} ${name}: the window never settled`)
    }

    await checkpoint('mount')

    // One label changes; then a restyle resizes one row and moves the rest.
    await window.batch((batch) =>
      batch.set(nodes.labels[3]!, {
        kind: 'text',
        text: 'Row 3 renamed',
        style: { width: LABEL },
      })
    )
    await checkpoint('label')
    await window.batch((batch) =>
      batch.set(nodes.rows[1]!, {
        kind: 'box',
        style: { direction: 'row', gap: 8, padding: 2, background: 0xd8e8ff, height: ROW + 12 },
      })
    )
    await checkpoint('restyle')
    await window.batch((batch) =>
      batch.set(nodes.rows[1]!, {
        kind: 'box',
        style: { direction: 'row', gap: 8, padding: 2, background: rowColor(1), height: ROW },
      })
    )
    await checkpoint('restored')

    // Labels change in quick succession, one row per frame: each row renders
    // after a frame that replayed it, so its unchanged button, which GPUI
    // last visited frames ago, must render with it and not replay.
    for (let step = 0; step < 16; step += 1) {
      const index = 6 + ((step * 5) % 12)
      await window.batch((batch) =>
        batch.set(nodes.labels[index]!, {
          kind: 'text',
          text: `Row ${index} #${step}`,
          style: { width: LABEL },
        })
      )
      await Bun.sleep(40)
    }
    await checkpoint('relabeled')

    // Insert a row above the clicked ones and delete it again: the rows
    // below move twice; clicks must still reach the button under the pointer.
    const inserted = await window.batch((batch) => {
      const row = batch.create({
        kind: 'box',
        style: { direction: 'row', gap: 8, padding: 2, height: ROW, background: 0xfff0c0 },
      })
      batch.append(row, batch.create({ kind: 'text', text: 'Inserted', style: { width: LABEL } }))
      batch.append(
        row,
        named(
          batch.create({ kind: 'button', text: 'New', style: { width: BUTTON, height: ROW - 4 } }),
          'new'
        )
      )
      batch.insert(nodes.view, row, 0)
      return row
    })
    await checkpoint('inserted')
    await click(rowButton(0))
    await click(rowButton(2))
    await waitFor(() => count('click') === 2, 'two clicks with a row inserted')
    await window.batch((batch) => batch.remove(inserted))
    await checkpoint('removed')
    await click(rowButton(3))
    await waitFor(() => count('click') === 3, 'a click after the delete')

    // Tab from the clicked button through the following rows.
    const focusBefore = count('focus')
    for (let step = 1; step <= 6; step += 1) {
      await press('Tab')
      await waitFor(() => count('focus') >= focusBefore + step, `Tab ${step}`)
    }
    await checkpoint('tabbed')

    // Typing reaches the input; each event updates the status label.
    await window.batch((batch) => batch.focus(nodes.input))
    await run(['xdotool', 'type', '--delay', '30', 'cache me'])
    await waitFor(() => events.at(-1) === 'input cache me', 'the typed text')
    await window.batch((batch) => batch.focus(nodes.heading))
    await waitFor(() => events.at(-1) === 'focus heading', 'focus back on the toolbar')
    await checkpoint('typed')

    // A modal overlay over the cached rows traps Tab, then closes.
    const dialog = await window.batch((batch) => {
      const layer = batch.create({
        kind: 'overlay',
        modal: true,
        style: { align_items: 'center', justify_content: 'center', background: 0x334455 },
      })
      const panel = batch.create({
        kind: 'box',
        style: { width: 260, padding: 12, gap: 8, background: 0xffffff },
      })
      batch.append(panel, batch.create({ kind: 'text', text: 'Dialog' }))
      batch.append(panel, named(batch.create({ kind: 'button', text: 'Confirm' }), 'confirm'))
      batch.append(panel, named(batch.create({ kind: 'button', text: 'Cancel' }), 'cancel'))
      batch.append(layer, panel)
      batch.append(window.root, layer)
      return layer
    })
    await checkpoint('modal')
    const trapped = count('focus')
    for (let step = 1; step <= 3; step += 1) {
      await press('Tab')
      await waitFor(() => count('focus') >= trapped + step, `modal Tab ${step}`)
    }
    await checkpoint('modal-tabbed')
    await window.batch((batch) => batch.remove(dialog))
    await checkpoint('closed')

    // Wheel over the list, then scroll by command and change a visible row.
    await run([
      'xdotool',
      'mousemove',
      '--window',
      xid,
      String(Math.round(60 * SCALE)),
      String(Math.round((LIST_TOP + VIEW / 2) * SCALE)),
    ])
    for (let step = 0; step < 4; step += 1) await run(['xdotool', 'click', '5'])
    await checkpoint('wheel')
    await window.batch((batch) => batch.scrollTo(nodes.view, { y: 30 * ROW }))
    await checkpoint('scrolled')
    await window.batch((batch) =>
      batch.set(nodes.labels[33]!, {
        kind: 'text',
        text: 'Row 33 renamed',
        style: { width: LABEL },
      })
    )
    await checkpoint('scrolled-label')

    // The split's ratio moves both panes; a pane's text changes after.
    await window.batch((batch) =>
      batch.set(nodes.split, {
        kind: 'split',
        ratio: 0.6,
        min_size: 60,
        style: { height: SPLIT, flex_shrink: 0 },
      })
    )
    await checkpoint('split')
    await window.batch((batch) => batch.set(nodes.aside, { kind: 'text', text: 'Detail changed' }))
    await checkpoint('split-text')
    await window.close()
  } finally {
    await app.shutdown()
    await app.closed
  }
  const recorded = JSON.parse(readFileSync(trace, 'utf8')) as {
    frameColumns: string[]
    frames: unknown[][]
  }
  rmSync(trace)
  const column = recorded.frameColumns.indexOf('cachedViews')
  assert(column >= 0, 'the phase trace records cached views')
  const cachedViews = recorded.frames.reduce((sum, frame) => sum + Number(frame[column]), 0)
  return { events, captures, cachedViews }
}

/** The number of differing pixels; every pixel when the sizes differ. */
function same(left: Capture, right: Capture) {
  if (left.width !== right.width || left.height !== right.height)
    return Math.max(left.pixels.length, right.pixels.length)
  let differing = 0
  for (let index = 0; index < left.pixels.length; index += 1)
    if (left.pixels[index] !== right.pixels[index]) differing += 1
  return differing
}

const plain = await session(false)
record('uncached.events', plain.events.length)
const cached = await session(true)
record('cached.events', cached.events.length)

assert.equal(plain.cachedViews, 0, 'caching off replays no cached view')
assert(cached.cachedViews > 0, 'caching on replays cached views')
record('cachedViews', cached.cachedViews)
assert.deepEqual(cached.events, plain.events, 'the same events in the same order')
assert(plain.events.includes('click new'), 'a click reached the inserted row')
const differences: Record<string, number> = {}
for (const [name, capture] of plain.captures) {
  const other = cached.captures.get(name)
  assert(other, `${name}: captured with caching on`)
  differences[name] = same(capture, other)
}
record('differingPixels', differences)
for (const [name, count] of Object.entries(differences))
  assert.equal(count, 0, `${name}: the cached run paints the same pixels`)
// The uncached captures stay as evidence; the cached ones are identical.
for (const name of plain.captures.keys())
  rmSync(join(output!, `cached-${name}.png`), { force: true })
writeFileSync(
  join(output!, 'result.json'),
  JSON.stringify({ status: 'passed', scale: SCALE, events: plain.events, outcomes }, null, 2) + '\n'
)
console.log(JSON.stringify({ status: 'passed', ms: Math.round(performance.now() - started) }))
