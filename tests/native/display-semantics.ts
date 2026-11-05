/**
 * Real X11 display-snapshot semantics in an isolated two-screen Xvfb + openbox
 * session. Every expected geometry comes from independent X clients (xdpyinfo,
 * xwininfo); window movement and resource changes are real X server operations
 * (xdotool, xrdb). The fixture qualifies only what the pinned GPUI X11 backend
 * exposes and records the semantics it does not provide.
 */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type NativeApplication,
  type NativeDisplaySnapshot,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_DISPLAY_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_DISPLAY_MODE']
const display = process.env['DISPLAY']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !display ||
  !/^:\d+$/.test(display) ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated local X11 display (":N"), evidence directory, host and mode are required'
  )
const host = executable
const displayName = display

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

async function run(command: string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

/** Independent per-screen geometry from the X server itself. */
async function xScreens(): Promise<{ width: number; height: number }[]> {
  const text = await run(['xdpyinfo', '-display', displayName])
  const count = Number(/number of screens:\s+(\d+)/.exec(text)?.[1])
  const screens = [...text.matchAll(/screen #(\d+):\s+dimensions:\s+(\d+)x(\d+) pixels/g)].map(
    (match) => ({ index: Number(match[1]), width: Number(match[2]), height: Number(match[3]) })
  )
  assert.equal(screens.length, count)
  screens.forEach((screen, index) => assert.equal(screen.index, index))
  for (const [index, screen] of screens.entries()) {
    const root = await run(['xwininfo', '-root', '-display', `${displayName}.${index}`])
    assert.equal(Number(/Width:\s+(\d+)/.exec(root)?.[1]), screen.width)
    assert.equal(Number(/Height:\s+(\d+)/.exec(root)?.[1]), screen.height)
  }
  return screens.map(({ width, height }) => ({ width, height }))
}

/** The outer X geometry of the single mapped top-level window with this exact title. */
async function xWindow(title: string, screen = 0) {
  const target = `${displayName}.${screen}`
  const ids = (
    await run(
      ['xdotool', 'search', '--screen', String(screen), '--sync', '--name', `^${title}$`],
      undefined
    )
  ).split('\n')
  assert.equal(ids.length, 1, `exactly one X window named ${title}`)
  const info = await run(['xwininfo', '-display', target, '-id', ids[0]!])
  const read = (label: string) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)?.[1])
  return {
    id: ids[0]!,
    x: read('Absolute upper-left X'),
    y: read('Absolute upper-left Y'),
    width: read('Width'),
    height: read('Height'),
  }
}

function expected(screen: { width: number; height: number }, scale: number) {
  return { x: 0, y: 0, width: screen.width / scale, height: screen.height / scale, scale }
}

/** Snapshot bounds are f32 logical pixels; compare with an f32 tolerance. */
function assertSnapshot(
  snapshot: NativeDisplaySnapshot,
  want: ReturnType<typeof expected>,
  context: string
) {
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.bounds), `${context}: frozen`)
  assert.deepEqual(Object.keys(snapshot).sort(), ['bounds', 'scaleFactor'], context)
  assert.equal(snapshot.scaleFactor, want.scale, `${context}: scale`)
  for (const key of ['x', 'y', 'width', 'height'] as const)
    assert(
      Math.abs(snapshot.bounds[key] - want[key]) <= 1e-3,
      `${context}: ${key} ${snapshot.bounds[key]} != ${want[key]}`
    )
}

/**
 * GPUI reads DISPLAY, GPUI_X11_SCALE_FACTOR and the X resource database once,
 * when the host connects. Each scenario launches the same prebuilt host through
 * an `exec` wrapper that fixes only that environment; the process the runtime
 * owns is still the native host itself.
 */
let wrappers = 0
async function launch(environment: Record<string, string>): Promise<NativeApplication> {
  const wrapper = join(output!, `host-environment-${++wrappers}.sh`)
  const exports = Object.entries(environment)
    .map(([key, value]) => {
      assert.match(key, /^[A-Z0-9_]+$/)
      assert.match(value, /^[A-Za-z0-9:._-]*$/)
      return `export ${key}='${value}'\n`
    })
    .join('')
  writeFileSync(wrapper, `#!/bin/sh\n${exports}exec '${host}' "$@"\n`, { mode: 0o755 })
  return createApplication({ executable: wrapper, permissions: { windowDisplay: 'allow' } })
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not complete in ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stopped(app: NativeApplication) {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}

async function open(app: NativeApplication, title: string, width = 480, height = 320) {
  const window = await app.openWindow({ title, width, height })
  // Paint once so the X window is mapped before the X oracle searches for it.
  await window.batch((batch) =>
    batch.append(window.root, batch.create({ kind: 'text', text: title }))
  )
  return window
}

const settingsQuery = () => run(['xrdb', '-display', displayName, '-query'])
async function setXftDpi(dpi: number | undefined) {
  if (dpi === undefined) await run(['xrdb', '-display', displayName, '-remove'])
  else await run(['xrdb', '-display', displayName, '-merge'], `Xft.dpi: ${dpi}\n`)
  const settings = await settingsQuery()
  if (dpi === undefined) assert(!settings.includes('Xft.dpi'))
  else assert.match(settings, new RegExp(`^Xft\\.dpi:\\s+${dpi}$`, 'm'))
}

const screens = await xScreens()
assert.equal(screens.length, 2, 'the session must provide two independent X screens')
assert.notDeepEqual(screens[0], screens[1], 'the two X screens must differ in size')
assert.doesNotMatch(await settingsQuery(), /Xft\.dpi/)
record('independentScreens', { source: 'xdpyinfo + xwininfo -root', screens })

// 1. Snapshot = whole X screen at the forced scale; identical for every window,
//    position and size on that screen. A move/resize is a real X operation.
{
  const app = await launch({ GPUI_X11_SCALE_FACTOR: '1' })
  try {
    const first = await open(app, 'Display semantics first', 480, 320)
    const second = await open(app, 'Display semantics second', 300, 200)
    const want = expected(screens[0]!, 1)
    // X11 advertises neither the work area/identity nor display changes.
    assert.equal(app.serviceCapabilities.windowDisplay.details, 'unavailable')
    assert.equal(app.serviceCapabilities.windowDisplay.changes, 'unavailable')
    assert(!app.capabilities.some((value) => value.startsWith('display_')))
    assert.throws(
      () => first.onDisplayChange(() => {}),
      (error: unknown) =>
        error instanceof NativeServiceError && error.code === 'service_unavailable'
    )
    assertSnapshot(await first.displaySnapshot(), want, 'first window')
    assertSnapshot(await second.displaySnapshot(), want, 'second window')
    const before = await xWindow('Display semantics first')
    const targetX = Math.max(0, screens[0]!.width - before.width - 16)
    const targetY = Math.max(0, screens[0]!.height - before.height - 16)
    await run(['xdotool', 'windowmove', '--sync', before.id, String(targetX), String(targetY)])
    await run(['xdotool', 'windowsize', '--sync', before.id, '360', '240'])
    let after = await xWindow('Display semantics first')
    for (
      let attempt = 0;
      attempt < 50 && (after.width !== 360 || after.x === before.x);
      attempt++
    ) {
      await Bun.sleep(20)
      after = await xWindow('Display semantics first')
    }
    assert.notEqual(after.x, before.x, 'the X server moved the window')
    assert.equal(after.width, 360, 'the X server resized the window')
    assertSnapshot(await first.displaySnapshot(), want, 'moved and resized window')
    record('wholeScreenSnapshot', {
      scale: 1,
      windows: 2,
      xWindowBefore: before,
      xWindowAfter: after,
      snapshotUnchangedByMoveResize: true,
    })
  } finally {
    await stopped(app)
  }
}

// 2. Logical bounds are X screen pixels divided by the process-wide scale.
{
  const app = await launch({ GPUI_X11_SCALE_FACTOR: '2' })
  try {
    const window = await open(app, 'Display semantics scaled')
    const snapshot = await window.displaySnapshot()
    assertSnapshot(snapshot, expected(screens[0]!, 2), 'forced scale 2')
    record('forcedScaleTwo', snapshot)
  } finally {
    await stopped(app)
  }
}

// 3. Xft.dpi chooses the scale when the override is unset. A running host
//    keeps its connection-time scale: neither an existing nor a newly opened
//    window observes a later resource change; only a new host does.
try {
  await setXftDpi(144)
  const app = await launch({ GPUI_X11_SCALE_FACTOR: '' })
  let laterHost: NativeDisplaySnapshot | undefined
  try {
    const existing = await open(app, 'Display semantics dpi')
    const initial = await existing.displaySnapshot()
    assertSnapshot(initial, expected(screens[0]!, 1.5), 'Xft.dpi 144')
    await setXftDpi(192)
    assertSnapshot(await existing.displaySnapshot(), expected(screens[0]!, 1.5), 'existing window')
    const reopened = await open(app, 'Display semantics dpi later')
    assertSnapshot(await reopened.displaySnapshot(), expected(screens[0]!, 1.5), 'new window')
    const later = await launch({ GPUI_X11_SCALE_FACTOR: '' })
    try {
      laterHost = await (await open(later, 'Display semantics dpi new host')).displaySnapshot()
      assertSnapshot(laterHost, expected(screens[0]!, 2), 'new host at Xft.dpi 192')
    } finally {
      await stopped(later)
    }
    record('xftDpiConnectionTime', {
      initial,
      afterRuntimeChange: 'unchanged for existing and new windows in the running host',
      newHost: laterHost,
    })
  } finally {
    await stopped(app)
  }
} finally {
  await setXftDpi(undefined)
}

// 4. The snapshot follows the X screen the host connected to, not screen 0.
{
  const app = await launch({ GPUI_X11_SCALE_FACTOR: '1', DISPLAY: `${displayName}.1` })
  try {
    const window = await open(app, 'Display semantics second screen')
    const placed = await xWindow('Display semantics second screen', 1)
    const snapshot = await window.displaySnapshot()
    assertSnapshot(snapshot, expected(screens[1]!, 1), 'second X screen')
    record('secondScreen', { snapshot, xWindow: placed })
  } finally {
    await stopped(app)
  }
}

// 5. Revocation: denial, window close, OS close and shutdown end the capability.
{
  const denied = await createApplication({ executable: host })
  try {
    const window = await open(denied, 'Display semantics denied')
    await assert.rejects(
      window.displaySnapshot(),
      (error: unknown) => error instanceof NativeServiceError && error.code === 'permission_denied'
    )
  } finally {
    await stopped(denied)
  }
  const app = await launch({ GPUI_X11_SCALE_FACTOR: '1' })
  let survivor: NativeWindow
  try {
    const closing = await open(app, 'Display semantics close')
    await closing.displaySnapshot()
    await closing.close()
    await assert.rejects(
      closing.displaySnapshot(),
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    const osClosing = await open(app, 'Display semantics os close')
    await osClosing.displaySnapshot()
    const { id } = await xWindow('Display semantics os close')
    // The window manager's close action sends WM_DELETE_WINDOW, as a user would.
    await run(['xdotool', 'windowactivate', '--sync', id])
    await run(['xdotool', 'key', '--clearmodifiers', 'alt+F4'])
    await within(osClosing.closed, 5_000, 'OS close')
    await assert.rejects(
      osClosing.displaySnapshot(),
      (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
    )
    survivor = await open(app, 'Display semantics shutdown')
    await survivor.displaySnapshot()
  } finally {
    await stopped(app)
  }
  await assert.rejects(
    survivor.displaySnapshot(),
    (error: unknown) => error instanceof NativeStateError
  )
  record('revocation', {
    denied: 'permission_denied',
    windowClose: 'invalid_handle',
    osClose: 'invalid_handle after WM_DELETE_WINDOW (openbox alt+F4)',
    shutdown: 'NativeStateError',
    ownership: app.diagnostics,
  })
}

writeFileSync(
  join(output, 'display-semantics.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated two-screen Xvfb with openbox',
      operations: 'xdotool windowmove/windowsize, openbox alt+F4 close, xrdb -merge/-remove',
      outcomes,
      unavailable: {
        displayChangeEvents:
          'pinned GPUI X11 window on_display_changed is a no-op; displays_changed fires only on backend reconnection',
        runtimeGeometryChange:
          'GPUI caches X screen size from the connection setup; Xvfb RandR exposes one fixed mode',
        workArea: 'X11 PlatformDisplay has no visible_bounds override; it equals bounds',
        monitorIdentity: 'X11 display id is the X screen index and its UUID is all zeros',
        mixedDpi: 'one process-wide X11 scale factor; per-monitor scale is not exposed',
        hotplug: 'Xvfb has no physical outputs to connect or disconnect',
      },
    },
    null,
    2
  ) + '\n'
)
console.log('Display semantics qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
