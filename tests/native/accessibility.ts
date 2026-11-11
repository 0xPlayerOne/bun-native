/**
 * Real accessibility-role and keyboard split-divider qualification.
 *
 * Linux: inside an isolated Xvfb + openbox + DBus session at scale 1. OS input
 * comes from XTEST (xdotool). Roles, names, states and values are read by an
 * independent AT-SPI client (tests/native/atspi-probe.py) over the session
 * accessibility bus; focus and resize events come from public Bun APIs; the
 * divider focus ring is read from a capture of the displayed window.
 *
 * macOS: the same scene and steps in the hosted runner's GUI session. OS input
 * is CoreGraphics key and pointer events through the bounded SDK helper
 * (tests/native/macos-window-input.ts); the tree is read and requested through
 * the independent AXUIElement client (tests/native/macos-accessibility-oracle.m)
 * and normalized to the AT-SPI vocabulary below; the focus ring is read from a
 * `screencapture` of the owned window.
 */
import {
  createApplication,
  onSplitResize,
  type NativeNode,
  type NativeWindow,
  type SplitResizeEvent,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { hostPid, MacWindow } from './macos-window-input.ts'

const output = process.env['BUN_NATIVE_A11Y_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_A11Y_MODE']
// The independent AT-SPI client is a separate system Python with PyGObject.
const atspiPython = process.env['BUN_NATIVE_ATSPI_PYTHON']
const mac = process.platform === 'darwin'
// macOS: the compiled AXUIElement client and the bounded CoreGraphics helper.
const axOracle = process.env['BUN_NATIVE_A11Y_ORACLE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  (mac
    ? !axOracle || !isAbsolute(axOracle) || !process.env['BUN_NATIVE_PLATFORM_HELPER']
    : !atspiPython ||
      process.env['GPUI_X11_SCALE_FACTOR'] !== '1' ||
      !process.env['DISPLAY'] ||
      process.env['WAYLAND_DISPLAY'])
)
  throw new Error(
    mac
      ? 'macOS needs an evidence directory, host, mode, the AX oracle and the OS input helper'
      : 'An isolated X11 display at scale 1, evidence directory, host, mode and AT-SPI Python are required'
  )
const host = executable
// Resolved from the checkout, not import.meta, so the AOT executable finds it too.
const probe = resolve('tests/native/atspi-probe.py')

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
  check: () => boolean,
  description: string,
  timeout = 5_000,
  observed?: () => string
) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + description + (observed ? '; observed ' + observed() : '')
      )
    await Bun.sleep(5)
  }
}

type Accessible = {
  role: string
  name: string
  states: string[]
  depth: number
  text?: string
  caret?: number
  selections?: number[][]
  extents?: number[][]
  value?: { current: number; minimum: number; maximum: number }
}

const TITLE = 'Bun Native accessibility qualification'
const WIDTH = 640
const HEIGHT = 480
// Fixed geometry: the split starts below the heading and the scroll view.
const HEADING = 28
const SCROLL = 60
const SPLIT_WIDTH = 600
const SPLIT_HEIGHT = 160
const MIN_PANE = 100
const DIVIDER = 6
const PANES = SPLIT_WIDTH - DIVIDER
const SPLIT_Y = HEADING + SCROLL + SPLIT_HEIGHT / 2
const near = (actual: number | undefined, expected: number, label: string, tolerance = 1e-3) =>
  assert(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not ${expected}`
  )

/** AppKit roles as the AT-SPI roles AccessKit gives the same nodes on Linux. */
const MAC_ROLES: Record<string, string> = {
  AXStaticText: 'label',
  AXButton: 'push-button',
  AXTextField: 'entry',
  AXSplitter: 'separator',
  // AccessKit's ScrollView (and only that container here) is AXUnknown.
  AXUnknown: 'panel',
  // AccessKit exposes a Dialog as AXWindow with the AXDialog subrole.
  AXWindow: 'dialog',
}
// The NSWindow's own title-bar buttons, outside the GPUI content.
const WINDOW_BUTTONS = new Set([
  'AXCloseButton',
  'AXMinimizeButton',
  'AXZoomButton',
  'AXFullScreenButton',
])
const flag = (value: unknown) => value === true || value === 1
/**
 * One AXUIElement dump entry in the Linux probe's shape. Names are the AX
 * title, then description, then a label's value; states come from AXFocused,
 * AXEnabled, a settable AXFocused (AccessKit's focusable), AXOrientation,
 * AXModal and a settable entry value; UTF-16 selection [start, length]
 * becomes the AT-SPI caret or selection.
 */
function fromAx(entry: Record<string, unknown>): Accessible {
  const native = String(entry['role'])
  const role = MAC_ROLES[native] ?? native
  const value = entry['value']
  const states: string[] = []
  if (flag(entry['focused'])) states.push('focused')
  if (flag(entry['focusSettable'])) states.push('focusable')
  if (flag(entry['enabled'])) states.push('enabled')
  if (entry['orientation'] === 'AXVerticalOrientation') states.push('vertical')
  if (entry['orientation'] === 'AXHorizontalOrientation') states.push('horizontal')
  if (flag(entry['modal'])) states.push('modal')
  if (role === 'entry' && flag(entry['valueSettable'])) states.push('editable')
  const result: Accessible = {
    role,
    name:
      String(entry['title'] ?? '') ||
      String(entry['description'] ?? '') ||
      (role === 'label' && typeof value === 'string' ? value : ''),
    states: states.sort(),
    depth: Number(entry['depth']),
  }
  if (role === 'entry') {
    result.text = typeof value === 'string' ? value : ''
    const selection = entry['selection'] as [number, number] | null
    if (selection) {
      result.caret = selection[0] + selection[1]
      result.selections = selection[1] > 0 ? [[selection[0], selection[0] + selection[1]]] : []
    }
    const extents = entry['extents'] as number[][] | null
    if (extents) result.extents = extents
  }
  if (role === 'separator' && typeof value === 'number')
    result.value = {
      current: value,
      minimum: Number(entry['minimum']),
      maximum: Number(entry['maximum']),
    }
  return result
}
/** Entries outside the GPUI content: title-bar buttons and AccessKit's root group. */
const frame = (entry: Record<string, unknown>) =>
  WINDOW_BUTTONS.has(String(entry['subrole'])) || entry['role'] === 'AXGroup'

if (mac) {
  const trust = JSON.parse(await run([axOracle!, 'trusted'])) as { trusted: boolean }
  assert.equal(trust.trusted, true, 'the runner trusts the AX oracle for Accessibility')
} else await run([atspiPython!, '-I', probe, 'enable'])
const app = await createApplication({ executable: host })
for (const capability of ['split_v1', 'overlays_v1', 'split_resize_v1', 'accessibility_v1'])
  assert(app.capabilities.includes(capability as never), capability)

let window: NativeWindow | undefined
let macWindow: MacWindow | undefined
try {
  window = await app.openWindow({ title: TITLE, width: WIDTH, height: HEIGHT })
  const owned = window
  const nodes = await owned.batch((batch) => {
    const add = <N extends NativeNode>(
      parent: NativeNode<'box' | 'split' | 'overlay'>,
      node: N
    ) => {
      batch.append(parent, node)
      return node
    }
    batch.set(owned.root, { kind: 'box', style: { direction: 'column', background: 0xffffff } })
    add(
      owned.root,
      batch.create({
        kind: 'text',
        text: 'Accessibility qualification',
        style: { height: HEADING },
      })
    )
    const list = add(
      owned.root,
      batch.create({ kind: 'box', style: { overflow: 'scroll_y', height: SCROLL } })
    )
    for (const index of [1, 2, 3]) {
      const item = add(list, batch.create({ kind: 'box', style: { height: 24 } }))
      add(item, batch.create({ kind: 'text', text: 'Item ' + index }))
    }
    const split = add(
      owned.root,
      batch.create({
        kind: 'split',
        ratio: 0.4,
        min_size: MIN_PANE,
        accessible_label: 'Sidebar',
        style: { width: SPLIT_WIDTH, height: SPLIT_HEIGHT, flex_shrink: 0 },
      })
    )
    const leading = add(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
    const action = add(leading, batch.create({ kind: 'button', text: 'Leading action' }))
    const trailing = add(split, batch.create({ kind: 'box', style: { width: 'fill' } }))
    const search = add(
      trailing,
      batch.create({ kind: 'input', value: 'typed', placeholder: 'Search', style: { height: 40 } })
    )
    add(trailing, batch.create({ kind: 'button', text: 'Disabled action', disabled: true }))
    const open = add(
      owned.root,
      batch.create({ kind: 'button', text: 'Open dialog', style: { height: 40 } })
    )
    return { split, action, search, open }
  })
  const focusTrace: string[] = []
  const names = new Map<NativeNode, string>([
    [nodes.split, 'divider'],
    [nodes.action, 'action'],
    [nodes.search, 'search'],
    [nodes.open, 'open'],
  ])
  const watchFocus = (node: NativeNode, name: string) => {
    // Focus events bubble: the split also sees its panes' controls.
    owned.on(node, 'focus', (event) => {
      if (event.node === node) focusTrace.push(name)
    })
    owned.on(node, 'blur', (event) => {
      if (event.node === node) focusTrace.push('-' + name)
    })
  }
  for (const [node, name] of names) watchFocus(node, name)
  const resizes: SplitResizeEvent[] = []
  onSplitResize(owned, nodes.split, (event) => void resizes.push(event))
  const searchValues: string[] = []
  owned.onInput(nodes.search, (event) => void searchValues.push(event.value))
  let actionClicks = 0
  owned.onClick(nodes.action, () => void (actionClicks += 1))
  const keyTargets: string[] = []
  owned.on(nodes.split, 'key_down', (event) => {
    if (event.node === nodes.split) keyTargets.push(event.key)
  })

  let dialog:
    | {
        overlay: NativeNode<'overlay'>
        confirm: NativeNode<'button'>
        cancel: NativeNode<'button'>
      }
    | undefined
  owned.onClick(nodes.open, async () => {
    dialog = await owned.batch((batch) => {
      const overlay = batch.create({
        kind: 'overlay',
        modal: true,
        accessible_label: 'Confirm dialog',
        style: { padding: 24, gap: 8, background: 0xf4f5f7 },
      })
      batch.append(owned.root, overlay)
      batch.append(overlay, batch.create({ kind: 'text', text: 'Discard changes?' }))
      const confirm = batch.create({ kind: 'button', text: 'Confirm' })
      const cancel = batch.create({ kind: 'button', text: 'Cancel' })
      batch.append(overlay, confirm)
      batch.append(overlay, cancel)
      return { overlay, confirm, cancel }
    })
    watchFocus(dialog.confirm, 'confirm')
    watchFocus(dialog.cancel, 'cancel')
    owned.onClick(dialog.cancel, () =>
      owned.batch((batch) => {
        batch.remove(dialog!.overlay)
        dialog = undefined
      })
    )
  })

  let xid = ''
  let pid = 0
  if (mac) {
    pid = await hostPid(host)
    macWindow = await MacWindow.open(TITLE, host, () => [WIDTH, HEIGHT])
  } else {
    const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split(
      '\n'
    )
    assert.equal(ids.length, 1, 'exactly one owned window')
    xid = ids[0]!
    await run(['xdotool', 'windowactivate', '--sync', xid])
  }
  const press = async (...keys: string[]) => {
    if (macWindow) await macWindow.press(...keys)
    else await run(['xdotool', 'key', '--clearmodifiers', ...keys])
  }
  const dumps: Record<string, unknown> = {}
  const dump = async (name: string) => {
    if (mac) {
      const raw = JSON.parse(await run([axOracle!, 'dump', String(pid), TITLE])) as Array<
        Record<string, unknown>
      >
      dumps[name] = raw
      // Every entry is either window frame or a node with a known role.
      const unknown = raw.filter((entry) => !frame(entry) && !MAC_ROLES[String(entry['role'])])
      assert.deepEqual(unknown, [], 'every GPUI content node has a mapped AX role')
      return raw.filter((entry) => !frame(entry)).map(fromAx)
    }
    const tree = JSON.parse(await run([atspiPython!, '-I', probe, 'dump', TITLE])) as {
      roles: Accessible[]
    }
    dumps[name] = tree.roles
    return tree.roles
  }
  /** Poll the AT-SPI tree until the condition holds; AccessKit updates after a frame. */
  const poll = async (name: string, check: (tree: Accessible[]) => boolean) => {
    const until = performance.now() + 5_000
    for (;;) {
      const tree = await dump(name)
      if (check(tree)) return tree
      if (performance.now() > until)
        throw new Error('Timed out waiting for AT-SPI ' + name + ': ' + JSON.stringify(tree))
      await Bun.sleep(50)
    }
  }
  const find = (tree: Accessible[], role: string, name: string) =>
    tree.find((node) => node.role === role && node.name === name)
  const separator = (tree: Accessible[]) => find(tree, 'separator', 'Sidebar')

  // The first enabled input owns initial focus once the window is active.
  await waitFor(() => focusTrace.includes('search'), 'initial input focus')

  // Every element kind's accessible node, before any interaction.
  const initial = await poll('initial', (tree) => {
    const entry = tree.find((node) => node.role === 'entry')
    return entry?.states.includes('focused') === true && separator(tree) !== undefined
  })
  assert(find(initial, 'label', 'Accessibility qualification'), 'text is a label named by its text')
  const scrollIndex = initial.findIndex((node) => node.role === 'panel')
  assert(scrollIndex >= 0, 'the scrolling box is a panel (AccessKit ScrollView)')
  const scrollView = initial[scrollIndex]!
  const scrolled = initial
    .slice(scrollIndex + 1)
    .filter((node) => node.depth > scrollView.depth)
    .map((node) => node.name)
  assert.deepEqual(scrolled.slice(0, 3), ['Item 1', 'Item 2', 'Item 3'], 'list items inside it')
  const divider = separator(initial)
  assert(divider, 'the divider is a separator named by accessible_label')
  assert(divider.states.includes('focusable') && !divider.states.includes('focused'))
  assert(divider.states.includes('vertical'), 'a row split has a vertical divider')
  near(divider.value?.current, 40, 'divider value is the ratio in percent')
  near(divider.value?.minimum, (MIN_PANE / PANES) * 100, 'divider minimum from min_size')
  near(divider.value?.maximum, (1 - MIN_PANE / PANES) * 100, 'divider maximum from min_size')
  const action = find(initial, 'push-button', 'Leading action')
  assert(action?.states.includes('focusable') && action.states.includes('enabled'))
  const disabled = find(initial, 'push-button', 'Disabled action')
  assert(disabled, 'the disabled button is exposed by name')
  // AccessKit 0.24's AT-SPI adapter reports `enabled`/`sensitive` for every
  // button; a disabled one is distinguishable only as not focusable.
  assert(!disabled.states.includes('focusable'), 'a disabled button is not focusable')
  const entry = initial.find((node) => node.role === 'entry')
  assert.equal(entry?.text, 'typed')
  assert(entry.states.includes('focused') && entry.states.includes('editable'))
  assert(find(initial, 'push-button', 'Open dialog'))
  assert(!initial.some((node) => node.role === 'dialog'), 'no dialog before it opens')
  assert(
    !initial.some((node) => node.states.includes('checked') || node.states.includes('checkable')),
    'no element reports a checked state'
  )
  // A plain box has no node: only the kinds above appear.
  const roles = [...new Set(initial.map((node) => node.role))].sort()
  assert.deepEqual(roles, ['entry', 'label', 'panel', 'push-button', 'separator'])
  record('initialTree', { roles, nodes: initial.length })

  // Character bounds come from the painted glyphs: each character of the
  // entry has a box, left to right, inside the entry.
  const boxes = entry.extents ?? []
  assert.equal(boxes.length, 'typed'.length)
  for (const [index, box] of boxes.entries()) {
    assert(box[2]! > 0 && box[3]! > 0, 'a painted character has a non-empty box')
    if (index > 0) assert(box[0]! >= boxes[index - 1]![0]! + boxes[index - 1]![2]! - 1)
  }
  record('characterBounds', boxes)

  // Requests from an assistive technology, through AT-SPI: caret and
  // selection moves reach the host model (later OS typing lands there), a
  // button's action clicks it, grab_focus focuses, and the divider's Value
  // interface sets its ratio.
  /** One AT request; macOS names the AX attribute or action that carries it. */
  const act = (role: string, name: string, ...request: string[]) => {
    if (!mac) return run([atspiPython!, '-I', probe, 'act', TITLE, role, name, ...request])
    const native = Object.entries(MAC_ROLES).find(([, mapped]) => mapped === role)![0]
    const [verb, ...args] = request
    const translated =
      verb === 'caret'
        ? ['select', args[0]!, '0']
        : verb === 'select'
          ? ['select', args[0]!, String(Number(args[1]) - Number(args[0]))]
          : verb === 'click'
            ? ['press']
            : verb === 'value'
              ? ['number', ...args]
              : [verb!, ...args]
    return run([axOracle!, 'act', String(pid), TITLE, native, name, ...translated])
  }
  const entryText = (tree: Accessible[]) => tree.find((node) => node.role === 'entry')
  await act('entry', 'typed', 'caret', '2')
  await poll('caret set', (tree) => entryText(tree)?.caret === 2)
  await press('X')
  await waitFor(
    () => searchValues.at(-1) === 'tyXped',
    'typing at the AT caret',
    5_000,
    () => searchValues.join()
  )
  await act('entry', 'tyXped', 'select', '0', '2')
  const selected = await poll(
    'selection set',
    (tree) => JSON.stringify(entryText(tree)?.selections) === '[[0,2]]'
  )
  await press('Z')
  await waitFor(() => searchValues.at(-1) === 'ZXped', 'typing over the AT selection')
  focusTrace.length = 0
  await act('push-button', 'Leading action', 'click')
  await waitFor(
    () => actionClicks === 1,
    'AT click',
    5_000,
    () => focusTrace.join()
  )
  await act('entry', 'ZXped', 'focus')
  await waitFor(
    () => focusTrace.at(-1) === 'search',
    'AT focus',
    5_000,
    () => focusTrace.join()
  )
  const resizedFrom = resizes.length
  await act('separator', 'Sidebar', 'value', '30')
  await waitFor(() => resizes.length === resizedFrom + 1, 'AT divider value')
  near(resizes.at(-1)!.ratio, 0.3, 'AT-set ratio', 1e-9)
  assert.equal(resizes.at(-1)!.source, 'keyboard', 'an AT step is a discrete keyboard resize')
  await poll(
    'divider value set',
    (tree) => Math.abs((separator(tree)?.value?.current ?? -1) - 30) < 1e-6
  )
  await act('separator', 'Sidebar', 'value', '1')
  await waitFor(() => resizes.length === resizedFrom + 2, 'AT divider value clamped')
  near(resizes.at(-1)!.ratio, MIN_PANE / PANES, 'AT value clamps to min_size', 1e-9)
  await act('separator', 'Sidebar', 'value', '40')
  await waitFor(() => resizes.length === resizedFrom + 3, 'AT divider value restored')
  near(resizes.at(-1)!.ratio, 0.4, 'restored ratio', 1e-9)
  record('assistiveActions', {
    values: searchValues.slice(),
    selection: entryText(selected)?.selections,
    clicks: actionClicks,
    focus: focusTrace.slice(),
    ratios: resizes.slice(resizedFrom).map(({ ratio, source }) => ({ ratio, source })),
  })

  // Tab order places the divider between its panes: Shift+Tab from the input.
  focusTrace.length = 0
  await press('shift+Tab')
  await waitFor(
    () => focusTrace.at(-1) === 'divider',
    'divider focus',
    5_000,
    () => focusTrace.join()
  )
  assert.deepEqual(focusTrace, ['-search', 'divider'])
  await press('shift+Tab')
  await waitFor(() => focusTrace.at(-1) === 'action', 'leading action focus')
  await press('Tab')
  await waitFor(() => focusTrace.at(-1) === 'divider', 'divider focus by Tab')
  const focused = await poll(
    'divider-focused',
    (tree) => separator(tree)?.states.includes('focused') === true
  )
  assert(separator(focused)?.states.includes('focused'))
  record('tabOrder', focusTrace.slice())

  // The keyboard focus ring is the only pixel change: the 6 px divider is
  // filled by the shared inset ring (3 px dark, 1 px white inner edge).
  const ratioX = (ratio: number) => ratio * PANES + DIVIDER / 2
  const capture = join(output, 'divider-focused.png')
  await Bun.sleep(100)
  const shot = macWindow ? await macWindow.capture(capture) : undefined
  if (!shot) await run(['import', '-window', xid, capture])
  const pixel = async (x: number, y: number) => {
    if (shot) return shot.pixel([x, y])
    const text = await run([
      'convert',
      capture,
      '-crop',
      `1x1+${Math.round(x)}+${Math.round(y)}`,
      '-depth',
      '8',
      'txt:-',
    ])
    return Number.parseInt(/#([0-9A-F]{6})/i.exec(text)![1]!, 16)
  }
  const ringCenter = await pixel(ratioX(0.4), SPLIT_Y)
  record('focusRing', { center: ringCenter.toString(16) })
  assert.equal(ringCenter, 0x101828, 'focused divider shows the focus ring color')

  // Arrow keys on the split's axis move the ratio by 1%, Shift by 10%;
  // Home and End stop at the min_size limits; the cross axis does nothing.
  const expectResize = async (keys: string[], ratio: number, label: string) => {
    const count = resizes.length
    await press(...keys)
    await waitFor(() => resizes.length === count + 1, label)
    const event = resizes.at(-1)!
    assert.equal(event.source, 'keyboard')
    near(event.ratio, ratio, label, 1e-9)
    const tree = await poll(
      label,
      (tree) => Math.abs((separator(tree)?.value?.current ?? -1) - ratio * 100) < 1e-6
    )
    return tree
  }
  await expectResize(['Right'], 0.41, 'Right step')
  await expectResize(['shift+Right'], 0.51, 'Shift+Right step')
  await expectResize(['Left'], 0.5, 'Left step')
  const before = resizes.length
  await press('Up', 'Down')
  await Bun.sleep(300)
  assert.equal(resizes.length, before, 'cross-axis arrows do not resize a row split')
  await expectResize(['Home'], MIN_PANE / PANES, 'Home')
  const count = resizes.length
  await press('Left')
  await Bun.sleep(300)
  assert.equal(resizes.length, count, 'a step past the minimum reports nothing')
  const atEnd = await expectResize(['End'], 1 - MIN_PANE / PANES, 'End')
  assert(keyTargets.includes('right') && keyTargets.includes('end'), 'keys target the split')
  record('keyboardSteps', {
    events: resizes.map(({ ratio, source }) => ({ ratio, source })),
    atspiValue: separator(atEnd)?.value,
  })

  // A pointer drag reports once, after release, and does not take focus.
  await press('Tab')
  await waitFor(() => focusTrace.at(-1) === 'search', 'input focus before drag')
  focusTrace.length = 0
  const dragFrom = resizes.length
  const fromX = ratioX(1 - MIN_PANE / PANES)
  if (macWindow) {
    // One helper drag: press, moves, then 400 ms held before the release.
    let whileHeld: number | undefined
    await macWindow.drag(
      [fromX, 450, 400, 350, ratioX(0.5)].map((x) => [Math.round(x), SPLIT_Y] as const),
      400,
      () => void setTimeout(() => (whileHeld = resizes.length), 200)
    )
    assert.equal(whileHeld, dragFrom, 'no report while the button is held')
  } else {
    await run(['xdotool', 'mousemove', '--window', xid, String(Math.round(fromX)), String(SPLIT_Y)])
    await run(['xdotool', 'mousedown', '1'])
    for (const x of [450, 400, 350, ratioX(0.5)]) {
      await run(['xdotool', 'mousemove', '--window', xid, String(Math.round(x)), String(SPLIT_Y)])
      await Bun.sleep(30)
    }
    await Bun.sleep(200)
    assert.equal(resizes.length, dragFrom, 'no report while the button is held')
    await run(['xdotool', 'mouseup', '1'])
  }
  await waitFor(() => resizes.length === dragFrom + 1, 'pointer resize after release')
  const dragged = resizes.at(-1)!
  assert.equal(dragged.source, 'pointer')
  near(dragged.ratio, 0.5, 'dragged ratio', 2 / PANES)
  await Bun.sleep(200)
  assert.equal(resizes.length, dragFrom + 1, 'one report per drag')
  assert.equal(focusTrace.length, 0, 'a divider press does not move keyboard focus')
  await poll(
    'after drag',
    (tree) => Math.abs((separator(tree)?.value?.current ?? -1) - dragged.ratio * 100) < 1e-3
  )
  record('pointerDrag', { ratio: dragged.ratio })

  // A modal overlay is a dialog named by accessible_label with the modal
  // state; Tab stays inside it, so the divider is unreachable.
  await press('Tab')
  await waitFor(() => focusTrace.at(-1) === 'open', 'open button focus')
  await press('space')
  await waitFor(() => focusTrace.at(-1) === 'confirm', 'dialog takes focus')
  const opened = await poll(
    'dialog',
    (tree) =>
      find(tree, 'push-button', 'Confirm')?.states.includes('focused') === true &&
      find(tree, 'dialog', 'Confirm dialog') !== undefined
  )
  const dialogNode = find(opened, 'dialog', 'Confirm dialog')!
  assert(dialogNode.states.includes('modal'), 'the dialog reports the modal state')
  const dialogIndex = opened.indexOf(dialogNode)
  const inside = opened
    .slice(dialogIndex + 1)
    .filter((node) => node.depth > dialogNode.depth)
    .map((node) => node.role + ':' + node.name)
  record('dialogTree', { dialog: dialogNode, inside })
  assert.deepEqual(
    inside.slice(0, 3),
    ['label:Discard changes?', 'push-button:Confirm', 'push-button:Cancel'],
    'dialog content is nested under the dialog'
  )
  // Content beneath the modal layer leaves the accessibility tree, as
  // aria-modal content does; the dialog subtree is all that remains.
  const beneath = opened.filter((node) => node.depth <= dialogNode.depth && node !== dialogNode)
  assert.deepEqual(beneath, [], 'nothing beneath the modal dialog is exposed')
  assert.equal(opened.length, inside.length + 1, 'only the dialog and its content')
  focusTrace.length = 0
  for (let index = 0; index < 3; index += 1) await press('Tab')
  await waitFor(() => focusTrace.filter((name) => !name.startsWith('-')).length === 3, 'modal Tab')
  assert.deepEqual(
    focusTrace.filter((name) => !name.startsWith('-')),
    ['cancel', 'confirm', 'cancel']
  )
  await press('space')
  await waitFor(() => dialog === undefined && focusTrace.at(-1) === 'open', 'dialog closed')
  const closed = await poll('closed', (tree) => !tree.some((node) => node.role === 'dialog'))
  assert(find(closed, 'push-button', 'Open dialog')?.states.includes('focused'))
  assert.deepEqual(
    [...new Set(closed.map((node) => node.role))].sort(),
    roles,
    'the content beneath returns when the dialog closes'
  )
  record('modalDialog', { focusAfterClose: focusTrace.at(-1) })

  writeFileSync(
    join(output, mac ? 'ax-trees.json' : 'atspi-trees.json'),
    JSON.stringify(dumps, null, 2) + '\n'
  )
  await owned.close()
} finally {
  await app.shutdown()
  await app.closed
}
assert(Object.values(app.diagnostics).every((count) => count === 0))
const result = {
  status: 'passed',
  scenario: 'accessibility',
  platform: process.platform,
  client: mac
    ? 'AXUIElement (macos-accessibility-oracle.m); CoreGraphics input (native-platform-macos.m)'
    : 'AT-SPI (atspi-probe.py); XTEST input (xdotool)',
  ...(macWindow ? { osInput: macWindow.log } : {}),
  mode,
  elapsedMs: Math.round(performance.now() - started),
  outcomes,
}
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: 'passed', mode }))
