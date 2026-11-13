/**
 * Viewport culling qualification (native/gpui-host/src/view/culling.rs).
 *
 * Linux only, inside an isolated Xvfb + openbox + DBus session at GPUI's X11
 * scale 1 or 2 (`GPUI_X11_SCALE_FACTOR`). One scroll view holds ROWS rows of a
 * label and a button, far more than it shows, so the host renders the rows
 * outside its keep window as placeholders. Every row's background encodes its
 * index, so a window capture tells which rows are painted where.
 *
 * The scene runs twice, in a fresh host each time: first with the session's
 * assistive technology switched off, then on. Both runs check that Tab and
 * Shift-Tab walk the buttons in tree order through rows that were culled
 * (OS keys from XTEST), that each focused row is scrolled into view and
 * painted, and that `scrollIntoView` and `scrollTo` paint the requested rows.
 * The accessible run also reads the whole tree through the independent AT-SPI
 * client (tests/native/atspi-probe.py): every row's label and button is
 * present in order, wherever it is scrolled, and an AT focus request on a far
 * button focuses and reveals it. Each run then puts the rows inside a list
 * box that wraps them, far taller than the view: Tab, `scrollIntoView` and
 * (accessible run) an AT focus request reveal the row itself, not the top of
 * the list. The host phase trace shows that each run
 * culled rows: `BUN_NATIVE_PHASE_TRACE` names a file that does not exist yet,
 * inherited by each host, which writes it at shutdown; the fixture reads and
 * removes it after each run.
 */
import { createApplication, type NativeNode, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { decodePng } from './png.ts'

const output = process.env['BUN_NATIVE_A11Y_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const atspiPython = process.env['BUN_NATIVE_ATSPI_PYTHON']
const scaleSetting = process.env['GPUI_X11_SCALE_FACTOR']
const trace = process.env['BUN_NATIVE_PHASE_TRACE']
if (
  process.platform !== 'linux' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !atspiPython ||
  !trace ||
  !isAbsolute(trace) ||
  existsSync(trace) ||
  (scaleSetting !== '1' && scaleSetting !== '2') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display at scale 1 or 2, evidence directory, host, AT-SPI Python and a new phase trace path are required'
  )
const SCALE = Number(scaleSetting)
const probe = resolve('tests/native/atspi-probe.py')

const TITLE = 'Bun Native culled list'
const WIDTH = 480
const HEIGHT = 400
const HEADING = 40
const VIEW = 300
// Within atspi-probe.py's bounded dump of 512 entries.
const ROWS = 160
const ROW = 24
// Right of the label and button, left of the scroll bar.
const SAMPLE_X = 360
const MARKER = 0xc0
const color = (index: number) => ((0x20 + (index >> 8)) << 16) | ((index & 0xff) << 8) | MARKER
const rowOf = (rgb: number) =>
  (rgb & 0xff) === MARKER && rgb >> 16 >= 0x20
    ? ((rgb >> 16) - 0x20) * 256 + ((rgb >> 8) & 0xff)
    : -1

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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string | (() => string),
  timeout = 5_000
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + (typeof description === 'string' ? description : description())
      )
    await Bun.sleep(20)
  }
}

type Accessible = { role: string; name: string; states: string[]; text?: string; bounds?: number[] }

const headingElement = (step: number) =>
  ({ kind: 'button', text: 'Before list ' + step, style: { height: HEADING } }) as const

type Scene = {
  heading: NativeNode<'button'>
  view: NativeNode<'box'>
  rows: NativeNode<'box'>[]
  buttons: NativeNode<'button'>[]
}

/**
 * The heading and a scroll view of ROWS rows, replacing `previous`; `wrapped`
 * puts the rows inside one list box in the view instead of directly in it.
 */
async function scene(window: NativeWindow, wrapped = false, previous?: Scene): Promise<Scene> {
  return window.batch((batch) => {
    if (previous) {
      batch.remove(previous.heading)
      batch.remove(previous.view)
    }
    batch.set(window.root, { kind: 'box', style: { direction: 'column', background: 0xffffff } })
    const heading = batch.create(headingElement(0))
    batch.append(window.root, heading)
    const view = batch.create({
      kind: 'box',
      style: { direction: 'column', overflow: 'scroll_y', height: VIEW, flex_shrink: 0 },
    })
    batch.append(window.root, view)
    let list: NativeNode<'box'> = view
    if (wrapped) {
      list = batch.create({
        kind: 'box',
        style: { direction: 'column', flex_shrink: 0 },
        accessible_role: 'list',
      })
      batch.append(view, list)
    }
    const rows: NativeNode<'box'>[] = []
    const buttons: NativeNode<'button'>[] = []
    for (let index = 0; index < ROWS; index += 1) {
      const row = batch.create({
        kind: 'box',
        style: { direction: 'row', gap: 8, height: ROW, background: color(index) },
      })
      batch.append(row, batch.create({ kind: 'text', text: 'Row ' + index }))
      const button = batch.create({ kind: 'button', text: 'Open ' + index })
      batch.append(row, button)
      batch.append(list, row)
      rows.push(row)
      buttons.push(button)
    }
    return { heading, view, rows, buttons }
  })
}

async function qualify(accessible: boolean) {
  const label = accessible ? 'accessible' : 'plain'
  await run([atspiPython!, '-I', probe, accessible ? 'enable' : 'disable'])
  const app = await createApplication({ executable: host! })
  assert(app.capabilities.includes('scroll_control_v1' as never), 'scroll_control_v1')
  try {
    const window = await app.openWindow({ title: TITLE, width: WIDTH, height: HEIGHT })
    const nodes = await scene(window)
    const focused: number[] = []
    nodes.buttons.forEach((button, index) =>
      window.on(button, 'focus', (event) => {
        if (event.node === button) focused.push(index)
      })
    )
    let headingFocused = 0
    window.on(nodes.heading, 'focus', () => void (headingFocused += 1))
    const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split(
      '\n'
    )
    assert.equal(ids.length, 1, 'exactly one owned window')
    const xid = ids[0]!
    await run(['xdotool', 'windowactivate', '--sync', xid])
    const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])

    // The painted rows, top to bottom, sampled at every row height in the view.
    let shots = 0
    const painted = async (name: string) => {
      await Bun.sleep(150)
      const capture = join(output!, `culled-list-${label}-${name}.png`)
      await run(['import', '-window', xid, capture])
      shots += 1
      const png = decodePng(readFileSync(capture))
      const seen: number[] = []
      for (let y = HEADING + 2; y < HEADING + VIEW - 2; y += ROW / 3)
        seen.push(rowOf(png.rgb(SAMPLE_X * SCALE, Math.round(y * SCALE))))
      return seen
    }
    // Every sample is a row, consecutive rows in order, and the target is among them.
    const expectPainted = async (name: string, target: number) => {
      let seen: number[] = []
      await waitFor(
        async () => {
          seen = await painted(name)
          return seen.includes(target) && seen.every((row) => row >= 0)
        },
        () => `row ${target} painted after ${name}; saw ${seen.join(',')}`
      )
      const distinct = [...new Set(seen)]
      for (let index = 1; index < distinct.length; index += 1)
        assert.equal(distinct[index], distinct[index - 1]! + 1, `${name}: rows painted in order`)
      assert(distinct.length >= Math.floor(VIEW / ROW), `${name}: the view is full of rows`)
      return distinct
    }

    record(`${label}.top`, await expectPainted('top', 0))

    // Tab from the heading through the first rows and on into rows that were
    // culled at mount: every press focuses the next button and reveals it.
    await press('Tab')
    await waitFor(() => headingFocused > 0, 'the heading focused')
    const STEPS = 60
    for (let step = 0; step < STEPS; step += 1) {
      // A focus move renders the revealed scroll view whole; an unrelated
      // update first renders it culled, so Tab starts from culled rows.
      await window.batch((batch) => batch.set(nodes.heading, headingElement(step + 1)))
      await Bun.sleep(30)
      await press('Tab')
      await waitFor(() => focused.length === step + 1, `Tab ${step + 1} focuses a button`)
    }
    assert.deepEqual(
      focused,
      Array.from({ length: STEPS }, (_, index) => index),
      'Tab walks the buttons in tree order through culled rows'
    )
    record(`${label}.tabbed`, await expectPainted('tabbed', STEPS - 1))
    for (let step = 0; step < 5; step += 1) await press('shift+Tab')
    await waitFor(() => focused.length === STEPS + 5, 'Shift-Tab focuses buttons')
    assert.deepEqual(
      focused.slice(STEPS),
      [STEPS - 2, STEPS - 3, STEPS - 4, STEPS - 5, STEPS - 6],
      'Shift-Tab walks back in order'
    )

    // Programmatic scrolling to rows far outside the keep window.
    await window.batch((batch) => batch.scrollIntoView(nodes.rows[120]!))
    record(`${label}.scrollIntoView`, await expectPainted('scroll-into-view', 120))
    await window.batch((batch) => batch.scrollTo(nodes.view, { y: 0 }))
    record(`${label}.scrollTop`, await expectPainted('scroll-top', 0))
    await window.batch((batch) => batch.scrollTo(nodes.view, { y: ROWS * ROW }))
    record(`${label}.scrollEnd`, await expectPainted('scroll-end', ROWS - 1))
    // An update inside a culled run while scrolled away is painted on return.
    await window.batch((batch) => {
      batch.set(nodes.rows[60]!, {
        kind: 'box',
        style: { direction: 'row', gap: 8, height: ROW, background: color(61) },
      })
    })
    await window.batch((batch) => batch.scrollTo(nodes.view, { y: 50 * ROW }))
    const back = (await painted('restyled')).filter(
      (row, index, all) => index === 0 || row !== all[index - 1]
    )
    const at = back.indexOf(59)
    assert(at >= 0, 'row 59 painted')
    assert.deepEqual(back.slice(at, at + 3), [59, 61, 62], 'row 60 paints its new background')
    record(`${label}.restyled`, back)

    if (accessible) {
      // The whole tree, in order, while most rows are culled.
      const dump = async () =>
        (
          JSON.parse(await run([atspiPython!, '-I', probe, 'dump', TITLE])) as {
            roles: Accessible[]
          }
        ).roles
      let entries: Accessible[] = []
      await waitFor(
        async () => {
          entries = await dump()
          return entries.filter((entry) => entry.role === 'push-button').length > ROWS
        },
        'the accessible tree',
        10_000
      )
      const buttons = entries
        .filter((entry) => entry.role === 'push-button' && entry.name.startsWith('Open '))
        .map((entry) => entry.name)
      assert.deepEqual(
        buttons,
        Array.from({ length: ROWS }, (_, index) => 'Open ' + index),
        'every row button is exposed in order'
      )
      const labels = entries
        .map((entry) => entry.text ?? entry.name)
        .filter((text) => /^Row \d+$/.test(text))
      assert.deepEqual(
        labels,
        Array.from({ length: ROWS }, (_, index) => 'Row ' + index),
        'every row label is exposed in order'
      )
      record('accessible.tree', {
        entries: entries.length,
        buttons: buttons.length,
        labels: labels.length,
      })

      // An AT focus request on a culled button focuses and reveals it; Tab
      // continues from it and reveals the next row.
      const before = focused.length
      await run([atspiPython!, '-I', probe, 'act', TITLE, 'push-button', 'Open 140', 'focus'])
      await waitFor(() => focused.length > before, 'AT focus on a culled button')
      assert.equal(focused.at(-1), 140, 'the requested button is focused')
      const after = await dump()
      const target = after.find((entry) => entry.name === 'Open 140')
      assert(target?.states.includes('focused'), 'AT-SPI reports the focused button')
      record('accessible.atFocus', await expectPainted('at-focus', 140))
      await press('Tab')
      await waitFor(() => focused.at(-1) === 141, 'Tab after AT focus')
      record('accessible.atFocusTab', await expectPainted('at-focus-tab', 141))
    }

    // The rows inside one list box, far taller than the view: each reveal
    // scrolls the view to the row itself, not to the top of the list.
    const wrapped = await scene(window, true, nodes)
    const wrappedFocused: number[] = []
    wrapped.buttons.forEach((button, index) =>
      window.on(button, 'focus', (event) => {
        if (event.node === button) wrappedFocused.push(index)
      })
    )
    record(`${label}.wrappedTop`, await expectPainted('wrapped-top', 0))
    // Focus left with the replaced scene: Tab reaches the first row button
    // through the new heading.
    for (let attempt = 0; attempt < 3 && wrappedFocused.length === 0; attempt += 1) {
      await press('Tab')
      await Bun.sleep(100)
    }
    await waitFor(() => wrappedFocused.length > 0, 'Tab reaches the wrapped rows')
    assert.deepEqual(wrappedFocused, [0], 'Tab enters the list at its first button')
    const WRAPPED_STEPS = 30
    for (let step = 1; step <= WRAPPED_STEPS; step += 1) {
      await window.batch((batch) => batch.set(wrapped.heading, headingElement(step)))
      await Bun.sleep(30)
      await press('Tab')
      await waitFor(
        () => wrappedFocused.length === step + 1,
        `Tab ${step} focuses a wrapped button`
      )
    }
    assert.deepEqual(
      wrappedFocused,
      Array.from({ length: WRAPPED_STEPS + 1 }, (_, index) => index),
      'Tab walks the wrapped buttons in order'
    )
    record(`${label}.wrappedTabbed`, await expectPainted('wrapped-tabbed', WRAPPED_STEPS))
    await window.batch((batch) => batch.scrollIntoView(wrapped.rows[120]!))
    record(`${label}.wrappedScrollIntoView`, await expectPainted('wrapped-scroll-into-view', 120))
    if (accessible) {
      await window.batch((batch) => batch.scrollTo(wrapped.view, { y: 0 }))
      await expectPainted('wrapped-scroll-top', 0)
      const before = wrappedFocused.length
      await run([atspiPython!, '-I', probe, 'act', TITLE, 'push-button', 'Open 140', 'focus'])
      await waitFor(() => wrappedFocused.length > before, 'AT focus on a wrapped button')
      assert.equal(wrappedFocused.at(-1), 140, 'the requested wrapped button is focused')
      record('accessible.wrappedAtFocus', await expectPainted('wrapped-at-focus', 140))
    }

    record(`${label}.shots`, shots)
    await window.close()
  } finally {
    await app.shutdown()
  }
  const text = readFileSync(trace!, 'utf8')
  rmSync(trace!)
  writeFileSync(join(output!, `culled-list-${label}-phases.json`), text)
  const phases = JSON.parse(text) as {
    frameColumns: string[]
    frames: number[][]
  }
  const column = phases.frameColumns.indexOf('culledNodes')
  assert(column >= 0, 'the phase trace reports culled nodes')
  const culled = phases.frames.map((frame) => frame[column]!)
  assert(Math.max(...culled) >= ROWS / 2, `${label}: the host culled rows (${Math.max(...culled)})`)
  // Most Tab presses left a culled frame.
  const culledFrames = culled.filter((count) => count > 0).length
  assert(culledFrames >= 40, `${label}: ${culledFrames} culled frames`)
  record(`${label}.culled`, { max: Math.max(...culled), frames: culledFrames })
}

await qualify(false)
await qualify(true)
writeFileSync(
  join(output, 'result.json'),
  JSON.stringify({ title: TITLE, rows: ROWS, scale: SCALE, outcomes }, null, 2) + '\n'
)
console.log(JSON.stringify({ status: 'passed', ms: Math.round(performance.now() - started) }))
process.exit(0)
