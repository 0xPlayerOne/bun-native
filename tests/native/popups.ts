/**
 * Real GPUI popup window qualification in an isolated Xvfb + openbox session.
 * OS input comes from XTEST (xdotool). Popup geometry, override-redirect state,
 * ownership hints and stacking come from the X server itself (xwininfo/xprop);
 * anchor geometry comes from the host's nonce-tagged paint evidence.
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

const output = process.env['BUN_NATIVE_POPUP_EVIDENCE']
const mode = process.env['BUN_NATIVE_POPUP_MODE']
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
// The host inherits these from the launching environment.
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
if (!isAbsolute(evidenceLog) || !/^[0-9a-f]{32}$/.test(nonce))
  throw new Error('An absolute native evidence log and a 32-hex-digit nonce are required')

const TITLE = 'Popup qualification'
const OTHER = 'Popup other window'
const POPUP = 'Bun Native popup'
const MENU = { width: 220, height: 160 }
const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[], allowFailure = false): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0 && !allowFailure) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return code === 0 ? stdout.trim() : ''
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 5_000
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(10)
  }
}

type Rect = [number, number, number, number]
type Layout = {
  tree_revision: number
  layout: { status: string; nodes: { node_id: number; bounds: Rect }[] }
}
type Rendered = {
  tree_revision: number
  nodes: { node_id: number; element: { kind: string; text?: string } }[]
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

async function painted(window: NativeWindow) {
  let found: Layout | undefined
  await waitFor(() => {
    found = records<Layout>('layout').findLast(
      (entry) => entry.tree_revision >= window.revision && entry.layout.status === 'complete'
    )
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

type Geometry = { x: number; y: number; width: number; height: number; overrideRedirect: boolean }
async function geometry(id: string): Promise<Geometry> {
  const text = await run(['xwininfo', '-id', id])
  const field = (name: string) => {
    const match = new RegExp(name + ':\\s+(-?\\d+)').exec(text)
    if (!match) throw new Error('xwininfo omitted ' + name)
    return Number(match[1])
  }
  return {
    x: field('Absolute upper-left X'),
    y: field('Absolute upper-left Y'),
    width: field('Width'),
    height: field('Height'),
    overrideRedirect: /Override Redirect State:\s+yes/.test(text),
  }
}

/** Every mapped top-level window named exactly `name`. */
async function named(name: string): Promise<string[]> {
  const ids = await run(['xdotool', 'search', '--onlyvisible', '--name', '^' + name + '$'], true)
  return ids ? ids.split('\n') : []
}
async function one(name: string): Promise<string> {
  let ids: string[] = []
  await waitFor(async () => (ids = await named(name)).length === 1, 'one window named ' + name)
  return ids[0]!
}
const gone = (name: string) =>
  waitFor(async () => (await named(name)).length === 0, 'no window named ' + name)

/** Root children in X stacking order. xwininfo lists XQueryTree's children
 * in reverse, so the top-most window comes first. */
async function stacking(): Promise<number[]> {
  const text = await run(['xwininfo', '-root', '-children'])
  return [...text.matchAll(/^\s+(0x[0-9a-f]+)/gm)].map((match) => Number(match[1]))
}
async function frameOf(id: string): Promise<number> {
  const text = await run(['xwininfo', '-tree', '-id', id])
  let current = Number(id)
  let parent = Number(/Parent window id: (0x[0-9a-f]+)/.exec(text)![1])
  const root = Number(/Root window id: (0x[0-9a-f]+)/.exec(text)![1])
  while (parent !== root) {
    current = parent
    const next = await run(['xwininfo', '-tree', '-id', String(parent)])
    parent = Number(/Parent window id: (0x[0-9a-f]+)/.exec(next)![1])
  }
  return current
}
async function property(id: string, name: string): Promise<string> {
  return run(['xprop', '-id', id, name])
}

const activeWindow = async () => Number(await run(['xdotool', 'getactivewindow'], true))
const press = (...keys: string[]) => run(['xdotool', 'key', '--clearmodifiers', ...keys])
const type = (text: string) => run(['xdotool', 'type', '--delay', '20', text])
const clickAt = (x: number, y: number) =>
  run(['xdotool', 'mousemove', '--sync', String(x), String(y), 'click', '1'])

async function screenshot(id: string, name: string, [x, y]: [number, number]): Promise<number> {
  const file = join(output!, name + '.png')
  await run(['import', '-window', id, file])
  const text = await run(['convert', file, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-'])
  const hex = /#([0-9A-Fa-f]{6})/.exec(text)
  if (!hex) throw new Error('Unreadable screenshot pixel: ' + text)
  return Number.parseInt(hex[1]!, 16)
}

async function qualify(app: NativeApplication) {
  assert.ok(app.capabilities.includes('popup_windows_v1'), 'X11 host advertises popup windows')
  const window = await app.openWindow({ title: TITLE, width: 360, height: 200 })
  const names = new Map<NativeNode, string>([[window.root, 'root']])
  const name = (node: NativeNode) => names.get(node) ?? 'unnamed'
  const focus: string[] = []
  const blurs: string[] = []
  const clicks: string[] = []
  const presses: { node: string; x: number; y: number }[] = []
  window.on(window.root, 'focus', (event) => void focus.push(name(event.node)), { capture: true })
  window.on(window.root, 'blur', (event) => void blurs.push(name(event.node)), { capture: true })
  window.on(window.root, 'click', (event) => void clicks.push(name(event.node)), { capture: true })
  window.on(
    window.root,
    'pointer_down',
    (event) => void presses.push({ node: name(event.node), x: event.x, y: event.y }),
    { capture: true }
  )

  const base = await window.batch((batch) => {
    const field = batch.create({ kind: 'input', value: '', style: { width: 240, height: 36 } })
    const spacer = batch.create({ kind: 'box', style: { height: 110 } })
    const host = batch.create({ kind: 'box', style: { width: 120 } })
    const trigger = batch.create({ kind: 'button', text: 'Actions', style: { width: 120 } })
    for (const child of [field, spacer, host]) batch.append(window.root, child)
    batch.append(host, trigger)
    names.set(field, 'field')
    names.set(trigger, 'trigger')
    return { field, host }
  })
  const parentId = await one(TITLE)
  await run(['xdotool', 'windowactivate', '--sync', parentId])
  const layout = await painted(window)
  const fieldBounds = bounds(
    layout,
    rendered((element) => element.kind === 'input')
  )
  const parent = await geometry(parentId)
  await clickAt(
    parent.x + fieldBounds[0] + fieldBounds[2] / 2,
    parent.y + fieldBounds[1] + fieldBounds[3] / 2
  )
  await waitFor(() => focus.at(-1) === 'field', 'editor focus')
  await type('ab')
  await waitFor(() => window.input(base.field).value === 'ab', 'typed value')

  let dismissals: DismissEvent['reason'][] = []
  const open = async (label: string) => {
    const popup = await window.batch((batch) => {
      const popup = batch.create({
        kind: 'overlay',
        anchor: 'parent',
        surface: 'window',
        style: { ...MENU, padding: 4, gap: 4, background: 0xf4e3c1 },
      })
      const copy = batch.create({ kind: 'button', text: label, style: { width: 212 } })
      batch.append(base.host, popup)
      batch.append(popup, copy)
      batch.append(popup, batch.create({ kind: 'text', text: 'Paste' }))
      names.set(popup, 'popup')
      names.set(copy, label)
      return popup
    })
    onDismiss(window, popup, async ({ reason }) => {
      dismissals.push(reason)
      await window.batch((batch) => batch.remove(popup))
    })
    return popup
  }
  const expected = async (anchor: Rect) => {
    const parent = await geometry(parentId)
    return { parent, x: parent.x + anchor[0], y: parent.y + anchor[1] + anchor[3] }
  }

  // 1. A popup opens below its anchor in screen coordinates and extends
  // beyond the parent window. Keyboard focus stays in the parent editor.
  await open('Copy')
  const popupId = await one(POPUP)
  const anchor = bounds(await painted(window), nodeId('Actions'))
  const at = await expected(anchor)
  let popup = await geometry(popupId)
  await waitFor(
    async () => {
      popup = await geometry(popupId)
      return (
        JSON.stringify([popup.x, popup.y, popup.width, popup.height]) ===
        JSON.stringify([at.x, at.y, MENU.width, MENU.height])
      )
    },
    'popup placed at the anchor bottom-left',
    2_000
  ).catch((error: Error) => {
    throw new Error(error.message + ': ' + JSON.stringify({ popup, at, anchor }))
  })
  assert.ok(popup.y + popup.height > at.parent.y + at.parent.height, 'popup extends below')
  assert.ok(popup.overrideRedirect, 'popup is override-redirect')
  const transient = await property(popupId, 'WM_TRANSIENT_FOR')
  assert.match(transient, new RegExp('0x0*' + Number(parentId).toString(16) + '\\b'))
  assert.match(await property(popupId, '_NET_WM_WINDOW_TYPE'), /_NET_WM_WINDOW_TYPE_POPUP_MENU/)
  const frame = await frameOf(parentId)
  let order = await stacking()
  assert.ok(
    order.indexOf(Number(popupId)) < order.indexOf(frame),
    'popup stacks above parent: ' + JSON.stringify({ order, popupId, frame })
  )
  assert.equal(await activeWindow(), Number(parentId), 'parent stays the active window')
  const background = await screenshot(popupId, 'popup-open', [MENU.width - 6, MENU.height - 6])
  assert.equal(background, 0xf4e3c1, 'popup paints its own overlay background')
  const buttonPixel = await screenshot(popupId, 'popup-open', [8, 8])
  assert.equal(buttonPixel, 0x2255cc, 'popup paints native buttons through the shared renderer')
  // The whole screen: the popup crosses the parent window's bottom edge.
  await run(['import', '-window', 'root', join(output!, 'screen-open.png')])
  record('placedBeyondParent', { anchor, parent: at.parent, popup, transient, stacked: true })

  // 2. A real click on the popup reaches its button; pointer coordinates are
  // in the parent window's space (here below its viewport). No focus moves.
  const before = { focus: focus.length, blurs: blurs.length }
  await clickAt(popup.x + MENU.width / 2, popup.y + 4 + 22)
  await waitFor(() => clicks.includes('Copy'), 'popup button click')
  const pressed = presses.findLast((entry) => entry.node === 'Copy')!
  assert.equal(Math.round(pressed.x), MENU.width / 2 + anchor[0])
  assert.equal(Math.round(pressed.y), 4 + 22 + anchor[1] + anchor[3])
  assert.ok(pressed.y > at.parent.height, 'the press lies outside the parent viewport')
  await Bun.sleep(200)
  assert.deepEqual({ focus: focus.length, blurs: blurs.length }, before, 'focus never moved')
  assert.equal(await activeWindow(), Number(parentId), 'clicking the popup keeps parent active')
  order = await stacking()
  assert.ok(order.indexOf(Number(popupId)) < order.indexOf(frame), 'still above after click')
  record('popupPointer', { press: pressed, active: true })

  // 3. Escape in the parent dismisses the popup; the editor keeps focus and
  // its value, so typing continues there.
  await press('Escape')
  await waitFor(() => dismissals.includes('escape'), 'Escape dismissal')
  await gone(POPUP)
  await type('c')
  await waitFor(() => window.input(base.field).value === 'abc', 'typing after dismissal')
  assert.equal(focus.at(-1), 'field')
  record('escapeDismissal', { dismissals, value: window.input(base.field).value })

  // 4. Moving the parent window moves an open popup with it.
  dismissals = []
  await open('Copy')
  const movingId = await one(POPUP)
  await run(['xdotool', 'windowmove', '--sync', String(frame), '200', '120'])
  let moved: Geometry | undefined
  await waitFor(async () => {
    const target = await expected(anchor)
    moved = await geometry(movingId)
    return moved.x === target.x && moved.y === target.y
  }, 'popup following its parent')
  record('followsParentMove', { popup: moved })

  // 5. Blur: activating another window asks the application to dismiss.
  const other = await app.openWindow({ title: OTHER, width: 200, height: 120 })
  const otherId = await one(OTHER)
  await run(['xdotool', 'windowactivate', '--sync', otherId])
  await waitFor(() => dismissals.includes('blur'), 'blur dismissal')
  await gone(POPUP)
  record('blurDismissal', { dismissals })
  await other.close()
  await run(['xdotool', 'windowactivate', '--sync', parentId])

  // 6. Clamping: near the bottom-right screen corner the popup is shifted
  // left onto the screen and flipped above its anchor.
  const rootText = await run(['xwininfo', '-root'])
  const screenWidth = Number(/Width:\s+(\d+)/.exec(rootText)![1])
  const screenHeight = Number(/Height:\s+(\d+)/.exec(rootText)![1])
  await run([
    'xdotool',
    'windowmove',
    '--sync',
    String(frame),
    String(screenWidth - 180),
    String(screenHeight - 230),
  ])
  await painted(window)
  dismissals = []
  await open('Copy')
  const clampedId = await one(POPUP)
  let clamped: Geometry | undefined
  await waitFor(async () => {
    const target = await expected(anchor)
    clamped = await geometry(clampedId)
    return (
      clamped.x === screenWidth - MENU.width && clamped.y === target.y - anchor[3] - MENU.height
    )
  }, 'popup shifted onto the screen and flipped above its anchor')
  record('clampedToDisplay', { screen: [screenWidth, screenHeight], popup: clamped })

  // 7. Closing the parent window closes its popup.
  await window.close()
  await gone(POPUP)
  record('closedWithParent', true)
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
  join(output, 'popups.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      input: 'XTEST via xdotool',
      geometry: 'xwininfo/xprop plus nonce-tagged native paint evidence',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Popup qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
