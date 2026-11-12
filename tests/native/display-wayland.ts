/**
 * Real Wayland multi-output display semantics (#299): window migration
 * between outputs, mixed output scales, output reconfiguration and hotplug,
 * on a headless sway (wlroots) session with two outputs owned by
 * scripts/quality/native-wayland-session.sh (BUN_NATIVE_WAYLAND_OUTPUTS=2).
 * Every expected value comes from the compositor's own IPC (swaymsg
 * get_outputs / get_tree), and every change is a real compositor operation:
 * `move container to output`, `move absolute position`, `output … resolution`,
 * `output … scale` (integer and fractional), `create_output` and
 * `output … unplug`. Each output's expected identity is v5(DNS, its sway
 * output name), computed here. No X server is reachable, so GPUI must use its
 * Wayland backend.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type DisplayChangeEvent,
  type NativeApplication,
  type NativeDisplaySnapshot,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { waylandOutputUuid } from './display-uuid.ts'

const output = process.env['BUN_NATIVE_DISPLAY_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_DISPLAY_MODE']
const FIRST = process.env['BUN_NATIVE_WAYLAND_OUTPUT']
const SECOND = process.env['BUN_NATIVE_WAYLAND_SECOND_OUTPUT']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['WAYLAND_DISPLAY'] ||
  !process.env['SWAYSOCK'] ||
  process.env['DISPLAY'] ||
  FIRST !== 'HEADLESS-1' ||
  SECOND !== 'HEADLESS-2'
)
  throw new Error(
    'An owned two-output sway session without X11, evidence directory, host and mode are required'
  )
const executable = host
const first = FIRST
const second = SECOND

/** How long a change that must not be reported is given to appear anyway. */
const QUIET_MS = 750
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
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  detail: () => string = () => '',
  ms = 5_000
): Promise<T> {
  const deadline = performance.now() + ms
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() >= deadline)
      throw new Error(`${what} did not happen within ${ms} ms${detail()}`)
    await Bun.sleep(20)
  }
}

// ---- compositor oracle (sway IPC) ----

type Rect = { x: number; y: number; width: number; height: number }
interface Output {
  name: string
  scale: number
  rect: Rect
  mode: { width: number; height: number }
}
async function outputs(): Promise<Output[]> {
  const raw = JSON.parse(await run(['swaymsg', '-t', 'get_outputs', '--raw'])) as {
    name: string
    active: boolean
    scale: number
    rect: Rect
    current_mode: { width: number; height: number }
  }[]
  return raw
    .filter((entry) => entry.active)
    .map(({ name, scale, rect, current_mode }) => ({
      name,
      scale,
      rect,
      mode: { width: current_mode.width, height: current_mode.height },
    }))
}
async function outputNamed(name: string): Promise<Output> {
  const found = (await outputs()).find((entry) => entry.name === name)
  assert(found, `sway reports an active output ${name}`)
  return found
}

type SwayNode = {
  name: string | null
  type: string
  shell?: string
  rect: Rect
  nodes: SwayNode[]
  floating_nodes: SwayNode[]
}
/** The output sway shows the view under, and the view's layout rectangle. */
async function placement(title: string): Promise<{ output: string; rect: Rect } | undefined> {
  const tree = JSON.parse(await run(['swaymsg', '-t', 'get_tree', '--raw'])) as SwayNode
  const found: { output: string; rect: Rect }[] = []
  const visit = (node: SwayNode, outputName: string) => {
    if (node.type === 'output') outputName = node.name!
    if (node.shell !== undefined && node.name === title)
      found.push({ output: outputName, rect: node.rect })
    for (const child of [...node.nodes, ...node.floating_nodes]) visit(child, outputName)
  }
  visit(tree, '')
  assert(found.length <= 1, `at most one view named ${title}`)
  return found[0]
}
const placed = (title: string) => waitFor(`a mapped view named ${title}`, () => placement(title))
async function placedOn(title: string, name: string) {
  return waitFor(
    `${title} on ${name}`,
    async () => {
      const where = await placement(title)
      return where?.output === name ? where : undefined
    },
    () => ''
  )
}
/** sway matches criteria as regular expressions; quote the exact title. */
const swaymsg = (title: string, ...action: string[]) =>
  run(['swaymsg', `[title="^${title.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&')}$"]`, ...action])

/**
 * What the pinned GPUI Wayland backend must report for a window on `entry`:
 * the output's current mode divided by its integer `wl_output.scale`, at the
 * origin of the output's `wl_output.geometry`, which wlroots always sends as
 * 0,0 (the output's layout position is only in xdg-output and sway's rect).
 * The scale factor is the window's `wp_fractional_scale_v1` scale, which
 * follows the output's. The identity is v5(DNS, the output's name).
 *
 * For a fractional output scale wlroots sends `wl_output.scale` as its
 * ceiling, and GPUI's display list divides the mode by that integer
 * (gpui_linux/src/linux/wayland/client.rs:1256 at the pinned revision), so
 * the bounds are not the output's logical size: 1280x800 at scale 1.5 reports
 * 640x400, where sway's logical rect is 853x533. That is the pinned
 * behaviour, recorded here as such rather than corrected.
 */
function expected(entry: Output): NativeDisplaySnapshot {
  assert(
    Math.abs(entry.mode.width / entry.scale - entry.rect.width) < 1 &&
      Math.abs(entry.mode.height / entry.scale - entry.rect.height) < 1,
    `${entry.name}: sway's logical size is the mode divided by the scale`
  )
  const outputScale = Math.ceil(entry.scale)
  return {
    bounds: {
      x: 0,
      y: 0,
      width: entry.mode.width / outputScale,
      height: entry.mode.height / outputScale,
    },
    scaleFactor: entry.scale,
    displayId: waylandOutputUuid(entry.name),
  }
}
function same(snapshot: NativeDisplaySnapshot, want: NativeDisplaySnapshot): boolean {
  return (
    snapshot.scaleFactor === want.scaleFactor &&
    snapshot.displayId === want.displayId &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(snapshot.bounds[key] - want.bounds[key]) <= 1e-3
    )
  )
}
function assertSnapshot(snapshot: NativeDisplaySnapshot, want: NativeDisplaySnapshot, at: string) {
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.bounds), `${at}: frozen`)
  assert.deepEqual(Object.keys(snapshot).sort(), ['bounds', 'displayId', 'scaleFactor'], at)
  assert(same(snapshot, want), `${at}: ${JSON.stringify(snapshot)} != ${JSON.stringify(want)}`)
}

// ---- owned windows and their change listeners ----

interface Watched {
  title: string
  window: NativeWindow
  events: DisplayChangeEvent[]
  remove: () => void
}
async function open(app: NativeApplication, title: string): Promise<Watched> {
  const window = await app.openWindow({ title, width: 480, height: 320 })
  const events: DisplayChangeEvent[] = []
  const remove = window.onDisplayChange((event) => {
    assert(Object.isFrozen(event) && event.type === 'display_change')
    assert(!event.signal.aborted)
    events.push(event)
  })
  await window.batch((batch) =>
    batch.append(window.root, batch.create({ kind: 'text', text: title }))
  )
  return { title, window, events, remove }
}
const describe = (watched: Watched) => () =>
  `; ${watched.events.length} event(s): ` +
  JSON.stringify(watched.events.map((event) => event.snapshot))
/**
 * Waits for the window's next display_change after `from`, which must be the
 * only one and already carry the final geometry and scale together.
 */
async function changed(watched: Watched, from: number, want: NativeDisplaySnapshot, at: string) {
  const event = await waitFor(
    `${at}: a display_change for ${watched.title}`,
    () => watched.events[from],
    describe(watched)
  )
  assert(
    same(event.snapshot, want),
    `${at}: the change reports ${JSON.stringify(event.snapshot)}, the compositor ${JSON.stringify(want)}`
  )
  if (from > 0) assert(event.sequence > watched.events[from - 1]!.sequence, `${at}: sequence`)
  assertSnapshot(await watched.window.displaySnapshot(), want, `${at}: read after change`)
  assert.equal(watched.events.length, from + 1, `${at}: one change${describe(watched)()}`)
  return event
}
/** Asserts that none of `windows` reports a change for QUIET_MS. */
async function quiet(windows: [Watched, number][], at: string) {
  await Bun.sleep(QUIET_MS)
  for (const [watched, from] of windows)
    assert.equal(
      watched.events.length,
      from,
      `${at}: ${watched.title} reported no change${describe(watched)()}`
    )
}
const isUnavailable = (error: unknown) =>
  error instanceof NativeServiceError &&
  error.service === 'window_display' &&
  error.code === 'service_unavailable'

async function stopped(app: NativeApplication) {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}

// 0. Two outputs of different scale, from the compositor.
const initialOutputs = await outputs()
assert.deepEqual(
  initialOutputs.map((entry) => entry.name),
  [first, second]
)
const [one, two] = [await outputNamed(first), await outputNamed(second)]
assert.equal(one.scale, 1)
assert.equal(two.scale, 2)
assert.notDeepEqual(expected(one), expected(two))
assert.notEqual(expected(one).displayId, expected(two).displayId, 'outputs have distinct names')
record('outputs', { source: 'swaymsg -t get_outputs', outputs: initialOutputs })

// 1. Denial: the change and identity capabilities are advertised, the grant is not.
{
  const denied = await createApplication({ executable })
  try {
    assert.deepEqual(denied.serviceCapabilities.windowDisplay, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_window',
      details: 'unavailable',
      identity: 'available',
      changes: 'available',
    })
    const window = await denied.openWindow({ title: 'Display Wayland denied' })
    await assert.rejects(
      window.displaySnapshot(),
      (error: unknown) => error instanceof NativeServiceError && error.code === 'permission_denied'
    )
    assert.throws(
      () => window.onDisplayChange(() => {}),
      (error: unknown) => error instanceof NativeServiceError && error.code === 'permission_denied'
    )
  } finally {
    await stopped(denied)
  }
  record('denied', { snapshot: 'permission_denied', onDisplayChange: 'permission_denied' })
}

const app = await createApplication({ executable, permissions: { windowDisplay: 'allow' } })
let survivorSignal: AbortSignal | undefined
try {
  assert(app.capabilities.includes('display_changes_v1'))
  assert(app.capabilities.includes('display_identity_v1'))
  assert(!app.capabilities.includes('display_details_v1'))

  // 2. A window's snapshot is the output sway maps it on. With two outputs the
  //    window has no display until the compositor's first wl_surface.enter;
  //    that first enter is reported once.
  const a = await open(app, 'Display Wayland first')
  const b = await open(app, 'Display Wayland second')
  for (const watched of [a, b]) {
    const where = await placed(watched.title)
    const want = expected(await outputNamed(where.output))
    await changed(watched, 0, want, `${watched.title} mapped`)
    assert.equal(watched.events.length, 1, `${watched.title}: one initial display_change`)
  }
  assert.equal((await placement(a.title))!.output, first, 'sway maps new views on the first output')
  assert.equal((await placement(b.title))!.output, first)
  record('mapped', {
    first: a.events[0]!.snapshot,
    second: b.events[0]!.snapshot,
    compositor: await placement(a.title),
  })

  // 3. Migration to the scale-2 output: one change with the new output's
  //    logical size and scale, only for the moved window.
  let [fromA, fromB] = [a.events.length, b.events.length]
  await swaymsg(a.title, 'move', 'container', 'to', 'output', second)
  await placedOn(a.title, second)
  const migrated = await changed(a, fromA, expected(two), 'move to the scale-2 output')
  assert.equal(a.events.length, fromA + 1, 'one change for one migration')
  await quiet([[b, fromB]], 'the other window stayed')
  assertSnapshot(await b.window.displaySnapshot(), expected(one), 'unmoved window')

  // 4. Moving and resizing within the output reports nothing.
  fromA = a.events.length
  await swaymsg(a.title, 'move', 'absolute', 'position', String(two.rect.x + 40), '40')
  await swaymsg(a.title, 'resize', 'set', '360', '240')
  // sway keeps a floating view's centre when it resizes it.
  let lastPlacement: unknown
  const within = await waitFor(
    'the move and resize within the scale-2 output',
    async () => {
      const where = (lastPlacement = await placement(a.title))
      return where?.output === second &&
        where.rect.x === two.rect.x + 40 + 60 &&
        where.rect.width === 360
        ? where
        : undefined
    },
    () => '; sway reports ' + JSON.stringify(lastPlacement)
  )
  await quiet([[a, fromA]], 'move and resize within one output')
  assertSnapshot(await a.window.displaySnapshot(), expected(two), 'moved within the output')

  // 5. A window spanning both outputs keeps the higher-scale one (GPUI's
  //    primary output is the entered output with the largest scale); leaving
  //    it entirely for the scale-1 output is a migration back.
  await swaymsg(a.title, 'move', 'absolute', 'position', String(two.rect.x - 180), '40')
  const spanning = await waitFor('the view spanning both outputs', async () => {
    const where = await placement(a.title)
    return where && where.rect.x === two.rect.x - 180 ? where : undefined
  })
  await quiet([[a, fromA]], 'spanning both outputs')
  assertSnapshot(await a.window.displaySnapshot(), expected(two), 'spanning window')
  await swaymsg(a.title, 'move', 'absolute', 'position', '40', '40')
  await placedOn(a.title, first)
  const back = await changed(a, fromA, expected(one), 'move back to the scale-1 output')
  record('migration', {
    toScaleTwo: migrated.snapshot,
    withinOutput: { compositor: within, reported: 'nothing' },
    spanning: { compositor: spanning, snapshot: expected(two), reported: 'nothing' },
    backToScaleOne: back.snapshot,
    otherWindow: 'no change',
  })

  // 6. Reconfiguring the windows' output reports to each window on it, and
  //    reconfiguring another output reports nothing.
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', first, 'resolution', '1600x1000'])
  const resized = await waitFor('the first output at 1600x1000', async () => {
    const entry = await outputNamed(first)
    return entry.rect.width === 1600 ? entry : undefined
  })
  await changed(a, fromA, expected(resized), 'mode change')
  await changed(b, fromB, expected(resized), 'mode change, second window')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', first, 'scale', '2'])
  const rescaled = await waitFor('the first output at scale 2', async () => {
    const entry = await outputNamed(first)
    return entry.scale === 2 ? entry : undefined
  })
  const scaleEvent = await changed(a, fromA, expected(rescaled), 'scale change')
  await changed(b, fromB, expected(rescaled), 'scale change, second window')
  const scaleSteps = a.events.slice(fromA).map((event) => event.snapshot)
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', first, 'resolution', '1280x800', 'scale', '1'])
  const restored = await waitFor('the first output restored', async () => {
    const entry = await outputNamed(first)
    return entry.scale === 1 && entry.rect.width === 1280 ? entry : undefined
  })
  assert.deepEqual(expected(restored), expected(one))
  await changed(a, fromA, expected(one), 'restore')
  await changed(b, fromB, expected(one), 'restore, second window')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', second, 'scale', '1'])
  await waitFor('the second output at scale 1', async () =>
    (await outputNamed(second)).scale === 1 ? true : undefined
  )
  await run(['swaymsg', 'output', second, 'scale', '2'])
  await waitFor('the second output back at scale 2', async () =>
    (await outputNamed(second)).scale === 2 ? true : undefined
  )
  await quiet(
    [
      [a, fromA],
      [b, fromB],
    ],
    'another output reconfigured'
  )

  // A fractional output scale reaches the window through
  // wp_fractional_scale_v1: one change to @1.5 and one back. The bounds are
  // the mode divided by wl_output.scale, its ceiling 2 (640x400, not the
  // 853x533 logical size; see expected()). The identity stays the output's.
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', first, 'scale', '1.5'])
  const fractional = await waitFor('the first output at scale 1.5', async () => {
    const entry = await outputNamed(first)
    return entry.scale === 1.5 ? entry : undefined
  })
  const fractionalEvent = await changed(a, fromA, expected(fractional), 'fractional scale')
  await changed(b, fromB, expected(fractional), 'fractional scale, second window')
  assert.equal(fractionalEvent.snapshot.displayId, expected(one).displayId, 'same output identity')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', first, 'scale', '1'])
  await waitFor('the first output back at scale 1', async () =>
    (await outputNamed(first)).scale === 1 ? true : undefined
  )
  await changed(a, fromA, expected(one), 'fractional scale restored')
  await changed(b, fromB, expected(one), 'fractional scale restored, second window')
  record('reconfiguration', {
    modeChange: expected(resized),
    scaleChange: { final: scaleEvent.snapshot, reportedSteps: scaleSteps },
    fractionalScale: {
      compositor: fractional,
      reported: fractionalEvent.snapshot,
      logicalSize: { width: fractional.rect.width, height: fractional.rect.height },
    },
    restored: expected(one),
    otherOutput: 'no change',
  })

  // 7. Hotplug: a new output reports nothing to windows elsewhere, a window
  //    moved onto it reports it, and unplugging an output no window is on
  //    reports nothing.
  ;[fromA, fromB] = [a.events.length, b.events.length]
  const before = new Set((await outputs()).map((entry) => entry.name))
  await run(['swaymsg', 'create_output'])
  const added = await waitFor('a created output', async () =>
    (await outputs()).find((entry) => !before.has(entry.name))
  )
  await quiet(
    [
      [a, fromA],
      [b, fromB],
    ],
    'an output was connected'
  )
  await swaymsg(a.title, 'move', 'container', 'to', 'output', added.name)
  await placedOn(a.title, added.name)
  const onAdded = await changed(a, fromA, expected(added), 'move to the connected output')
  assert(
    ![expected(one).displayId, expected(two).displayId].includes(onAdded.snapshot.displayId),
    'a connected output has its own identity'
  )
  fromA = a.events.length
  await swaymsg(a.title, 'move', 'container', 'to', 'output', first)
  await placedOn(a.title, first)
  await changed(a, fromA, expected(one), 'move back from the connected output')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', added.name, 'unplug'])
  await waitFor('the created output removed', async () =>
    (await outputs()).some((entry) => entry.name === added.name) ? undefined : true
  )
  await quiet(
    [
      [a, fromA],
      [b, fromB],
    ],
    'an unused output was disconnected'
  )
  assertSnapshot(await a.window.displaySnapshot(), expected(one), 'after an unused unplug')
  record('hotplug', {
    connected: added,
    movedOnto: onAdded.snapshot,
    unusedDisconnected: 'no change',
  })

  // 8. Unplugging the window's own output. sway moves the view to the
  //    remaining output without a wl_surface.leave for the removed one, and
  //    the pinned GPUI keeps the removed output as the window's display and
  //    reports no move. The host fails closed: no change is reported and the
  //    snapshot is service_unavailable, also after a new output reuses the
  //    removed output's protocol id. A window opened afterwards is correct.
  fromA = a.events.length
  await swaymsg(a.title, 'move', 'container', 'to', 'output', second)
  await placedOn(a.title, second)
  await changed(a, fromA, expected(two), 'move to the output that will be unplugged')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await run(['swaymsg', 'output', second, 'unplug'])
  const relocated = await placedOn(a.title, first)
  await quiet(
    [
      [a, fromA],
      [b, fromB],
    ],
    "the window's output was disconnected"
  )
  await assert.rejects(a.window.displaySnapshot(), isUnavailable)
  assertSnapshot(await b.window.displaySnapshot(), expected(one), 'window on the remaining output')
  const beforeReplug = new Set((await outputs()).map((entry) => entry.name))
  await run(['swaymsg', 'create_output'])
  const replugged = await waitFor('a created output after the unplug', async () =>
    (await outputs()).find((entry) => !beforeReplug.has(entry.name))
  )
  await run(['swaymsg', 'output', replugged.name, 'scale', '2'])
  await waitFor('the created output at scale 2', async () =>
    (await outputNamed(replugged.name)).scale === 2 ? true : undefined
  )
  await quiet(
    [
      [a, fromA],
      [b, fromB],
    ],
    'a new output after the unplug'
  )
  await assert.rejects(a.window.displaySnapshot(), isUnavailable)
  const c = await open(app, 'Display Wayland after unplug')
  const cPlaced = await placed(c.title)
  await changed(c, 0, expected(await outputNamed(cPlaced.output)), 'window opened after unplug')
  record('ownOutputDisconnected', {
    compositorRelocated: relocated,
    disconnectedWindow: 'service_unavailable, no change reported',
    afterNewOutput: { output: replugged.name, disconnectedWindow: 'service_unavailable' },
    otherWindow: expected(one),
    newWindow: c.events[0]!.snapshot,
  })

  // 9. Revocation: a removed listener receives nothing later, close releases
  //    the window's listener and shutdown aborts the remaining ones.
  b.remove()
  b.remove()
  ;[fromB] = [b.events.length]
  const fromC = c.events.length
  await run(['swaymsg', 'output', first, 'resolution', '1440x900'])
  const last = await waitFor('the first output at 1440x900', async () => {
    const entry = await outputNamed(first)
    return entry.rect.width === 1440 ? entry : undefined
  })
  await changed(c, fromC, expected(last), 'mode change after a listener was removed')
  await quiet([[b, fromB]], 'removed listener')
  const callbacks = app.diagnostics.callbacks
  await c.window.close()
  assert.equal(app.diagnostics.callbacks, callbacks - 1, 'close releases its display listener')
  assert.throws(
    () => c.window.onDisplayChange(() => {}),
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  await assert.rejects(
    c.window.displaySnapshot(),
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  survivorSignal = a.events.at(-1)!.signal
  assert(!survivorSignal.aborted)
  record('revocation', {
    removedListener: 'no later change',
    windowClose: 'listener released; onDisplayChange and displaySnapshot invalid_handle',
  })
} finally {
  await stopped(app)
}
assert(survivorSignal?.aborted, 'shutdown aborts a live listener')
record('shutdown', { ownership: app.diagnostics, listenerSignalAborted: true })

writeFileSync(
  join(output, 'display-wayland.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      compositor: JSON.parse(await run(['swaymsg', '-t', 'get_version', '--raw'])),
      display: 'headless sway, two outputs (1280x800 scale 1; 2048x1536 scale 2)',
      operations:
        'swaymsg move container to output, move absolute position, resize set, output resolution/scale (2 and 1.5), create_output, output unplug',
      identity: 'displayId = v5(DNS, sway output name), the wl_output v4 name',
      outcomes,
      unavailable: {
        workArea: 'Wayland gives clients no work area; display_details_v1 is not advertised',
        layoutOrigin:
          'bounds start at wl_output.geometry, which wlroots sends as 0,0; the layout position is not reported',
        fractionalScaleBounds:
          'at a fractional output scale the bounds are the mode divided by the integer wl_output.scale (its ceiling), not the logical size: the pinned GPUI Wayland display list uses the integer scale (gpui_linux/src/linux/wayland/client.rs:1256)',
        physicalMonitorIdentity:
          'the identity names the compositor connector (wl_output.name), not an EDID monitor',
        ownOutputUnplug:
          'the pinned GPUI keeps the removed output; the host fails closed with service_unavailable',
      },
    },
    null,
    2
  ) + '\n'
)
console.log('Wayland display qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
