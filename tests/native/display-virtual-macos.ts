/**
 * Real macOS multi-display semantics (#299) on a hosted runner: a second
 * display created through CoreGraphics' CGVirtualDisplay
 * (tests/native/macos-virtual-display.m) at a different backing scale from
 * the runner's own display. Window migration, mixed DPI, display connection
 * and removal are real window-server operations: the helper connects and
 * releases the display, and moves owned windows through the Accessibility
 * API. Every expected value comes from NSScreen and CoreGraphics through
 * independent oracles that never load GPUI (tests/native/display-os.ts).
 */
import {
  createApplication,
  NativeStateError,
  type DisplayChangeEvent,
  type NativeApplication,
  type NativeDisplaySnapshot,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { assertRect, macScreens, run, settledDisplays, type ExpectedDisplay } from './display-os.ts'

const output = process.env['BUN_NATIVE_DISPLAY_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_DISPLAY_MODE']
const oracle = process.env['BUN_NATIVE_MACOS_DISPLAY_HELPER']
const virtual = process.env['BUN_NATIVE_MACOS_VIRTUAL_DISPLAY']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  (mode !== 'development' && mode !== 'aot') ||
  !oracle ||
  !isAbsolute(oracle) ||
  !virtual ||
  !isAbsolute(virtual)
)
  throw new Error(
    'macOS, an evidence directory, the host, the mode, the display oracle and the virtual display helper are required'
  )
const executable = host
const displayOracle = oracle
const virtualHelper = virtual

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const raw: Record<string, unknown[]> = {}
function keep(name: string, value: unknown) {
  ;(raw[name] ??= []).push(value)
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  detail: () => string = () => '',
  ms = 10_000
): Promise<T> {
  const deadline = performance.now() + ms
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() >= deadline)
      throw new Error(`${what} did not happen within ${ms} ms${detail()}`)
    await Bun.sleep(50)
  }
}

const settled = () => settledDisplays(() => macScreens(displayOracle, keep))

/** The snapshot is exactly `display` as the OS reports it now. */
function assertOn(snapshot: NativeDisplaySnapshot, display: ExpectedDisplay, at: string) {
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.bounds), `${at}: frozen`)
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['bounds', 'displayId', 'scaleFactor', 'visibleBounds'],
    at
  )
  assert.equal(snapshot.displayId, display.id, `${at}: display identity`)
  assert.equal(snapshot.scaleFactor, display.scale, `${at}: scale`)
  assertRect(snapshot.bounds, display.bounds, `${at}: bounds`)
  assertRect(snapshot.visibleBounds, display.visibleBounds, `${at}: work area`)
}
function isOn(snapshot: NativeDisplaySnapshot, display: ExpectedDisplay): boolean {
  try {
    assertOn(snapshot, display, 'candidate')
    return true
  } catch {
    return false
  }
}

interface Watched {
  title: string
  window: NativeWindow
  events: DisplayChangeEvent[]
}
async function open(app: NativeApplication, title: string): Promise<Watched> {
  const window = await app.openWindow({ title, width: 480, height: 320 })
  const events: DisplayChangeEvent[] = []
  window.onDisplayChange((event) => {
    assert(Object.isFrozen(event) && event.type === 'display_change')
    events.push(event)
  })
  await window.batch((batch) =>
    batch.append(window.root, batch.create({ kind: 'text', text: title }))
  )
  return { title, window, events }
}
const describe = (watched: Watched) => () =>
  `; ${watched.events.length} event(s): ` +
  JSON.stringify(watched.events.map((event) => event.snapshot))

/**
 * A display_change after `from` reporting `display` exactly. macOS can
 * announce the new screen before the window's new backing scale, so an
 * earlier event of the same move may carry the previous scale; the host
 * re-reads after the move and reports the settled snapshot.
 */
async function reported(watched: Watched, from: number, display: ExpectedDisplay, at: string) {
  const event = await waitFor(
    `${at}: a display_change for ${watched.title}`,
    () => watched.events.slice(from).find((item) => isOn(item.snapshot, display)),
    () => `; the OS reports ${JSON.stringify(display)}` + describe(watched)()
  )
  assertOn(await watched.window.displaySnapshot(), display, `${at}: read after the change`)
  return event
}

/** The host is this process's direct child; its executable is the host path. */
async function hostPid(): Promise<string> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).split('\n')
  for (const child of children.filter(Boolean)) {
    const command = await run(['ps', '-o', 'comm=', '-p', child])
    if (command === host || command.endsWith('/bun-native-host')) return child
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

/** Moves the window by the Accessibility API to a point inside `display`. */
async function moveOnto(pid: string, watched: Watched, display: ExpectedDisplay) {
  const origin = display.globalOrigin
  assert(origin, `${display.id} has a global origin`)
  const moved = JSON.parse(
    await run([
      virtualHelper,
      'move',
      pid,
      watched.title,
      String(origin.x + 40),
      String(origin.y + 80),
    ])
  ) as { moved: unknown }
  keep('moves', { title: watched.title, display: display.id, ...moved })
}

/** The connected virtual display: its helper process and first report. */
interface Connection {
  child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  lines: AsyncIterator<string>
  number: number
}
async function* readLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
    }
  }
  if (buffer) yield buffer
}
async function connect(width: number, height: number, scale: number): Promise<Connection> {
  const child = Bun.spawn([virtualHelper, 'create', String(width), String(height), String(scale)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines = readLines(child.stdout)
  const first = await Promise.race([
    lines.next(),
    Bun.sleep(30_000).then(() => ({ done: true, value: undefined }) as const),
  ])
  if (first.done || !first.value) {
    child.kill()
    const stderr = await new Response(child.stderr).text()
    throw new Error(`the virtual display helper did not connect a display: ${stderr.trim()}`)
  }
  const report = JSON.parse(first.value) as {
    connected?: { number: number }
    error?: string
  }
  keep('virtualDisplay', report)
  if (!report.connected) {
    child.kill()
    throw new Error('the virtual display helper failed: ' + first.value)
  }
  return { child, lines, number: report.connected.number }
}
/** Releases the display and waits until CoreGraphics reports it removed. */
async function disconnect(connection: Connection) {
  await connection.child.stdin.end()
  const line = await connection.lines.next()
  const code = await connection.child.exited
  const stderr = await new Response(connection.child.stderr).text()
  assert.equal(code, 0, `the virtual display helper exited ${code}: ${stderr.trim()}`)
  assert(!line.done, 'the helper reports the removal')
  const report = JSON.parse(line.value) as { disconnected?: number }
  keep('virtualDisplay', report)
  assert.equal(report.disconnected, connection.number)
}

async function stopped(app: NativeApplication) {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}

const trusted = JSON.parse(await run([virtualHelper, 'trusted'])) as { trusted: boolean }
assert(trusted.trusted, 'the virtual display helper is trusted for Accessibility')

const initial = await settled()
const main = initial.find((display) => display.primary)
assert(main, 'the OS reports a main display')
record('osDisplays', { displays: initial })
// The second display gets the other backing scale, so the two differ in DPI.
const virtualScale = main.scale === 2 ? 1 : 2

let connection: Connection | undefined
const app = await createApplication({ executable, permissions: { windowDisplay: 'allow' } })
let survivorSignal: AbortSignal | undefined
try {
  for (const capability of [
    'display_details_v1',
    'display_identity_v1',
    'display_changes_v1',
  ] as const)
    assert(app.capabilities.includes(capability), capability)
  const a = await open(app, 'Display virtual first')
  const b = await open(app, 'Display virtual second')
  const pid = await hostPid()
  // Launching the application resizes the Dock, and so the main work area, by a
  // few points (681 vs 684 in job 130733876820, as in run 42193523182), so the
  // first read is stale. As in display-platform.ts, the snapshots are compared
  // exactly with an OS state that is settled and unchanged both before and
  // after they are read; if it moved in between, the triple is read again.
  {
    const deadline = performance.now() + 20_000
    const history: string[] = []
    for (;;) {
      const before = await settled()
      const snapshots = [await a.window.displaySnapshot(), await b.window.displaySnapshot()]
      const after = await settled()
      if (JSON.stringify(before) === JSON.stringify(after)) {
        const opened = after.find((display) => display.primary)
        assert(opened && opened.id === main.id, 'the runner display stays the main display')
        for (const [index, watched] of [a, b].entries())
          assertOn(snapshots[index]!, opened, `${watched.title} on the main display`)
        break
      }
      history.push(JSON.stringify([before, after].map((list) => list.map((d) => d.visibleBounds))))
      if (performance.now() > deadline)
        throw new Error(
          'the OS work area kept changing while snapshots were read: ' + history.join(' ; ')
        )
    }
  }

  // 1. Connect a display of the other scale. Windows on the main display may
  //    only report the main display as the OS reports it.
  let [fromA, fromB] = [a.events.length, b.events.length]
  connection = await connect(1280, 800, virtualScale)
  const connected = await waitFor('the virtual display in NSScreen', async () => {
    const displays = await settled()
    return displays.some((display) => display.device === String(connection!.number))
      ? displays
      : undefined
  })
  const second = connected.find((display) => display.device === String(connection!.number))!
  const mainNow = connected.find((display) => display.primary)!
  assert.equal(mainNow.id, main.id, 'the runner display stays the main display')
  assert.notEqual(second.id, main.id, 'the virtual display has its own identity')
  assert.equal(second.scale, virtualScale, 'the virtual display has the requested scale')
  assert.notEqual(second.scale, mainNow.scale, 'the two displays differ in scale')
  await Bun.sleep(1_000)
  for (const [watched, from] of [
    [a, fromA],
    [b, fromB],
  ] as const)
    for (const event of watched.events.slice(from))
      assertOn(
        event.snapshot,
        mainNow,
        `${watched.title}: a change while another display connected`
      )
  record('connected', {
    virtualDisplay: second,
    mainDisplay: mainNow,
    changesOnMainDisplayWindows: a.events.length - fromA + (b.events.length - fromB),
  })

  // 2. Migration and mixed DPI: the window server moves one window onto the
  //    other display; it reports that display and its scale, the other window
  //    keeps reporting the main display.
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await moveOnto(pid, a, second)
  const migrated = await reported(a, fromA, second, 'move to the virtual display')
  for (const event of b.events.slice(fromB))
    assertOn(event.snapshot, mainNow, `${b.title}: unmoved window`)
  const [snapshotA, snapshotB] = [
    await a.window.displaySnapshot(),
    await b.window.displaySnapshot(),
  ]
  assertOn(snapshotA, second, 'mixed DPI, moved window')
  assertOn(snapshotB, mainNow, 'mixed DPI, unmoved window')
  assert.notEqual(snapshotA.scaleFactor, snapshotB.scaleFactor)
  fromA = a.events.length
  await moveOnto(pid, a, mainNow)
  const back = await reported(a, fromA, mainNow, 'move back to the main display')
  record('migration', {
    toVirtual: migrated.snapshot,
    mixedDpi: { moved: snapshotA, unmoved: snapshotB },
    backToMain: back.snapshot,
    eventsWhileMoving: a.events.slice(fromA).map((event) => event.snapshot),
  })

  // 3. Removing the display a window is on: macOS moves the window to the
  //    remaining display and the window reports it.
  fromA = a.events.length
  await moveOnto(pid, a, second)
  await reported(a, fromA, second, 'move to the display that will be removed')
  ;[fromA, fromB] = [a.events.length, b.events.length]
  await disconnect(connection)
  connection = undefined
  const remaining = await waitFor('the virtual display removed from NSScreen', async () => {
    const displays = await settled()
    return displays.some((display) => display.id === second.id) ? undefined : displays
  })
  const mainAfter = remaining.find((display) => display.primary)!
  assert.equal(mainAfter.id, main.id)
  const relocated = await reported(a, fromA, mainAfter, 'the window display was removed')
  for (const event of b.events.slice(fromB))
    assertOn(event.snapshot, mainAfter, `${b.title}: a change while another display was removed`)
  record('removed', {
    relocated: relocated.snapshot,
    otherWindowChanges: b.events.length - fromB,
    displays: remaining,
  })

  // 4. Close releases a window's listener; shutdown aborts the remaining ones.
  const callbacks = app.diagnostics.callbacks
  await b.window.close()
  assert.equal(app.diagnostics.callbacks, callbacks - 1, 'close releases its display listener')
  assert.throws(
    () => b.window.onDisplayChange(() => {}),
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  survivorSignal = a.events.at(-1)!.signal
  assert(!survivorSignal.aborted)
  record('revocation', { windowClose: 'listener released; onDisplayChange invalid_handle' })
} finally {
  // Never leave the runner with the virtual display connected.
  if (connection) await disconnect(connection).catch(() => connection?.child.kill())
  await stopped(app)
}
assert(survivorSignal?.aborted, 'shutdown aborts a live listener')
record('shutdown', { ownership: app.diagnostics, listenerSignalAborted: true })

writeFileSync(
  join(output, 'display-virtual-macos.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: process.platform,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display:
        'the hosted display plus a 1280x800 CGVirtualDisplay at the other backing scale (tests/native/macos-virtual-display.m)',
      operations:
        'CGVirtualDisplay connect and release; AXUIElementSetAttributeValue(kAXPositionAttribute) window moves',
      oracle:
        'tests/native/macos-display-oracle.m (NSScreen, CGDisplayBounds, CGDisplayCreateUUIDFromDisplayID) + osascript JXA NSScreen + system_profiler',
      outcomes,
      unavailable: {
        physicalHotplug:
          'the connected and removed display is a CoreGraphics virtual display, not a physical monitor or cable',
      },
      raw,
    },
    null,
    2
  ) + '\n'
)
console.log(
  'macOS virtual display qualification passed: ' + Object.keys(outcomes).length + ' outcomes'
)
