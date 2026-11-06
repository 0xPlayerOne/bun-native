/**
 * Real GPUI qualification on a Wayland compositor: a headless sway (wlroots)
 * session owned by scripts/quality/native-wayland-session.sh, with no X server
 * reachable. Window mapping, geometry, focus and close come from the
 * compositor's own IPC (swaymsg); pointer input is a persistent wlroots virtual
 * pointer, keyboard input the virtual-keyboard protocol (wtype), and pixels are
 * read back through the compositor (grim, wlr-screencopy). Painted content and
 * node geometry come from the host's nonce-tagged paint evidence.
 */
import {
  createApplication,
  NativeServiceError,
  UnsupportedFeatureError,
  type NativeApplication,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_WAYLAND_EVIDENCE']
const mode = process.env['BUN_NATIVE_WAYLAND_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !process.env['BUN_NATIVE_HOST'] ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['WAYLAND_DISPLAY'] ||
  !process.env['SWAYSOCK'] ||
  process.env['DISPLAY']
)
  throw new Error(
    'An owned Wayland compositor without X11, evidence directory, host and mode are required'
  )
const executable = process.env['BUN_NATIVE_HOST']
const inputPeer = process.env['BUN_NATIVE_WAYLAND_INPUT_PEER'] ?? ''
if (!isAbsolute(inputPeer)) throw new Error('Set BUN_NATIVE_WAYLAND_INPUT_PEER to the built peer')
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG'] ?? ''
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE'] ?? ''
if (!isAbsolute(evidenceLog) || !/^[0-9a-f]{32}$/.test(nonce))
  throw new Error('An absolute native evidence log and a 32-hex-digit nonce are required')

const TITLE = 'Bun Native Wayland'
const DIALOG = 'Bun Native Wayland dialog'
const SIZE = { width: 480, height: 320 }
const SWATCH = 0x3a7d44
/** The renderer's native button background (see tests/native/popups.ts). */
const BUTTON = 0x2255cc
/** Bound for open-to-mapped-and-painted: generous for a cold lavapipe start. */
const OPEN_BOUND_MS = 10_000
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

// ---- compositor oracle (sway IPC) ----

type SwayNode = {
  name: string | null
  type: string
  shell?: string
  app_id?: string | null
  rect: { x: number; y: number; width: number; height: number }
  nodes: SwayNode[]
  floating_nodes: SwayNode[]
}
const swaymsg = (...args: string[]) => run(['swaymsg', ...args])
async function views(): Promise<SwayNode[]> {
  const tree = JSON.parse(await swaymsg('-t', 'get_tree')) as SwayNode
  const found: SwayNode[] = []
  const visit = (node: SwayNode) => {
    if (node.type === 'con' || node.type === 'floating_con')
      if (node.shell !== undefined) found.push(node)
    for (const child of [...node.nodes, ...node.floating_nodes]) visit(child)
  }
  visit(tree)
  return found
}
async function view(title: string): Promise<SwayNode | undefined> {
  const matches = (await views()).filter((node) => node.name === title)
  assert.ok(matches.length <= 1, 'at most one mapped view named ' + title)
  return matches[0]
}
async function mapped(title: string, timeout?: number): Promise<SwayNode> {
  let found: SwayNode | undefined
  await waitFor(
    async () => (found = await view(title)) !== undefined,
    'a view named ' + title,
    timeout
  )
  return found!
}
const unmapped = (title: string) =>
  waitFor(async () => (await view(title)) === undefined, 'no view named ' + title)
/** Criteria are matched by sway; quote the title exactly. */
const command = (title: string, action: string) =>
  swaymsg(`[title="^${title.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&')}$"]`, action)

// Pointer: one persistent zwlr_virtual_pointer_v1 (examples/wayland-input-peer.rs)
// moves the compositor's cursor and presses its button; the compositor then
// delivers wl_pointer enter/motion/button to the client under the cursor.
class PointerPeer {
  private readonly process = Bun.spawn([inputPeer], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  private readonly lines = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader()
  private buffer = ''

  async line(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        return line
      }
      const { done, value } = await this.lines.read()
      if (done) throw new Error('The Wayland input peer exited')
      this.buffer += value
    }
  }
  async send(command: string) {
    this.process.stdin.write(command + '\n')
    await this.process.stdin.flush()
    const reply = await this.line()
    if (reply !== 'ok') throw new Error(`Input peer failed on ${command}: ${reply}`)
  }
  async close() {
    this.process.stdin.end()
    assert.equal(await this.process.exited, 0)
  }
}
let pointer: PointerPeer
let layout: { width: number; height: number }
async function clickAt(x: number, y: number) {
  await pointer.send(`move ${Math.round(x)} ${Math.round(y)} ${layout.width} ${layout.height}`)
  await pointer.send('press')
  await pointer.send('release')
}
// Keyboard: a zwp_virtual_keyboard_v1 with its own keymap, sent to the focused view.
// wtype decodes argv with mbstowcs, so it needs a UTF-8 locale.
const type = (text: string) => run(['env', 'LC_ALL=C.UTF-8', 'wtype', '-d', '20', text])
const key = (name: string) => run(['wtype', '-k', name])

async function pixel(name: string, x: number, y: number): Promise<number> {
  const file = join(output!, name + '.png')
  // Logical output coordinates; the output scale is 1, so one pixel each.
  await run(['grim', '-g', `${Math.round(x)},${Math.round(y)} 1x1`, file])
  const text = await run(['convert', file, '-depth', '8', 'txt:-'])
  const hex = /#([0-9A-Fa-f]{6})/.exec(text)
  if (!hex) throw new Error('Unreadable screenshot pixel: ' + text)
  return Number.parseInt(hex[1]!, 16)
}

// ---- native paint evidence ----

type Rect = [number, number, number, number]
type Layout = {
  window_id: number
  tree_revision: number
  layout: { status: string; nodes: { node_id: number; bounds: Rect }[] }
}
type Element = { kind: string; text?: string; value?: string; style?: { background?: number } }
type Rendered = {
  window_id: number
  tree_revision: number
  nodes?: { node_id: number; element: Element }[]
}
type StartupLog = { target?: string; message?: string }
type Renderer = { window_id: number; gpu: { is_software_emulated: boolean; device_name: string } }

/** Nonce-tagged records whose `type` (or, for startup diagnostics, `stage`) matches. */
function records<T>(type: string, field: 'type' | 'stage' = 'type'): T[] {
  let text = ''
  try {
    text = readFileSync(evidenceLog, 'utf8')
  } catch {
    return []
  }
  const result: T[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const value = JSON.parse(line) as { nonce?: string; type?: string; stage?: string }
    if (value.nonce === nonce && value[field] === type) result.push(value as T)
  }
  return result
}
async function painted(window: NativeWindow, check: (nodes: Element[]) => boolean, what: string) {
  let found: { layout: Layout; rendered: Rendered } | undefined
  await waitFor(() => {
    const rendered = records<Rendered>('rendered').findLast(
      (entry) => entry.tree_revision >= window.revision && entry.nodes !== undefined
    )
    // A layout record is written only when geometry changes, so the latest
    // complete one describes every later painted revision.
    const layout = records<Layout>('layout').findLast((entry) => entry.layout.status === 'complete')
    if (!rendered || !layout || !check(rendered.nodes!.map((node) => node.element))) return false
    found = { layout, rendered }
    return true
  }, 'native paint evidence of ' + what)
  return found!
}
function bounds(found: { layout: Layout; rendered: Rendered }, match: (e: Element) => boolean) {
  const node = found.rendered.nodes!.find((entry) => match(entry.element))
  if (!node) throw new Error('No matching painted node')
  const laid = found.layout.layout.nodes.find((entry) => entry.node_id === node.node_id)
  if (!laid) throw new Error('No painted bounds for node ' + node.node_id)
  return laid.bounds
}
const center = (origin: SwayNode['rect'], [x, y, width, height]: Rect) =>
  [origin.x + x + width / 2, origin.y + y + height / 2] as const

const unavailable = { availability: 'unavailable', reason: 'unsupported_platform' }
const isService = (service: string, code: string) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === service && error.code === code

/** X11-only services report unavailable before any request; D-Bus ones work. */
async function capabilities(app: NativeApplication, window: NativeWindow) {
  const services = app.serviceCapabilities
  assert.deepEqual(services.clipboardText, unavailable)
  assert.deepEqual(services.globalShortcuts, unavailable)
  assert.deepEqual(services.dragDrop, unavailable)
  assert.deepEqual(services.notifications, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    backend: 'freedesktop',
  })
  assert.deepEqual(services.fileDialogs, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    backend: 'xdg_desktop_portal',
  })
  assert.deepEqual(services.windowDisplay, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    details: 'unavailable',
    changes: 'unavailable',
  })
  for (const capability of [
    'clipboard_text_v1',
    'global_shortcuts_v1',
    'drag_drop_files_v1',
    'popup_windows_v1',
  ] as const)
    assert.ok(!app.capabilities.includes(capability), capability + ' is X11-only')
  // Requests the host cannot serve fail with service_unavailable, never hang.
  await assert.rejects(
    window.readClipboardText(),
    isService('clipboard_read', 'service_unavailable')
  )
  await assert.rejects(
    window.writeClipboardText('x'),
    isService('clipboard_write', 'service_unavailable')
  )
  await assert.rejects(
    window.registerGlobalShortcut({ key: 'k', control: true, alt: true }, () => {}),
    isService('global_shortcuts', 'service_unavailable')
  )
  // A window-surface popup is rejected by core before it reaches the host.
  await assert.rejects(
    window.batch((batch) => {
      batch.append(
        window.root,
        batch.create({
          kind: 'overlay',
          anchor: 'parent',
          surface: 'window',
          style: { width: 100, height: 50 },
        })
      )
    }),
    UnsupportedFeatureError
  )
  record('capabilities', {
    capabilities: app.capabilities,
    clipboardText: services.clipboardText,
    globalShortcuts: services.globalShortcuts,
    dragDrop: services.dragDrop,
    popupWindows: 'not advertised',
    notifications: services.notifications.availability,
    fileDialogs: services.fileDialogs.availability,
    windowDisplay: services.windowDisplay,
  })
}

async function qualify(app: NativeApplication) {
  // 1. The window opens, is mapped by the compositor as an xdg-shell view
  // (XWayland is disabled, so no X11 client can appear) and paints.
  const opening = performance.now()
  const window = await app.openWindow({ title: TITLE, ...SIZE })
  const ui = await window.batch((batch) => {
    const field = batch.create({ kind: 'input', value: '', style: { width: 300, height: 36 } })
    const button = batch.create({ kind: 'button', text: 'Press', style: { width: 140 } })
    const label = batch.create({ kind: 'text', text: 'Clicks: 0' })
    const swatch = batch.create({
      kind: 'box',
      style: { width: 120, height: 60, background: SWATCH },
    })
    for (const child of [field, button, label, swatch]) batch.append(window.root, child)
    return { field, button, label }
  })
  let clicks = 0
  window.on(ui.button, 'click', () => void (clicks += 1))
  const surface = await mapped(TITLE, OPEN_BOUND_MS)
  const initial = await painted(
    window,
    (nodes) =>
      nodes.some((node) => node.text === 'Press') &&
      nodes.some((node) => node.text === 'Clicks: 0'),
    'the initial tree'
  )
  const openMs = Math.round(performance.now() - opening)
  assert.ok(openMs < OPEN_BOUND_MS, 'open, map and paint within the bound')
  assert.equal(surface.shell, 'xdg_shell', 'a native Wayland xdg-shell surface')
  assert.deepEqual([surface.rect.width, surface.rect.height], [SIZE.width, SIZE.height])
  // The window's renderer is Mesa's CPU device, reached through Vulkan
  // (lavapipe); the session pins that one ICD.
  // This is the session's only window.
  const [renderer] = records<Renderer>('renderer')
  assert.ok(renderer?.gpu.is_software_emulated, 'a software renderer')
  const startup = records<StartupLog>('startup-log', 'stage')
  const adapter = startup.find(
    (entry) =>
      entry.target === 'gpui_wgpu::wgpu_context' &&
      String(entry.message).startsWith('Selected GPU (passed configuration test):')
  )
  assert.match(String(adapter?.message), /\(Vulkan\)$/, 'the selected adapter is Vulkan')
  assert.ok(
    !startup.some((entry) => String(entry.target).includes('x11')),
    'no X11 backend log point'
  )
  record('windowOpened', {
    openMs,
    boundMs: OPEN_BOUND_MS,
    shell: surface.shell,
    appId: surface.app_id,
    rect: surface.rect,
    renderer: renderer.gpu,
    adapter: adapter!.message,
    paint: { revision: initial.rendered.tree_revision },
  })

  await capabilities(app, window)

  // 2. A compositor pointer click activates the button; the label update is painted.
  await command(TITLE, 'focus')
  let origin = (await mapped(TITLE)).rect
  const button = bounds(initial, (node) => node.kind === 'button')
  await clickAt(...center(origin, button))
  await waitFor(() => clicks === 1, 'the compositor click')
  await window.batch((batch) => batch.set(ui.label, { kind: 'text', text: 'Clicks: 1' }))
  await painted(window, (nodes) => nodes.some((node) => node.text === 'Clicks: 1'), 'the click')
  record('pointerClick', { at: center(origin, button), clicks })

  // 3. Keyboard text reaches the focused input through the compositor:
  // ASCII plus a non-Latin-1 character from wtype's uploaded keymap.
  const text = 'Wayland ok é'
  const field = bounds(initial, (node) => node.kind === 'input')
  await clickAt(...center(origin, field))
  await type(text)
  await waitFor(() => window.input(ui.field).value === text, 'typed text in the input')
  const typed = await painted(
    window,
    (nodes) => nodes.some((node) => node.kind === 'input' && node.value === text),
    'the typed value'
  )
  // Return on the focused button is a second, keyboard activation.
  await clickAt(...center(origin, button))
  await waitFor(() => clicks === 2, 'the focusing click')
  await key('Return')
  await waitFor(() => clicks === 3, 'the keyboard activation')
  record('keyboardText', {
    value: window.input(ui.field).value,
    paintedRevision: typed.rendered.tree_revision,
    keyboardActivation: true,
  })

  // 4. Pixels read back through the compositor match the painted tree.
  origin = (await mapped(TITLE)).rect
  const swatch = bounds(typed, (node) => node.style?.background === SWATCH)
  await run(['grim', join(output!, 'screen.png')])
  const swatchPixel = await pixel('swatch', ...center(origin, swatch))
  assert.equal(swatchPixel.toString(16), SWATCH.toString(16), 'swatch background')
  const buttonPixel = await pixel('button', origin.x + button[0] + 4, origin.y + button[1] + 4)
  assert.equal(buttonPixel.toString(16), BUTTON.toString(16), 'native button background')
  record('screenshotOracle', { swatch: swatchPixel, button: buttonPixel, source: 'grim' })

  // 5. The display snapshot service agrees with the compositor's output.
  const outputs = JSON.parse(await swaymsg('-t', 'get_outputs', '--raw')) as {
    name: string
    active: boolean
    scale: number
    rect: { x: number; y: number; width: number; height: number }
  }[]
  const active = outputs.filter((entry) => entry.active)
  assert.equal(active.length, 1)
  const snapshot = await window.displaySnapshot()
  assert.deepEqual(snapshot, {
    bounds: active[0]!.rect,
    scaleFactor: active[0]!.scale,
  })
  const { name, rect, scale } = active[0]!
  record('displaySnapshot', { snapshot, compositor: { name, rect, scale } })

  // 6. Notifications reach a freedesktop server through D-Bus unchanged.
  const notification = await window.postNotification(
    { title: 'Bun Native Wayland', body: 'posted' },
    () => {}
  )
  await waitFor(
    async () => Number(await run(['dunstctl', 'count', 'displayed'])) === 1,
    'one displayed notification'
  )
  await notification.withdraw()
  await waitFor(
    async () => Number(await run(['dunstctl', 'count', 'displayed'])) === 0,
    'the notification withdrawn'
  )
  record('notification', { displayed: 1, withdrawn: true })

  // 7. The portal file chooser opens as its own unparented Wayland view
  // (no xdg-foreign handle is exported yet) and both cancellations close it.
  const aborting = new AbortController()
  const aborted = window.showOpenDialog({ title: DIALOG }, { signal: aborting.signal })
  const dialog = await mapped(DIALOG, 10_000)
  assert.equal(dialog.shell, 'xdg_shell')
  aborting.abort()
  await assert.rejects(aborted, isService('file_dialogs', 'cancelled'))
  await unmapped(DIALOG)
  const dismissed = window.showOpenDialog({ title: DIALOG })
  await mapped(DIALOG, 10_000)
  await command(DIALOG, 'kill')
  assert.deepEqual(await dismissed, { kind: 'cancelled' })
  await unmapped(DIALOG)
  record('fileDialog', { shell: dialog.shell, parent: 'none', abort: true, compositorClose: true })

  // 8. The compositor closes the window (xdg_toplevel.close); the host
  // reports it and the view is unmapped.
  await command(TITLE, 'kill')
  await window.closed
  await assert.rejects(window.displaySnapshot(), /closed/i)
  await unmapped(TITLE)
  record('compositorClose', { closed: true })
}

mkdirSync(join(output, 'portal'), { recursive: true })
const dunst = Bun.spawn(['dunst'], {
  stdout: 'ignore',
  stderr: Bun.file(join(output, 'dunst.log')),
})
const portal = await startPortal(join(output, 'portal'))
pointer = new PointerPeer()
assert.equal(await pointer.line(), 'ready')
// A keyboard that lives for the whole run. Each typing wtype adds and removes
// its own virtual keyboard; without a lasting one the seat's keyboard
// capability would appear with it, and its first key would race the client's
// new wl_keyboard (observed: the first character was lost). wtype's sleep
// command holds its device until it is stopped.
const keyboard = Bun.spawn(['wtype', '-s', '3600000'], { stdout: 'ignore', stderr: 'inherit' })
{
  // One seat with both devices (WL_SEAT_CAPABILITY_POINTER | _KEYBOARD) before
  // any client binds it; the single output defines the pointer's extent.
  await waitFor(async () => {
    const seats = JSON.parse(await swaymsg('-t', 'get_seats', '--raw')) as {
      capabilities: number
    }[]
    return seats.length === 1 && seats[0]!.capabilities === 3
  }, 'a seat with lasting pointer and keyboard capabilities')
  const outputs = JSON.parse(await swaymsg('-t', 'get_outputs', '--raw')) as {
    rect: { x: number; y: number; width: number; height: number }
  }[]
  assert.equal(outputs.length, 1)
  assert.deepEqual([outputs[0]!.rect.x, outputs[0]!.rect.y], [0, 0])
  layout = { width: outputs[0]!.rect.width, height: outputs[0]!.rect.height }
}
const app = await createApplication({
  executable,
  permissions: {
    windowDisplay: 'allow',
    clipboardRead: 'allow',
    clipboardWrite: 'allow',
    globalShortcuts: 'allow',
    notifications: 'allow',
    dragDrop: 'allow',
    fileDialogs: 'allow',
  },
})
try {
  await qualify(app)
} finally {
  await app.shutdown()
  await app.closed
  await portal.stop()
  await pointer.close()
  keyboard.kill()
  await keyboard.exited
  dunst.kill()
  await dunst.exited
}
assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
record('cleanShutdown', app.diagnostics)

writeFileSync(
  join(output, 'wayland.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      compositor: JSON.parse(await swaymsg('-t', 'get_version', '--raw')).human_readable,
      display:
        'headless sway (wlroots headless backend, pixman), one 1280x800 output at scale 1, XWayland disabled',
      input: 'zwlr_virtual_pointer_v1 (wayland-input-peer) and zwp_virtual_keyboard_v1 (wtype)',
      pixels: 'grim (wlr-screencopy)',
      geometry: 'sway IPC get_tree plus nonce-tagged native paint evidence',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Wayland qualification passed: ' + Object.keys(outcomes).length + ' outcomes')

/** The xdg-desktop-portal frontend and GTK backend, owned by this test. */
async function startPortal(configHome: string) {
  mkdirSync(join(configHome, 'xdg-desktop-portal'), { recursive: true })
  writeFileSync(
    join(configHome, 'xdg-desktop-portal', 'portals.conf'),
    '[preferred]\ndefault=gtk\n'
  )
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(configHome, 'data'),
    XDG_CACHE_HOME: join(configHome, 'cache'),
    XDG_STATE_HOME: join(configHome, 'state'),
    GTK_A11Y: 'none',
  }
  const owned = async (name: string) =>
    (
      await run(
        [
          'dbus-send',
          '--session',
          '--print-reply',
          '--dest=org.freedesktop.DBus',
          '/org/freedesktop/DBus',
          'org.freedesktop.DBus.NameHasOwner',
          'string:' + name,
        ],
        true
      )
    ).includes('boolean true')
  const backend = Bun.spawn(['/usr/libexec/xdg-desktop-portal-gtk', '--replace'], {
    env,
    stdout: 'ignore',
    stderr: Bun.file(join(output!, 'portal-gtk.log')),
  })
  await waitFor(() => owned('org.freedesktop.impl.portal.desktop.gtk'), 'the GTK backend')
  const frontend = Bun.spawn(['/usr/libexec/xdg-desktop-portal', '--replace'], {
    env,
    stdout: 'ignore',
    stderr: Bun.file(join(output!, 'portal.log')),
  })
  await waitFor(() => owned('org.freedesktop.portal.Desktop'), 'the portal frontend')
  await waitFor(() => owned('org.freedesktop.Notifications'), 'the notification server')
  return {
    async stop() {
      for (const child of [frontend, backend]) {
        child.kill()
        await child.exited
      }
    },
  }
}
