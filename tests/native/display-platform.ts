/**
 * Real macOS / Windows display-snapshot semantics (#299). Every expected value
 * comes from an independent OS oracle that never loads GPUI: NSScreen and
 * CoreGraphics through a compiled AppKit helper plus `osascript` (JXA) and
 * `system_profiler` on macOS; System.Windows.Forms.Screen and the per-monitor
 * effective DPI through PowerShell on Windows. A display change is a real OS
 * display-mode change made by that oracle and always restored. Hosted runners
 * have one virtual display, so window migration, hotplug and mixed DPI are
 * recorded as unavailable rather than simulated.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type DisplayChangeEvent,
  type NativeApplication,
  type NativeDisplaySnapshot,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_DISPLAY_EVIDENCE']
const host = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_DISPLAY_MODE']
const macHelper = process.env['BUN_NATIVE_MACOS_DISPLAY_HELPER']
const windowsOracle = process.env['BUN_NATIVE_WINDOWS_DISPLAY_ORACLE']
const platform = process.platform
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  (mode !== 'development' && mode !== 'aot') ||
  (platform !== 'darwin' && platform !== 'win32') ||
  (platform === 'darwin' && (!macHelper || !isAbsolute(macHelper))) ||
  (platform === 'win32' && (!windowsOracle || !isAbsolute(windowsOracle)))
)
  throw new Error(
    'macOS or Windows, an evidence directory, the host, the mode and the platform display oracle are required'
  )
const executable = host

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const unavailable: Record<string, string> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(
    JSON.stringify({
      outcome: name,
      atMs: Math.round(performance.now() - started),
    })
  )
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

type Rect = { x: number; y: number; width: number; height: number }
/** A display as GPUI's backend must report it, derived only from OS values. */
interface ExpectedDisplay {
  id: string
  bounds: Rect
  visibleBounds: Rect
  scale: number
  primary: boolean
  /** Opaque handle the oracle uses to change this display's mode. */
  device: string
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-2
function assertRect(actual: Rect | undefined, expected: Rect, context: string) {
  assert(actual, `${context}: missing`)
  for (const key of ['x', 'y', 'width', 'height'] as const)
    assert(
      close(actual[key], expected[key]),
      `${context}: ${key} ${actual[key]} != ${expected[key]}`
    )
}

/** RFC 4122 version 5 (SHA-1) UUID, computed here independently of GPUI. */
function uuidV5(namespace: string, name: Uint8Array): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name)
    .digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * GPUI's Windows display UUID is v5(DNS, big-endian UTF-16 bytes of the whole
 * 32-unit `szDevice` buffer from GetMonitorInfoW, NUL padding included). It
 * therefore names a GDI device such as `\\.\DISPLAY1`, not a physical monitor.
 */
function windowsDeviceUuid(deviceName: string): string {
  assert(deviceName.length < 32, 'GDI device names fit in szDevice')
  const bytes = new Uint8Array(64)
  for (let index = 0; index < deviceName.length; index++) {
    const unit = deviceName.charCodeAt(index)
    bytes[index * 2] = unit >> 8
    bytes[index * 2 + 1] = unit & 0xff
  }
  return uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', bytes)
}

const raw: Record<string, unknown[]> = {}
function keep(name: string, value: unknown) {
  ;(raw[name] ??= []).push(value)
}

async function macScreens(): Promise<ExpectedDisplay[]> {
  type Screen = {
    number: number
    uuid: string | null
    frame: Rect
    visibleFrame: Rect
    backingScaleFactor: number
    cgBounds: Rect
    main: boolean
  }
  const screens = JSON.parse(await run([macHelper!, 'screens'])) as Screen[]
  keep('nsscreenHelper', screens)
  // A second, interpreted NSScreen read through osascript must agree.
  const jxa = JSON.parse(
    await run([
      'osascript',
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  const v = s.visibleFrame;
  out.push({
    number: s.deviceDescription.objectForKey($('NSScreenNumber')).unsignedIntValue,
    frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height },
    visibleFrame: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height },
    backingScaleFactor: s.backingScaleFactor,
  });
}
JSON.stringify(out);`,
    ])
  ) as Pick<Screen, 'number' | 'frame' | 'visibleFrame' | 'backingScaleFactor'>[]
  keep('nsscreenOsascript', jxa)
  assert.equal(jxa.length, screens.length, 'osascript and AppKit see the same screens')
  for (const [index, screen] of screens.entries()) {
    const other = jxa[index]!
    assert.equal(other.number, screen.number)
    assert.equal(other.backingScaleFactor, screen.backingScaleFactor)
    assertRect(other.frame, screen.frame, 'osascript frame')
    assertRect(other.visibleFrame, screen.visibleFrame, 'osascript visibleFrame')
    // NSScreen points and CoreGraphics display bounds describe the same size.
    assert(close(screen.cgBounds.width, screen.frame.width))
    assert(close(screen.cgBounds.height, screen.frame.height))
  }
  keep('systemProfiler', JSON.parse(await run(['system_profiler', '-json', 'SPDisplaysDataType'])))
  return screens.map((screen) => {
    assert(screen.uuid, `display ${screen.number} has a CoreGraphics UUID`)
    const frame = screen.frame
    const visible = screen.visibleFrame
    return {
      id: screen.uuid.toLowerCase(),
      device: String(screen.number),
      primary: screen.main,
      scale: screen.backingScaleFactor,
      // GPUI's macOS display reports the CoreGraphics size at the origin.
      bounds: {
        x: 0,
        y: 0,
        width: screen.cgBounds.width,
        height: screen.cgBounds.height,
      },
      // AppKit is bottom-left; the work area is reported top-left within the screen.
      visibleBounds: {
        x: visible.x - frame.x,
        y: frame.y + frame.height - (visible.y + visible.height),
        width: visible.width,
        height: visible.height,
      },
    }
  })
}

async function windowsScreens(): Promise<ExpectedDisplay[]> {
  type Screen = {
    deviceName: string
    primary: boolean
    bounds: Rect
    workingArea: Rect
    dpiX: number
    dpiY: number
  }
  const result = JSON.parse(
    await run(['pwsh', '-NoProfile', '-NonInteractive', '-File', windowsOracle!, 'screens'])
  ) as {
    dpiAwarenessSet: boolean
    dpiAwarenessError: number
    screens: Screen[]
  }
  keep('windowsFormsScreen', result)
  return result.screens.map((screen) => {
    assert.equal(screen.dpiX, screen.dpiY)
    const scale = screen.dpiX / 96
    const logical = (rect: Rect): Rect => ({
      x: rect.x / scale,
      y: rect.y / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    })
    return {
      id: windowsDeviceUuid(screen.deviceName),
      device: screen.deviceName,
      primary: screen.primary,
      scale,
      bounds: logical(screen.bounds),
      visibleBounds: logical(screen.workingArea),
    }
  })
}

const screens = () => (platform === 'darwin' ? macScreens() : windowsScreens())

/**
 * The OS displays once they stop changing. macOS relayouts the Dock (and so
 * the work area) for a few seconds after a display mode change, so a read made
 * right after a change, or after an earlier run's change, races that relayout.
 * Two reads 400 ms apart must agree; the read is never relaxed beyond that.
 *
 * The 15 s bounds how long the reads may keep disagreeing, not how long one
 * read may take: the first Windows oracle read starts PowerShell and loads
 * Windows Forms, which took the whole window on a loaded hosted runner (hosted
 * run 42212362205: one read, 22 s after launch, then "did not settle" with a
 * single state that no second read had contradicted). A state read before the
 * deadline is therefore always compared with one more read, however long each
 * takes.
 */
async function settledScreens(): Promise<ExpectedDisplay[]> {
  const deadline = performance.now() + 15_000
  let previous: string | undefined
  let latest: ExpectedDisplay[] | undefined
  let failure: unknown
  let overdue = 0
  while (performance.now() < deadline || (previous !== undefined && overdue++ < 1)) {
    try {
      latest = await screens()
      failure = undefined
      const text = JSON.stringify(latest)
      if (text === previous) return latest
      previous = text
    } catch (error) {
      // The two independent oracle reads disagreed mid-relayout.
      failure = error
      previous = undefined
    }
    await Bun.sleep(400)
  }
  if (failure !== undefined) throw failure
  throw new Error('the OS display state did not settle within 15 s: ' + JSON.stringify(latest))
}

/**
 * Both windows' snapshots, compared exactly with the OS state they were read
 * in. macOS resizes the Dock, and so the work area, when an application
 * launches or quits and after a display-mode cycle (hosted run 42193523182:
 * the restored 1024x768 display kept a 684-point work area where it started
 * at 681 because the Dock shrank by three points). A single oracle read taken
 * before the host launched can therefore be stale by the time the host reads
 * the same display. The OS must be settled and unchanged both before and
 * after the snapshots; if it moved in between, the pair is read again, and a
 * display that never holds still fails with every state it passed through.
 * No value is ever compared with a tolerance.
 */
type OwnedWindow = Awaited<ReturnType<typeof open>>
async function snapshotWithinSettledOs(first: OwnedWindow, second: OwnedWindow) {
  const deadline = performance.now() + 20_000
  const history: string[] = []
  for (;;) {
    const before = await settledScreens()
    const initial = await first.displaySnapshot()
    const other = await second.displaySnapshot()
    const after = await settledScreens()
    if (JSON.stringify(before) === JSON.stringify(after)) {
      const display = assertSnapshot(initial, after, 'first window')
      assert.deepEqual(other, initial, 'same display, same snapshot')
      return { initial, display }
    }
    history.push(
      JSON.stringify([before, after].map((list) => list.map((item) => item.visibleBounds)))
    )
    if (performance.now() > deadline)
      throw new Error(
        'the OS work area kept changing while the snapshot was read: ' + history.join(' ; ')
      )
  }
}

function owning(snapshot: NativeDisplaySnapshot, displays: ExpectedDisplay[]): ExpectedDisplay {
  assert(snapshot.displayId, 'a macOS/Windows snapshot names its display')
  const matches = displays.filter((display) => display.id === snapshot.displayId)
  assert.equal(matches.length, 1, `exactly one OS display has id ${snapshot.displayId}`)
  return matches[0]!
}

function assertSnapshot(
  snapshot: NativeDisplaySnapshot,
  displays: ExpectedDisplay[],
  context: string
): ExpectedDisplay {
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.bounds), `${context}: frozen`)
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['bounds', 'displayId', 'scaleFactor', 'visibleBounds'],
    context
  )
  const display = owning(snapshot, displays)
  assert.equal(snapshot.scaleFactor, display.scale, `${context}: scale`)
  assertRect(snapshot.bounds, display.bounds, `${context}: bounds`)
  assertRect(snapshot.visibleBounds, display.visibleBounds, `${context}: work area`)
  return display
}

async function stopped(app: NativeApplication) {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}

async function open(app: NativeApplication, title: string) {
  const window = await app.openWindow({ title, width: 480, height: 320 })
  await window.batch((batch) =>
    batch.append(window.root, batch.create({ kind: 'text', text: title }))
  )
  return window
}

async function waitFor<T>(
  what: string,
  ms: number,
  probe: () => T | undefined,
  detail: () => string = () => ''
): Promise<T> {
  const deadline = performance.now() + ms
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (performance.now() >= deadline)
      throw new Error(`${what} did not happen within ${ms} ms${detail()}`)
    await Bun.sleep(20)
  }
}

type Mode = { width: number; height: number }
type OsMode = Mode & Record<string, number>
async function displayModes(display: ExpectedDisplay) {
  const text =
    platform === 'darwin'
      ? await run([macHelper!, 'modes', display.device])
      : await run([
          'pwsh',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          windowsOracle!,
          'modes',
          '-Device',
          display.device,
        ])
  const parsed = JSON.parse(text) as {
    current: OsMode
    /** macOS only: the current mode's index among the desktop modes, or -1. */
    currentIndex?: number
    modes: OsMode[]
  }
  keep('displayModes', parsed)
  return parsed
}

/** Candidate modes with a different logical size, nearest the current size first. */
function candidates(current: OsMode, modes: OsMode[]) {
  const seen = new Set<string>()
  return modes
    .filter((candidate) => {
      const key = `${candidate.width}x${candidate.height}`
      const same =
        platform === 'darwin'
          ? candidate['refresh'] === current['refresh'] &&
            // The oracle also lists HiDPI duplicates; keep the current scale.
            Number(candidate['pixelWidth']) * current.width ===
              Number(current['pixelWidth']) * candidate.width
          : candidate['bitsPerPel'] === current['bitsPerPel'] &&
            candidate['frequency'] === current['frequency']
      if (
        !same ||
        seen.has(key) ||
        (candidate.width === current.width && candidate.height === current.height) ||
        candidate.width < 800 ||
        candidate.height < 600
      )
        return false
      seen.add(key)
      return true
    })
    .sort(
      (a, b) =>
        Math.abs(a.width * a.height - current.width * current.height) -
        Math.abs(b.width * b.height - current.width * current.height)
    )
}

async function applyMode(display: ExpectedDisplay, candidate: OsMode) {
  if (platform === 'darwin')
    return run([macHelper!, 'set', display.device, String(candidate['index'])])
  return run([
    'pwsh',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    windowsOracle!,
    'set',
    '-Device',
    display.device,
    '-Width',
    String(candidate.width),
    '-Height',
    String(candidate.height),
  ])
}

const backend = platform === 'darwin' ? 'macOS AppKit/CoreGraphics' : 'Windows Win32'
const initialDisplays = await settledScreens()
assert(initialDisplays.length >= 1, 'the OS reports at least one display')
record('osDisplays', { backend, displays: initialDisplays })
if (initialDisplays.length === 1) {
  unavailable['windowMigration'] =
    'the hosted runner has one display, so no window can move to another display'
  unavailable['mixedDpi'] = 'the hosted runner has one display and therefore one scale factor'
}
unavailable['hotplug'] = 'hosted runner displays are virtual; none can be connected or removed'

// 1. Denial: the capability is advertised, the grant is not.
{
  const denied = await createApplication({ executable })
  try {
    assert.deepEqual(denied.serviceCapabilities.windowDisplay, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_window',
      details: 'available',
      changes: 'available',
    })
    const window = await open(denied, 'Display platform denied')
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
  record('denied', {
    snapshot: 'permission_denied',
    onDisplayChange: 'permission_denied',
  })
}

const app = await createApplication({
  executable,
  permissions: { windowDisplay: 'allow' },
})
try {
  assert.deepEqual(app.capabilities.includes('display_details_v1'), true)
  assert.deepEqual(app.capabilities.includes('display_changes_v1'), true)

  // 2. Snapshot = the window's OS display: bounds, work area, scale and identity.
  const first = await open(app, 'Display platform first')
  const second = await open(app, 'Display platform second')
  const { initial, display } = await snapshotWithinSettledOs(first, second)
  record('snapshot', { snapshot: initial, osDisplay: display })
  if (platform === 'darwin')
    assert(
      initial.visibleBounds!.height < initial.bounds.height,
      'the macOS work area excludes the menu bar'
    )

  // 3. A real OS display-mode change reaches every live owned listener with a
  //    snapshot matching the OS again; a removed listener receives nothing later.
  const changes: DisplayChangeEvent[] = []
  const secondChanges: DisplayChangeEvent[] = []
  first.onDisplayChange((event) => {
    changes.push(event)
  })
  const removeSecond = second.onDisplayChange((event) => {
    secondChanges.push(event)
  })
  const matching = (events: DisplayChangeEvent[], displays: ExpectedDisplay[]) =>
    events.find((item) => {
      try {
        assertSnapshot(item.snapshot, displays, 'change')
        return true
      } catch {
        return false
      }
    })
  const listed = await displayModes(display)
  const options = candidates(listed.current, listed.modes).slice(0, 4)
  const failures: string[] = []
  let applied: { mode: unknown; os: ExpectedDisplay; event: DisplayChangeEvent } | undefined
  let modeChanged = false
  let restored = false
  const restore = async () => {
    restored = true
    if (platform === 'darwin') {
      assert(
        listed.currentIndex !== undefined && listed.currentIndex >= 0,
        'the original macOS mode is a listed desktop mode'
      )
      return run([macHelper!, 'set', display.device, String(listed.currentIndex)])
    }
    return run([
      'pwsh',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      windowsOracle!,
      'restore',
      '-Device',
      display.device,
    ])
  }
  try {
    for (const candidate of options) {
      let result: string
      try {
        result = await applyMode(display, candidate)
      } catch (error) {
        failures.push(`${candidate.width}x${candidate.height}: ${String(error)}`)
        continue
      }
      modeChanged = true
      const after = await settledScreens()
      const os = after.find((item) => item.id === display.id)
      assert(os, 'the changed display keeps its identity')
      assert(
        !close(os.bounds.width, display.bounds.width) ||
          !close(os.bounds.height, display.bounds.height),
        'the OS reports a new display size'
      )
      const event = await waitFor(
        'display_change matching the OS',
        10_000,
        () => matching(changes, after),
        // A missing event and a mismatching one need different fixes.
        () =>
          `; before the change the OS reported ${JSON.stringify([display.bounds, display.visibleBounds])}; ` +
          `${changes.length} event(s) arrived, after it the OS reported ` +
          JSON.stringify(
            after.map((item) => [item.id, item.bounds, item.visibleBounds, item.scale])
          ) +
          (changes.length
            ? ', the events report ' + JSON.stringify(changes.map((item) => item.snapshot))
            : '')
      )
      assert(Object.isFrozen(event) && event.type === 'display_change')
      assert(!event.signal.aborted)
      await waitFor('display_change for the second owned window', 10_000, () =>
        matching(secondChanges, after)
      )
      assertSnapshot(await first.displaySnapshot(), after, 'read after change')
      applied = { mode: JSON.parse(result), os, event }
      break
    }
    if (applied) {
      removeSecond()
      const removedAt = secondChanges.length
      const before = changes.length
      await restore()
      const back = await settledScreens()
      const restoredEvent = await waitFor('display_change back to the original mode', 10_000, () =>
        matching(changes.slice(before), back)
      )
      // Restoring the mode returns the display's identity, size and scale. The
      // work area follows the Dock and menu bar, which macOS may relayout by a
      // few points across a mode cycle, so it is checked against the OS at
      // restore time (above, through the restored event) rather than the start.
      const original = owning(initial, back)
      assert.equal(initial.scaleFactor, original.scale, 'restored scale')
      assertRect(initial.bounds, original.bounds, 'restored bounds')
      await Bun.sleep(250)
      assert.equal(secondChanges.length, removedAt, 'a removed listener receives no later change')
      record('displayChange', {
        operation:
          platform === 'darwin'
            ? 'CGConfigureDisplayWithDisplayMode (kCGConfigureForSession), then the original mode'
            : 'ChangeDisplaySettingsExW (dynamic), then the registry mode',
        candidates: options.length,
        applied: applied.mode,
        changedSnapshot: applied.event.snapshot,
        osAfterChange: applied.os,
        restoredSnapshot: restoredEvent.snapshot,
        eventsDelivered: changes.length,
        removedListenerEventsBeforeRemoval: removedAt,
      })
    } else {
      unavailable['displayChange'] =
        options.length === 0
          ? 'the OS reports no other usable desktop mode for the hosted display'
          : 'the OS refused every alternative display mode: ' + failures.join(' | ')
      record('displayChange', {
        unavailable: unavailable['displayChange'],
        modes: listed,
      })
    }
  } finally {
    // Never leave the runner's session in a changed mode, even after a failed assertion.
    if (modeChanged && !restored) await restore().catch(() => {})
  }

  // 4. Revocation: close and shutdown end every owned listener.
  const closing = await open(app, 'Display platform close')
  let closingSignal: AbortSignal | undefined
  closing.onDisplayChange((event) => {
    closingSignal = event.signal
  })
  const callbacks = app.diagnostics.callbacks
  await closing.close()
  assert.equal(app.diagnostics.callbacks, callbacks - 1, 'close releases its display listener')
  assert.equal(closingSignal, undefined)
  assert.throws(
    () => closing.onDisplayChange(() => {}),
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  record('revocation', {
    windowClose: 'listener released; onDisplayChange invalid_handle',
  })
} finally {
  await stopped(app)
}
record('shutdown', { ownership: app.diagnostics })

writeFileSync(
  join(output, 'display-platform.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform,
      backend,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      oracle:
        platform === 'darwin'
          ? 'tests/native/macos-display-oracle.m (NSScreen, CGDisplayBounds, CGDisplayCreateUUIDFromDisplayID, CGConfigureDisplayWithDisplayMode) + osascript JXA NSScreen + system_profiler'
          : 'tests/native/windows-display-oracle.ps1 (System.Windows.Forms.Screen, GetDpiForMonitor, ChangeDisplaySettingsExW)',
      outcomes,
      unavailable,
      raw,
    },
    null,
    2
  ) + '\n'
)
console.log(
  `Display platform qualification passed on ${backend}: ${Object.keys(outcomes).length} outcomes, ${Object.keys(unavailable).length} unavailable`
)
