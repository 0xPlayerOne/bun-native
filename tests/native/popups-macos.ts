/**
 * Real GPUI popup window qualification on macOS. OS input is real Quartz
 * events posted at the HID tap, popup geometry, level and front-to-back order
 * come from the WindowServer, and titled window frames and moves go through
 * Accessibility, all from an independent oracle (macos-popup-oracle.m) that
 * never links GPUI. Anchor geometry comes from the host's nonce-tagged paint
 * evidence.
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
const host = process.env['BUN_NATIVE_HOST']
const oracle = process.env['BUN_NATIVE_POPUP_ORACLE']
// The host inherits these from the launching environment.
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !oracle ||
  !isAbsolute(oracle) ||
  !isAbsolute(evidenceLog) ||
  !/^[0-9a-f]{32}$/.test(nonce)
)
  throw new Error(
    'macOS popups need macOS, an evidence directory, a host, an oracle, an absolute native evidence log and a 32-hex-digit nonce'
  )

const TITLE = 'Popup qualification'
const OTHER = 'Popup other window'
const CONTENT = { width: 360, height: 200 }
const MENU = { width: 220, height: 160 }
const ESCAPE = 53
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
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
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

/** The host is this process's direct child; found once, while it runs. */
let hostPid: number | undefined
async function pid(): Promise<number> {
  if (hostPid !== undefined) return hostPid
  const children = (await run(['pgrep', '-P', String(process.pid)])).split('\n').filter(Boolean)
  for (const child of children) {
    const command = await run(['ps', '-o', 'comm=', '-p', child])
    if (command === host || command.endsWith('/bun-native-host')) return (hostPid = Number(child))
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

type Frame = { x: number; y: number; width: number; height: number }
type ServerWindow = Frame & { id: number; layer: number }
type Listing = { screen: [number, number]; frontmost: number; windows: ServerWindow[] }
const ui = async (...args: (string | number)[]) =>
  JSON.parse(await run([oracle!, ...args.map(String)])) as unknown
const listing = async () => (await ui('windows', await pid())) as Listing
const frame = async (title: string) => (await ui('frame', await pid(), title)) as Frame
const click = (x: number, y: number) => ui('click', Math.round(x), Math.round(y))

/** The host's on-screen windows above the normal level, front to back. */
async function popups(): Promise<ServerWindow[]> {
  return (await listing()).windows.filter((window) => window.layer > 0)
}
async function onePopup(): Promise<ServerWindow> {
  let found: ServerWindow[] = []
  await waitFor(async () => (found = await popups()).length === 1, 'one popup window')
  return found[0]!
}
const gone = () => waitFor(async () => (await popups()).length === 0, 'no popup window')

/** The parent's content top-left in global points: below its title bar. */
async function content(): Promise<{ x: number; y: number; frame: Frame }> {
  const parent = await frame(TITLE)
  const titleBar = parent.height - CONTENT.height
  assert.ok(titleBar >= 0, 'the window frame holds its content: ' + JSON.stringify(parent))
  return { x: parent.x, y: parent.y + titleBar, frame: parent }
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

async function qualify(app: NativeApplication) {
  assert.ok(app.capabilities.includes('popup_windows_v1'), 'macOS host advertises popup windows')
  const window = await app.openWindow({ title: TITLE, ...CONTENT })
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
  await ui('activate', await pid())
  const layout = await painted(window)
  const fieldBounds = bounds(
    layout,
    rendered((element) => element.kind === 'input')
  )
  const parent = await content()
  await click(
    parent.x + fieldBounds[0] + fieldBounds[2] / 2,
    parent.y + fieldBounds[1] + fieldBounds[3] / 2
  )
  await waitFor(() => focus.at(-1) === 'field', 'editor focus')

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
    const parent = await content()
    return { parent, x: parent.x + anchor[0], y: parent.y + anchor[1] + anchor[3] }
  }
  const placedAt = async (target: () => Promise<{ x: number; y: number }>, what: string) => {
    let popup: ServerWindow | undefined
    let at: { x: number; y: number } | undefined
    await waitFor(
      async () => {
        at = await target()
        const found = await popups()
        popup = found[0]
        return (
          found.length === 1 &&
          JSON.stringify([popup!.x, popup!.y, popup!.width, popup!.height]) ===
            JSON.stringify([at.x, at.y, MENU.width, MENU.height])
        )
      },
      what,
      2_000
    ).catch((error: Error) => {
      throw new Error(error.message + ': ' + JSON.stringify({ popup, at }))
    })
    return popup!
  }

  // 1. A popup opens below its anchor in screen points, extends beyond the
  // parent window, and stacks above it. The host stays the foreground
  // application and keyboard focus stays in the parent editor.
  await open('Copy')
  await onePopup()
  const anchor = bounds(await painted(window), nodeId('Actions'))
  const popup = await placedAt(() => expected(anchor), 'popup placed at the anchor bottom-left')
  const at = await expected(anchor)
  assert.ok(
    popup.y + popup.height > at.parent.frame.y + at.parent.frame.height,
    'popup extends below the parent window'
  )
  let server = await listing()
  const parentWindow = server.windows.find(
    (entry) =>
      entry.layer === 0 &&
      entry.x === at.parent.frame.x &&
      entry.y === at.parent.frame.y &&
      entry.width === at.parent.frame.width
  )
  assert.ok(parentWindow, 'the WindowServer lists the parent: ' + JSON.stringify(server))
  const order = server.windows.map((entry) => entry.id)
  assert.ok(
    order.indexOf(popup.id) < order.indexOf(parentWindow.id),
    'popup stacks above parent: ' + JSON.stringify(order)
  )
  assert.equal(server.frontmost, await pid(), 'the host stays the foreground application')
  record('placedBeyondParent', { anchor, parent: at.parent.frame, popup, stacked: true })

  // 2. A real click on the popup reaches its button; pointer coordinates are
  // in the parent window's space (here below its viewport). No focus moves.
  const before = { focus: focus.length, blurs: blurs.length }
  await click(popup.x + MENU.width / 2, popup.y + 4 + 22)
  await waitFor(() => clicks.includes('Copy'), 'popup button click')
  const pressed = presses.findLast((entry) => entry.node === 'Copy')!
  assert.equal(Math.round(pressed.x), MENU.width / 2 + anchor[0])
  assert.equal(Math.round(pressed.y), 4 + 22 + anchor[1] + anchor[3])
  assert.ok(pressed.y > CONTENT.height, 'the press lies outside the parent viewport')
  await Bun.sleep(200)
  assert.deepEqual({ focus: focus.length, blurs: blurs.length }, before, 'focus never moved')
  assert.deepEqual(dismissals, [], 'clicking the popup does not blur its parent')
  server = await listing()
  assert.equal(server.frontmost, await pid(), 'clicking the popup keeps the host in front')
  assert.equal(server.windows.filter((entry) => entry.layer > 0).length, 1, 'popup still open')
  record('popupPointer', { press: pressed })

  // 3. Escape in the parent dismisses the popup; the editor keeps focus.
  await ui('key', ESCAPE)
  await waitFor(() => dismissals.includes('escape'), 'Escape dismissal')
  await gone()
  assert.equal(focus.at(-1), 'field')
  assert.deepEqual(blurs.length, before.blurs, 'the editor kept focus')
  record('escapeDismissal', { dismissals })

  // 4. Moving the parent window moves an open popup with it.
  dismissals = []
  await open('Copy')
  await onePopup()
  await ui('move', await pid(), TITLE, 200, 120)
  const moved = await placedAt(() => expected(anchor), 'popup following its parent')
  record('followsParentMove', { popup: moved })

  // 5. Blur: making another window main asks the application to dismiss.
  const other = await app.openWindow({ title: OTHER, width: 200, height: 120 })
  await ui('raise', await pid(), OTHER)
  await waitFor(() => dismissals.includes('blur'), 'blur dismissal')
  await gone()
  record('blurDismissal', { dismissals })
  await other.close()
  await ui('raise', await pid(), TITLE)

  // 6. Clamping: near the bottom-right screen corner the popup is shifted
  // left onto the screen and flipped above its anchor.
  const [screenWidth, screenHeight] = (await listing()).screen
  await ui('move', await pid(), TITLE, screenWidth - 180, screenHeight - 230)
  dismissals = []
  await open('Copy')
  await onePopup()
  const clamped = await placedAt(async () => {
    const target = await expected(anchor)
    return { x: screenWidth - MENU.width, y: target.y - anchor[3] - MENU.height }
  }, 'popup shifted onto the screen and flipped above its anchor')
  record('clampedToDisplay', { screen: [screenWidth, screenHeight], popup: clamped })

  // 7. Closing the parent window closes its popup.
  await window.close()
  await gone()
  record('closedWithParent', true)
}

let failure: unknown
try {
  assert.equal((JSON.parse(await run([oracle, 'trusted'])) as { trusted: boolean }).trusted, true)
  const app = await createApplication({ executable: host })
  try {
    await qualify(app)
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert(Object.values(app.diagnostics).every((count) => count === 0))
  record('ownershipReleased', app.diagnostics)
} catch (error) {
  failure = error
  throw error
} finally {
  writeFileSync(
    join(output, 'popups-macos.json'),
    JSON.stringify(
      {
        platform: process.platform,
        input: 'Quartz events at the HID tap',
        geometry: 'CGWindowListCopyWindowInfo and Accessibility plus native paint evidence',
        outcomes,
        failed: failure !== undefined,
      },
      null,
      2
    )
  )
}
