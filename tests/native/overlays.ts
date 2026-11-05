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
  const covered = await screenshot('modal-dialog', [opener[0] + 4, opener[1] + 4])
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
  const padding = await screenshot('anchored-popover', [item[0] - 2, item[1] + 8])
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

  await window.close()
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
