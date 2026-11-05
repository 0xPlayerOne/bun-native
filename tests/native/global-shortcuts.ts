/**
 * Real X11 global shortcut qualification in an isolated Xvfb + openbox session.
 * OS input comes from XTEST (xdotool) while a different owned window is
 * focused; an independent X11 client (shortcut-peer) proves real conflicts and
 * real grab release after unregistration, owner close and shutdown.
 */
import {
  createApplication,
  NativeServiceError,
  type GlobalShortcutEvent,
  type NativeApplication,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_SHORTCUT_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const peerExecutable = process.env['BUN_NATIVE_SHORTCUT_PEER']
const mode = process.env['BUN_NATIVE_SHORTCUT_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  !peerExecutable ||
  !isAbsolute(peerExecutable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display, evidence directory, host, shortcut peer and mode are required'
  )
const host = executable
const peerPath = peerExecutable

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}

// X11 core modifier masks and the keysyms for the keys used here.
const CONTROL_ALT = 4 | 8
const KEYSYM = { j: 0x6a, k: 0x6b, m: 0x6d, n: 0x6e } as const

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

/** An independent X client that tries to grab the same combination. */
async function peer(key: keyof typeof KEYSYM) {
  const child = Bun.spawn([peerPath, KEYSYM[key].toString(16), String(CONTROL_ALT)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  let text = ''
  const deadline = performance.now() + 5_000
  while (!text.includes('\n')) {
    if (performance.now() > deadline) throw new Error('shortcut peer did not report')
    const { done, value } = await reader.read()
    if (done) throw new Error('shortcut peer exited: ' + (await new Response(child.stderr).text()))
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return {
    outcome: text.trim() as 'grabbed' | 'conflict',
    async stop() {
      await child.stdin.end()
      assert.equal(await child.exited, 0)
    },
  }
}

async function activate(title: string): Promise<string> {
  const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + title + '$'])).split('\n')
  assert.equal(ids.length, 1, 'expected exactly one owned window named ' + title)
  await run(['xdotool', 'windowactivate', '--sync', ids[0]!])
  const active = await run(['xdotool', 'getactivewindow', 'getwindowname'])
  assert.equal(active, title)
  return active
}

const press = (combination: string) => run(['xdotool', 'key', '--clearmodifiers', combination])
// --clearmodifiers would also clear lock state; this press keeps Num Lock set.
const pressKeepingLocks = (combination: string) => run(['xdotool', 'key', combination])

async function waitFor(check: () => boolean, description: string, timeout = 3_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(5)
  }
}

/** No delivery within a bounded quiet window after a real key press. */
async function quiet(count: () => number, expected: number) {
  await Bun.sleep(300)
  assert.equal(count(), expected)
}

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.globalShortcuts, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_window',
      backend: 'x11',
    })
    const window = await app.openWindow({ title: 'Shortcut denial' })
    await assert.rejects(
      window.registerGlobalShortcut({ key: 'k', control: true, alt: true }, () => {}),
      (error: unknown) =>
        error instanceof NativeServiceError &&
        error.service === 'global_shortcuts' &&
        error.code === 'permission_denied'
    )
    // Denial must not have grabbed anything: an independent client can.
    const independent = await peer('k')
    assert.equal(independent.outcome, 'grabbed')
    await independent.stop()
    record('nativeDefaultDenial', { code: 'permission_denied', independentGrab: 'grabbed' })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

async function qualify(app: NativeApplication) {
  assert.deepEqual(app.serviceCapabilities.globalShortcuts, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    backend: 'x11',
  })
  const owner = await app.openWindow({ title: 'Shortcut owner', width: 360, height: 200 })
  const other = await app.openWindow({ title: 'Focused window', width: 360, height: 200 })
  const events: GlobalShortcutEvent[] = []
  const k = await owner.registerGlobalShortcut({ key: 'k', control: true, alt: true }, (event) => {
    events.push(event)
  })

  // Delivery while a different owned window holds keyboard focus.
  const focused = await activate('Focused window')
  await press('ctrl+alt+k')
  await waitFor(() => events.length === 1, 'global shortcut delivery')
  assert.equal(events[0]!.shortcut, k)
  record('deliveredWhileOtherWindowFocused', { focused, deliveries: events.length })
  // A plain key press without the modifiers is not an activation.
  await press('k')
  await quiet(() => events.length, 1)
  record('unmodifiedKeyIgnored', { deliveries: events.length })

  // The X server refuses a second grab of the held combination to another client.
  const contender = await peer('k')
  assert.equal(contender.outcome, 'conflict')
  await contender.stop()
  record('externalClientRefused', { outcome: contender.outcome })

  // An in-session duplicate is an explicit conflict, not a second handle.
  await assert.rejects(
    owner.registerGlobalShortcut({ key: 'k', control: true, alt: true }, () => {}),
    (error: unknown) => error instanceof NativeServiceError && error.code === 'conflict'
  )
  record('inSessionDuplicateConflict', { code: 'conflict' })

  // A combination held by an independent client fails with conflict and keeps
  // no partial grab: after that client exits the same registration succeeds.
  const holder = await peer('j')
  assert.equal(holder.outcome, 'grabbed')
  await assert.rejects(
    owner.registerGlobalShortcut({ key: 'j', control: true, alt: true }, () => {}),
    (error: unknown) =>
      error instanceof NativeServiceError &&
      error.service === 'global_shortcuts' &&
      error.code === 'conflict'
  )
  await holder.stop()
  let jDeliveries = 0
  const j = await owner.registerGlobalShortcut({ key: 'j', control: true, alt: true }, () => {
    jDeliveries += 1
  })
  await press('ctrl+alt+j')
  await waitFor(() => jDeliveries === 1, 'delivery after the external conflict cleared')
  record('externalConflictMapped', { code: 'conflict', afterRelease: jDeliveries })
  // Lock modifiers do not change the combination.
  await pressKeepingLocks('Num_Lock')
  await pressKeepingLocks('ctrl+alt+j')
  await waitFor(() => jDeliveries === 2, 'delivery with Num Lock set')
  await pressKeepingLocks('Num_Lock')
  record('lockStateIgnored', { deliveries: jDeliveries })

  // Unregistration revokes delivery at once and releases the OS grab.
  await k.unregister()
  assert.equal(k.active, false)
  assert.equal(events[0]!.signal.aborted, true)
  await press('ctrl+alt+k')
  await quiet(() => events.length, 1)
  const afterUnregister = await peer('k')
  assert.equal(afterUnregister.outcome, 'grabbed')
  await afterUnregister.stop()
  await j.unregister()
  record('unregistrationReleased', {
    lateDeliveries: events.length - 1,
    independentGrab: 'grabbed',
  })

  // Owner close revokes delivery and releases the OS grab without unregister().
  let mDeliveries = 0
  const m = await owner.registerGlobalShortcut({ key: 'm', control: true, alt: true }, () => {
    mDeliveries += 1
  })
  await owner.close()
  assert.equal(m.active, false)
  await activate('Focused window')
  await press('ctrl+alt+m')
  await quiet(() => mDeliveries, 0)
  const afterClose = await peer('m')
  assert.equal(afterClose.outcome, 'grabbed')
  await afterClose.stop()
  record('ownerCloseReleased', { deliveries: mDeliveries, independentGrab: 'grabbed' })

  // Shutdown revokes the remaining registration; the X server drops its grab.
  const n = await other.registerGlobalShortcut({ key: 'n', control: true, alt: true }, () => {})
  return n
}

await deniedByDefault()
const app = await createApplication({ executable: host, permissions: { globalShortcuts: 'allow' } })
let remaining: Awaited<ReturnType<typeof qualify>> | undefined
try {
  remaining = await qualify(app)
} finally {
  await app.shutdown()
  await app.closed
}
assert.equal(remaining.active, false)
const afterShutdown = await peer('n')
assert.equal(afterShutdown.outcome, 'grabbed')
await afterShutdown.stop()
record('shutdownReleased', { independentGrab: 'grabbed' })
assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
record('ownershipReleased', app.diagnostics)

writeFileSync(
  join(output, 'global-shortcuts.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      input: 'XTEST via xdotool',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Global shortcut qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
