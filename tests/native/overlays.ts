/**
 * Real GPUI overlay, modal focus and scroll-anchor qualification in an
 * isolated Xvfb + openbox session. OS input comes from XTEST (xdotool); native
 * geometry comes from the host's nonce-tagged paint evidence, so every click
 * targets the position GPUI actually painted.
 */
import {
  createApplication,
  onDismiss,
  type DismissEvent,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_OVERLAY_EVIDENCE']
const mode = process.env['BUN_NATIVE_OVERLAY_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !process.env['BUN_NATIVE_HOST'] ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error('An isolated X11 display, evidence directory, host and mode are required')
const executable = process.env['BUN_NATIVE_HOST']
// The host inherits these from the launching environment; Bun.spawn does not
// observe later process.env mutation.
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
if (!isAbsolute(evidenceLog) || !/^[0-9a-f]{32}$/.test(nonce))
  throw new Error('An absolute native evidence log and a 32-hex-digit nonce are required')

const TITLE = 'Overlay qualification'
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
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

async function waitFor(check: () => boolean, description: string, timeout = 5_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(5)
  }
}

/** No further change within a bounded quiet window after real input. */
async function quiet<T>(observe: () => T, expected: T, description: string) {
  await Bun.sleep(300)
  assert.deepEqual(observe(), expected, description)
}

type Rect = [number, number, number, number]
type Scroll = { node_id: number; offset: [number, number]; maximum: [number, number] }
type Layout = {
  tree_revision: number
  layout: {
    status: string
    focused_node_id: number | null
    nodes: { node_id: number; bounds: Rect }[]
    scrolls: Scroll[]
  }
}
type Rendered = {
  tree_revision: number
  nodes: { node_id: number; element: { kind: string; text?: string; style?: object } }[]
}

function records<T>(type: string): T[] {
  let text = ''
  try {
    text = readFileSync(evidenceLog, 'utf8')
  } catch {
    return []
  }
  const result: T[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const value = JSON.parse(line) as { nonce?: string; type?: string; window_id?: number }
    if (value.nonce === nonce && value.type === type) result.push(value as T)
  }
  return result
}

/** The latest painted layout at or after a committed tree revision. */
async function painted(window: NativeWindow, check: (layout: Layout) => boolean = () => true) {
  let found: Layout | undefined
  await waitFor(() => {
    found = records<Layout>('layout')
      .filter(
        (entry) => entry.tree_revision >= window.revision && entry.layout.status === 'complete'
      )
      .findLast(check)
    return found !== undefined
  }, 'native paint evidence at revision ' + window.revision)
  return found!
}

function rendered(match: (element: Rendered['nodes'][number]['element']) => boolean): number {
  const node = records<Rendered>('rendered')
    .at(-1)
    ?.nodes.find((entry) => match(entry.element))
  if (!node) throw new Error('No matching rendered node')
  return node.node_id
}
const nodeId = (label: string) => rendered((element) => element.text === label)

function bounds(layout: Layout, id: number): Rect {
  const node = layout.layout.nodes.find((entry) => entry.node_id === id)
  if (!node) throw new Error('No painted bounds for node ' + id)
  return node.bounds
}

let windowId = ''
async function activate() {
  const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + TITLE + '$'])).split('\n')
  assert.equal(ids.length, 1, 'expected exactly one owned window named ' + TITLE)
  windowId = ids[0]!
  await run(['xdotool', 'windowactivate', '--sync', windowId])
}
const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])
const type = (text: string) => run(['xdotool', 'type', '--delay', '20', text])
async function click([x, y, width, height]: Rect, button = '1') {
  const at = [String(Math.round(x + width / 2)), String(Math.round(y + height / 2))]
  await run(['xdotool', 'mousemove', '--window', windowId, ...at, 'click', button])
}
/** Capture the owned window and read one displayed pixel as 0xRRGGBB. */
async function screenshot(name: string, [x, y]: [number, number]): Promise<number> {
  const file = join(output!, name + '.png')
  await run(['import', '-window', windowId, file])
  const text = await run(['convert', file, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-'])
  const hex = /#([0-9A-Fa-f]{6})/.exec(text)
  if (!hex) throw new Error('Unreadable screenshot pixel: ' + text)
  return Number.parseInt(hex[1]!, 16)
}

/**
 * Paint evidence can precede the presented frame under a loaded software
 * renderer, so read the pixel until it shows the expected color or a bounded
 * deadline passes. The caller still asserts the final displayed value.
 */
async function displayed(name: string, [x, y]: [number, number], expected: number) {
  const until = performance.now() + 2_000
  let value = await screenshot(name, [Math.floor(x), Math.floor(y)])
  while (value !== expected && performance.now() < until) {
    await Bun.sleep(50)
    value = await screenshot(name, [Math.floor(x), Math.floor(y)])
  }
  return value
}

async function clickLabel(window: NativeWindow, label: string) {
  await click(bounds(await painted(window), nodeId(label)))
}

async function qualify(app: NativeApplication) {
  assert.ok(app.capabilities.includes('overlays_v1'))
  assert.ok(app.capabilities.includes('scroll_anchor_v1'))
  const window = await app.openWindow({ title: TITLE, width: 480, height: 420 })
  const names = new Map<NativeNode, string>()
  const focus: string[] = []
  const blurs: string[] = []
  const clicks: string[] = []
  const pressed: string[] = []
  const dismissals: string[] = []
  const name = (node: NativeNode) => names.get(node) ?? 'unnamed'
  // Root capture listeners observe every routed focus/click, including those
  // emitted by the same native commit that created their target.
  const track = <K extends 'button' | 'input'>(node: NativeNode<K>, label: string) => {
    names.set(node, label)
    return node
  }
  names.set(window.root, 'root')
  window.on(window.root, 'focus', (event) => void focus.push(name(event.node)), { capture: true })
  window.on(window.root, 'blur', (event) => void blurs.push(name(event.node)), { capture: true })
  window.on(window.root, 'click', (event) => void clicks.push(name(event.node)), { capture: true })
  window.on(
    window.root,
    'pointer_down',
    (event) => {
      pressed.push(name(event.node))
    },
    { capture: true }
  )

  const base = await window.batch((batch) => {
    const opener = track(
      batch.create({ kind: 'button', text: 'Open dialog', style: { width: 200 } }),
      'opener'
    )
    const field = track(
      batch.create({ kind: 'input', value: '', style: { width: 240, height: 36 } }),
      'field'
    )
    const log = batch.create({
      kind: 'box',
      style: {
        width: 300,
        height: 64,
        overflow: 'scroll_y',
        scroll_anchor: 'end',
        background: 0xeef2f6,
      },
    })
    const menuHost = batch.create({ kind: 'box', style: { width: 160 } })
    const menu = track(
      batch.create({ kind: 'button', text: 'Menu', style: { width: 160 } }),
      'menu'
    )
    const under = track(
      batch.create({ kind: 'button', text: 'Under', style: { width: 160 } }),
      'under'
    )
    for (const child of [opener, field, log, menuHost, under]) batch.append(window.root, child)
    batch.append(menuHost, menu)
    return { opener, field, log, menuHost }
  })
  await painted(window)
  await activate()

  // Focus the native editor, type, and select "lo" with the keyboard.
  await clickLabel(window, 'Open dialog')
  await waitFor(() => clicks.includes('opener'), 'opener click')
  const fieldId = rendered((element) => element.kind === 'input')
  await click(bounds(await painted(window), fieldId))
  await waitFor(() => focus.at(-1) === 'field', 'input focus')
  await type('hello')
  await press('shift+Left', 'shift+Left')
  await waitFor(() => window.input(base.field).value === 'hello', 'typed value')
  record('editorSelection', { value: window.input(base.field).value, focus: focus.at(-1) })

  // A modal dialog takes focus to its first control and traps Tab.
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
    const confirm = track(batch.create({ kind: 'button', text: 'Confirm' }), 'confirm')
    const cancel = track(batch.create({ kind: 'button', text: 'Cancel' }), 'cancel')
    batch.append(window.root, layer)
    batch.append(layer, panel)
    batch.append(panel, confirm)
    batch.append(panel, cancel)
    return { layer, panel, confirm }
  })
  names.set(dialog.layer, 'dialog')
  const dialogDismissals: DismissEvent['reason'][] = []
  onDismiss(window, dialog.layer, async ({ reason }) => {
    dialogDismissals.push(reason)
    dismissals.push('dialog:' + reason)
    if (reason === 'escape') await window.batch((b) => b.remove(dialog.layer))
  })
  await waitFor(() => focus.at(-1) === 'confirm', 'modal initial focus')
  // The modal backdrop paints over the opener button at the window origin.
  const opener = bounds(await painted(window), nodeId('Open dialog'))
  const covered = await displayed('modal-dialog', [opener[0] + 4, opener[1] + 4], 0x334455)
  assert.equal(covered, 0x334455, 'the backdrop is displayed above the covered button')
  const opened = focus.length - 1
  const callbacksWithDialog = app.diagnostics.callbacks
  await press('Tab')
  await waitFor(() => focus.at(-1) === 'cancel', 'Tab inside the modal')
  await press('Tab')
  await waitFor(() => focus.at(-1) === 'confirm', 'Tab wraps inside the modal')
  await press('shift+Tab')
  await waitFor(() => focus.at(-1) === 'cancel', 'Shift-Tab wraps inside the modal')
  const trapped = focus.slice(opened)
  assert.ok(trapped.every((label) => label === 'confirm' || label === 'cancel'))
  record('modalFocusTrap', { sequence: trapped, displayedBackdrop: covered.toString(16) })

  // The backdrop blocks pointer input to the controls beneath it.
  const clicksBefore = clicks.length
  await clickLabel(window, 'Open dialog')
  await waitFor(() => dialogDismissals.includes('backdrop'), 'backdrop press')
  await quiet(() => clicks.length, clicksBefore, 'covered control stayed inert')
  assert.equal(pressed.at(-1), 'dialog', 'the press targeted the overlay layer itself')
  assert.equal(focus.at(-1), 'cancel', 'a backdrop press does not move focus out')
  record('backdropBlocksPointer', { clicks: clicks.length - clicksBefore, focus: focus.at(-1) })

  // A nested modal traps focus in the inner layer; Escape closes one layer.
  const nested = await window.batch((batch) => {
    const layer = batch.create({
      kind: 'overlay',
      modal: true,
      style: { align_items: 'end', justify_content: 'end', padding: 24 },
    })
    const ok = track(batch.create({ kind: 'button', text: 'Inner OK' }), 'inner')
    batch.append(dialog.panel, layer)
    batch.append(layer, ok)
    return layer
  })
  onDismiss(window, nested, async ({ reason }) => {
    dismissals.push('nested:' + reason)
    if (reason === 'escape') await window.batch((b) => b.remove(nested))
  })
  await waitFor(() => focus.at(-1) === 'inner', 'nested modal focus')
  await press('Tab')
  await press('shift+Tab')
  await quiet(() => focus.at(-1), 'inner', 'Tab stays in the nested modal')
  await press('Escape')
  await waitFor(() => focus.at(-1) === 'cancel', 'focus returns to the outer dialog')
  assert.deepEqual(dismissals.slice(-1), ['nested:escape'])
  await waitFor(() => app.diagnostics.callbacks === callbacksWithDialog, 'nested disposal')
  record('nestedModalEscape', { dismissals: [...dismissals], focus: focus.at(-1) })

  // Escape closes the dialog; focus and selection return to the editor.
  await press('Escape')
  await waitFor(() => focus.at(-1) === 'field', 'focus restored to the editor')
  await type('X')
  await waitFor(() => window.input(base.field).value === 'helX', 'selection replaced')
  await waitFor(() => app.diagnostics.callbacks < callbacksWithDialog, 'dialog disposal')
  record('focusAndSelectionRestored', {
    value: window.input(base.field).value,
    dismissals: [...dismissals],
  })

  // A parent-anchored popover paints above later siblings without taking focus.
  const popover = await window.batch((batch) => {
    const layer = batch.create({
      kind: 'overlay',
      anchor: 'parent',
      style: { padding: 4, background: 0xdde6f0 },
    })
    const item = track(
      batch.create({ kind: 'button', text: 'Item A', style: { width: 150 } }),
      'item'
    )
    batch.append(base.menuHost, layer)
    batch.append(layer, item)
    return layer
  })
  const geometry = await painted(window, (entry) =>
    entry.layout.nodes.some((node) => node.node_id === nodeId('Item A'))
  )
  const item = bounds(geometry, nodeId('Item A'))
  const under = bounds(geometry, nodeId('Under'))
  const menuBox = bounds(geometry, nodeId('Menu'))
  assert.ok(Math.abs(item[1] - (menuBox[1] + menuBox[3] + 4)) <= 1, 'opens below its parent')
  assert.ok(item[1] < under[1] + under[3] && item[1] + item[3] > under[1], 'overlaps Under')
  // The popover's own padding is displayed over the button beneath it.
  const padding = await displayed('anchored-popover', [item[0] - 2, item[1] + 8], 0xdde6f0)
  assert.equal(padding, 0xdde6f0, 'the popover is displayed above the later sibling')
  await quiet(() => focus.at(-1), 'field', 'a non-modal popover does not take focus')
  const overlapClicks = clicks.length
  await click(item)
  await waitFor(() => clicks.length > overlapClicks, 'popover activation')
  await quiet(() => clicks.slice(overlapClicks), ['item'], 'only the topmost control activated')
  await window.batch((batch) => batch.remove(popover))
  record('anchoredPopoverZOrder', {
    item,
    under,
    clicks: clicks.slice(overlapClicks),
    displayedPadding: padding.toString(16),
  })

  // A dialog with no controls receives Escape directly and restores focus.
  const notice = await window.batch((batch) => {
    const layer = batch.create({ kind: 'overlay', modal: true })
    batch.append(window.root, layer)
    batch.append(layer, batch.create({ kind: 'text', text: 'Saved' }))
    return layer
  })
  onDismiss(window, notice, ({ reason }) =>
    window.batch((b) => {
      dismissals.push('notice:' + reason)
      b.remove(notice)
    })
  )
  await waitFor(() => blurs.at(-1) === 'field', 'a control-less modal clears outside focus')
  const focusEvents = focus.length
  await press('Escape')
  await waitFor(() => dismissals.at(-1) === 'notice:escape', 'Escape on a control-less modal')
  await waitFor(
    () => focus.length > focusEvents && focus.at(-1) === 'field',
    'focus restored after the notice'
  )
  record('controlLessModalEscape', { focus: focus.at(-1) })

  // Streaming rows keep an end-anchored viewport at its end; a user scroll
  // away releases it until the user returns to the end.
  const logId = records<Rendered>('rendered')
    .at(-1)!
    .nodes.find(
      (node) => (node.element.style as { scroll_anchor?: string } | undefined)?.scroll_anchor
    )!.node_id
  const scroll = (layout: Layout) => layout.layout.scrolls.find((entry) => entry.node_id === logId)!
  const pinned = (entry: Scroll) => Math.abs(entry.offset[1] + entry.maximum[1]) <= 1
  let row = 0
  const append = (count: number) =>
    window.batch((batch) => {
      for (let index = 0; index < count; index++)
        batch.append(base.log, batch.create({ kind: 'text', text: 'row ' + row++ }))
    })
  const followed: number[] = []
  for (let chunk = 0; chunk < 8; chunk++) {
    await append(4)
    const entry = scroll(await painted(window))
    assert.ok(pinned(entry), 'streamed rows keep the end visible: ' + JSON.stringify(entry))
    followed.push(entry.maximum[1])
  }
  assert.ok(followed.at(-1)! > followed[0]! && followed[0]! > 0, 'content overflowed and grew')
  const logBounds = bounds(await painted(window), logId)
  await click(logBounds, '4')
  await click(logBounds, '4')
  await painted(window, (entry) => !pinned(scroll(entry)))
  await Bun.sleep(300)
  const released = scroll(await painted(window))
  assert.ok(!pinned(released) && released.offset[1] < 0, 'wheel input released the end')
  await append(4)
  const held = scroll(
    await painted(window, (entry) => scroll(entry).maximum[1] > released.maximum[1])
  )
  assert.equal(held.offset[1], released.offset[1], 'a released viewport keeps its offset')
  for (let wheel = 0; wheel < 12; wheel++) await click(logBounds, '5')
  await painted(window, (entry) => pinned(scroll(entry)))
  await append(4)
  const resumed = scroll(
    await painted(window, (entry) => scroll(entry).maximum[1] > held.maximum[1])
  )
  assert.ok(pinned(resumed), 'returning to the end pins it again')
  record('scrollAnchorUnderStreaming', { followed, released, held, resumed })

  await keyboardMenu(window, base.menuHost, { track, focus, clicks, dismissals })
  await programmaticFocusAndScroll(window, { track, focus })

  await window.close()
}

type Observed = {
  track: <K extends 'button' | 'input'>(node: NativeNode<K>, label: string) => NativeNode<K>
  focus: string[]
  clicks?: string[]
  dismissals?: string[]
}

/**
 * A keyboard-driven menu: a non-modal parent-anchored popover that takes
 * focus on open, roves focus with arrows/Home/End, types ahead, draws a
 * visible focus ring, activates with Enter and returns focus on Escape.
 */
async function keyboardMenu(
  window: NativeWindow,
  host: NativeNode<'box'>,
  { track, focus, clicks, dismissals }: Observed
) {
  assert.ok(app.capabilities.includes('overlay_keyboard_v1'))
  const before = focus.at(-1)
  const labels = ['Copy', 'Cut', 'Paste', 'Rename', 'Delete', 'Duplicate']
  const menu = await window.batch((batch) => {
    const layer = batch.create({
      kind: 'overlay',
      anchor: 'parent',
      autofocus: true,
      navigation: 'menu',
      style: { padding: 4, gap: 2, background: 0xdde6f0 },
    })
    for (const label of labels)
      batch.append(
        layer,
        track(
          batch.create({
            kind: 'button',
            text: label,
            disabled: label === 'Rename',
            style: { width: 150 },
          }),
          label.toLowerCase()
        )
      )
    batch.append(host, layer)
    return layer
  })
  onDismiss(window, menu, async ({ reason }) => {
    dismissals!.push('menu:' + reason)
    if (reason === 'escape') await window.batch((b) => b.remove(menu))
  })
  await waitFor(() => focus.at(-1) === 'copy', 'a non-modal autofocus menu takes focus')
  const moves: [string, string][] = []
  const step = async (key: string, expected: string) => {
    await press(key)
    await waitFor(() => focus.at(-1) === expected, key + ' moves focus to ' + expected)
    moves.push([key, expected])
  }
  await step('Down', 'cut')
  await step('Down', 'paste')
  // The disabled item is skipped.
  await step('Down', 'delete')
  await step('Up', 'paste')
  await step('End', 'duplicate')
  await step('Home', 'copy')
  await step('Up', 'duplicate')
  await step('Down', 'copy')
  record('menuArrowNavigation', { opened: 'copy', moves })

  // Type-ahead: a repeated letter cycles; a pause starts a new search.
  const typed: [string, string][] = []
  const typeAhead = async (text: string, expected: string) => {
    await type(text)
    await waitFor(() => focus.at(-1) === expected, `typing ${text} focuses ${expected}`)
    typed.push([text, expected])
  }
  await typeAhead('d', 'delete')
  await typeAhead('d', 'duplicate')
  await Bun.sleep(1_200)
  await typeAhead('pa', 'paste')
  await Bun.sleep(1_200)
  await typeAhead('c', 'copy')
  await typeAhead('u', 'cut')
  record('menuTypeAhead', { typed })

  // The keyboard-focused item draws an inset ring: a white edge over a dark
  // band, while an unfocused item shows its plain background there.
  const geometry = await painted(window, (entry) => entry.layout.focused_node_id === nodeId('Cut'))
  const cut = bounds(geometry, nodeId('Cut'))
  const copy = bounds(geometry, nodeId('Copy'))
  const middle = (rect: Rect) => rect[1] + rect[3] / 2
  const edge = await displayed('menu-focus-ring', [cut[0], middle(cut)], 0xffffff)
  const band = await displayed('menu-focus-ring', [cut[0] + 2, middle(cut)], 0x101828)
  const plain = await displayed('menu-focus-ring', [copy[0] + 2, middle(copy)], 0x2255cc)
  assert.equal(edge, 0xffffff, 'the ring has a white outer edge')
  assert.equal(band, 0x101828, 'the ring has a dark inner band')
  assert.equal(plain, 0x2255cc, 'an unfocused button has no ring')
  record('visibleFocusRing', {
    focused: 'cut',
    edge: edge.toString(16),
    band: band.toString(16),
    unfocused: plain.toString(16),
  })

  // Enter activates the roving item; Escape reaches the focused popover and
  // focus returns to the control focused before it opened.
  const activated = clicks!.length
  await press('Return')
  await waitFor(() => clicks!.length > activated, 'Enter activates the menu item')
  assert.deepEqual(clicks!.slice(activated), ['cut'])
  await press('Escape')
  await waitFor(() => dismissals!.at(-1) === 'menu:escape', 'Escape dismisses the popover')
  await waitFor(() => focus.at(-1) === before, 'focus returns after the menu closes')
  record('menuActivationAndReturn', { activated: 'cut', returnedTo: before })
}

/**
 * Programmatic focus scrolls the target into view; scrollTo and
 * scrollIntoView position a viewport; Tab focus reveals the next control.
 */
async function programmaticFocusAndScroll(window: NativeWindow, { track, focus }: Observed) {
  assert.ok(app.capabilities.includes('focus_v1'))
  assert.ok(app.capabilities.includes('scroll_control_v1'))
  const { list, options } = await window.batch((batch) => {
    const list = batch.create({
      kind: 'box',
      style: { width: 220, height: 100, overflow: 'scroll_y', background: 0xeef2f6 },
    })
    const options = Array.from({ length: 12 }, (_, index) =>
      track(
        batch.create({ kind: 'button', text: 'Option ' + index, style: { width: 200 } }),
        'option' + index
      )
    )
    for (const option of options) batch.append(list, option)
    batch.append(window.root, list)
    return { list, options }
  })
  let listId = 0
  await waitFor(() => {
    const node = records<Rendered>('rendered')
      .at(-1)
      ?.nodes.find(
        (entry) => (entry.element.style as { height?: number } | undefined)?.height === 100
      )
    listId = node?.node_id ?? 0
    return listId !== 0
  }, 'the rendered option list')
  const viewportOf = (layout: Layout) => bounds(layout, listId)
  const scrollOf = (layout: Layout) =>
    layout.layout.scrolls.find((entry) => entry.node_id === listId)!
  const visible = (layout: Layout, label: string) => {
    const [, top, , height] = viewportOf(layout)
    const [, y, , h] = bounds(layout, nodeId(label))
    return y >= top - 0.5 && y + h <= top + height + 0.5
  }
  const initial = scrollOf(await painted(window))
  assert.equal(initial.offset[1], 0)

  await window.batch((batch) => batch.focus(options[9]!))
  await waitFor(() => focus.at(-1) === 'option9', 'programmatic focus')
  const focused = await painted(
    window,
    (entry) => entry.layout.focused_node_id === nodeId('Option 9') && visible(entry, 'Option 9')
  )
  const revealed = scrollOf(focused)
  assert.ok(revealed.offset[1] < 0, 'focusing a hidden option scrolled the list')
  record('programmaticFocusRevealsTarget', { focused: 'option9', offset: revealed.offset })

  await window.batch((batch) => batch.scrollTo(list, { y: 0 }))
  const top = scrollOf(await painted(window, (entry) => scrollOf(entry).offset[1] === 0))
  assert.ok(visible(await painted(window), 'Option 0'))
  await window.batch((batch) => batch.scrollTo(list, { y: 50 }))
  const exact = scrollOf(await painted(window, (entry) => scrollOf(entry).offset[1] === -50))
  // Requests beyond the content are clamped to the laid-out maximum.
  await window.batch((batch) => batch.scrollTo(list, { y: 100_000 }))
  const clamped = scrollOf(
    await painted(window, (entry) => {
      const scroll = scrollOf(entry)
      return Math.abs(scroll.offset[1] + scroll.maximum[1]) <= 0.5
    })
  )
  await window.batch((batch) => batch.scrollTo(list, { y: 0 }))
  await painted(window, (entry) => scrollOf(entry).offset[1] === 0)
  await window.batch((batch) => batch.scrollIntoView(options[11]!))
  const last = await painted(window, (entry) => visible(entry, 'Option 11'))
  assert.ok(Math.abs(scrollOf(last).offset[1] + scrollOf(last).maximum[1]) <= 0.5)
  record('programmaticScroll', {
    top: top.offset,
    exact: exact.offset,
    clamped: { offset: clamped.offset, maximum: clamped.maximum },
    intoView: scrollOf(last).offset,
  })

  // Keyboard Tab focus scrolls the newly focused control into view.
  await window.batch((batch) => {
    batch.scrollTo(list, { y: 0 })
    batch.focus(options[1]!)
  })
  await waitFor(() => focus.at(-1) === 'option1', 'focus on the second option')
  await press('Tab')
  await press('Tab')
  await waitFor(() => focus.at(-1) === 'option3', 'Tab moves through the list')
  const tabbed = await painted(
    window,
    (entry) => entry.layout.focused_node_id === nodeId('Option 3') && visible(entry, 'Option 3')
  )
  assert.ok(scrollOf(tabbed).offset[1] < 0, 'Tab revealed the focused option')
  record('tabFocusRevealsTarget', { focused: 'option3', offset: scrollOf(tabbed).offset })
}

const app = await createApplication({ executable })
try {
  await qualify(app)
} finally {
  await app.shutdown()
  await app.closed
}
assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
record('ownershipReleased', app.diagnostics)

writeFileSync(
  join(output, 'overlays.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      input: 'XTEST via xdotool',
      geometry: 'nonce-tagged native paint evidence',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Overlay qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
