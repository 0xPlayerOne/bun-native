/**
 * Real macOS global shortcut qualification against the native host. The
 * independent oracle (macos-hot-key-oracle.m) never links GPUI: it asks the
 * Carbon Event Manager whether a combination is held exclusively by another
 * process, holds combinations itself, and posts real key combinations through
 * CGEventPost(kCGHIDEventTap) while it, not the host, is the frontmost
 * application. It becomes frontmost through a real click on a window of its
 * own: since macOS 14 activation is cooperative, and an inactive process
 * cannot activate another application, such as Finder, while the host is active.
 *
 * The oracle names keys by virtual key code. The codes below are the ANSI
 * positions of k, j, l and m, which is what the host resolves those names to
 * under the hosted runner's U.S. keyboard layout; another layout would make
 * this fixture, not the host, wrong.
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
const host = process.env['BUN_NATIVE_HOST']
const oracle = process.env['BUN_NATIVE_HOT_KEY_ORACLE']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !host ||
  !isAbsolute(host) ||
  !oracle ||
  !isAbsolute(oracle)
)
  throw new Error('macOS global shortcuts need macOS, an evidence directory, a host and an oracle')

const CODE = { k: 40, j: 38, l: 37, m: 46 } as const
const MODIFIERS = 'control,option,shift'
const COMBINATION = { control: true, alt: true, shift: true } as const
const EXISTS = -9878

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

/** The host is this process's direct child. */
async function hostPid(): Promise<number> {
  const children = (await run(['pgrep', '-P', String(process.pid)])).split('\n').filter(Boolean)
  for (const child of children) {
    const command = await run(['ps', '-o', 'comm=', '-p', child])
    if (command === host || command.endsWith('/bun-native-host')) return Number(child)
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

/** The Event Manager's answer for an exclusive registration by another process. */
async function probe(key: keyof typeof CODE): Promise<number> {
  const result = JSON.parse(await run([oracle!, 'probe', String(CODE[key]), MODIFIERS])) as {
    status: number
  }
  return result.status
}

async function press(key: keyof typeof CODE): Promise<unknown> {
  const hostProcess = await hostPid()
  const result = JSON.parse(
    await run([oracle!, 'press', String(CODE[key]), MODIFIERS, String(hostProcess)])
  ) as { frontmostPid: number; oraclePid: number }
  assert.equal(result.frontmostPid, result.oraclePid, 'the oracle is frontmost while typing')
  assert.notEqual(result.frontmostPid, hostProcess)
  return result
}

/** An independent exclusive holder of a combination until `release`. */
async function hold(key: keyof typeof CODE) {
  const child = Bun.spawn([oracle!, 'hold', String(CODE[key]), MODIFIERS], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  let text = ''
  const deadline = performance.now() + 5_000
  while (!text.includes('\n')) {
    if (performance.now() > deadline) throw new Error('hot key holder did not report')
    const { done, value } = await reader.read()
    if (done) throw new Error('hot key holder exited: ' + (await new Response(child.stderr).text()))
    text += new TextDecoder().decode(value)
  }
  const status = (JSON.parse(text.split('\n')[0]!) as { status: number }).status
  return {
    status,
    async release() {
      void child.stdin.end()
      reader.releaseLock()
      assert.equal(await child.exited, 0)
    },
  }
}

async function waitFor(check: () => boolean, description: string, timeout = 3_000) {
  const until = performance.now() + timeout
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(5)
  }
}

/** No delivery within a bounded quiet window after a real key press. */
async function quiet(count: () => number, expected: number) {
  await Bun.sleep(500)
  assert.equal(count(), expected)
}

const deniedCode = (code: NativeServiceError['code']) => (error: unknown) =>
  error instanceof NativeServiceError && error.service === 'global_shortcuts' && error.code === code

let failure: unknown
let app: NativeApplication | undefined
try {
  assert.equal(JSON.parse(await run([oracle, 'trusted'])).trusted, true, 'event posting access')

  // 1. Without the grant nothing is registered with the OS.
  {
    const denied = await createApplication({ executable: host })
    try {
      assert.deepEqual(denied.serviceCapabilities.globalShortcuts, {
        availability: 'available',
        permission: 'deny',
        scope: 'owned_window',
        backend: 'carbon',
      })
      const window = await denied.openWindow({ title: 'Shortcut denial', width: 320, height: 200 })
      await assert.rejects(
        window.registerGlobalShortcut({ key: 'k', ...COMBINATION }, () => {}),
        deniedCode('permission_denied')
      )
      assert.equal(await probe('k'), 0)
    } finally {
      await denied.shutdown()
      await denied.closed
    }
    record('defaultDenial', { independentProbe: 0 })
  }

  app = await createApplication({ executable: host, permissions: { globalShortcuts: 'allow' } })
  assert.deepEqual(app.serviceCapabilities.globalShortcuts, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    backend: 'carbon',
  })
  const owner = await app.openWindow({ title: 'Shortcut owner', width: 320, height: 200 })

  // 2. A registration is held exclusively at the OS and delivered while
  // another application is frontmost.
  const events: GlobalShortcutEvent[] = []
  const k = await owner.registerGlobalShortcut({ key: 'k', ...COMBINATION }, (event) => {
    events.push(event)
  })
  assert.equal(await probe('k'), EXISTS)
  const front = await press('k')
  await waitFor(() => events.length === 1, 'global shortcut delivery')
  assert.equal(events[0]!.shortcut, k)
  record('deliveredWhileOtherAppFrontmost', { front, deliveries: events.length })

  // 3. An in-session duplicate is an explicit conflict.
  await assert.rejects(
    owner.registerGlobalShortcut({ key: 'k', ...COMBINATION }, () => {}),
    deniedCode('conflict')
  )
  record('inSessionDuplicateConflict', true)

  // 4. A combination another process holds is a conflict; once it releases,
  // the same registration succeeds and delivers.
  const holder = await hold('j')
  assert.equal(holder.status, 0)
  await assert.rejects(
    owner.registerGlobalShortcut({ key: 'j', ...COMBINATION }, () => {}),
    deniedCode('conflict')
  )
  await holder.release()
  let jDeliveries = 0
  const j = await owner.registerGlobalShortcut({ key: 'j', ...COMBINATION }, () => {
    jDeliveries += 1
  })
  await press('j')
  await waitFor(() => jDeliveries === 1, 'delivery after the external conflict cleared')
  record('externalConflictMapped', { afterRelease: jDeliveries })

  // 5. Unregistration releases the OS registration and stops delivery.
  await k.unregister()
  assert.equal(k.active, false)
  assert.equal(await probe('k'), 0)
  await press('k')
  await quiet(() => events.length, 1)
  record('unregisterReleases', { independentProbe: 0, deliveries: events.length })

  // 6. Closing the owner releases its registrations.
  const closing = await app.openWindow({ title: 'Shortcut closing', width: 320, height: 200 })
  let lDeliveries = 0
  const l = await closing.registerGlobalShortcut({ key: 'l', ...COMBINATION }, () => {
    lDeliveries += 1
  })
  assert.equal(await probe('l'), EXISTS)
  await closing.close()
  assert.equal(l.active, false)
  assert.equal(await probe('l'), 0)
  await press('l')
  await quiet(() => lDeliveries, 0)
  record('ownerCloseReleases', true)

  // 7. Shutdown releases the rest.
  await owner.registerGlobalShortcut({ key: 'm', ...COMBINATION }, () => {})
  assert.equal(await probe('m'), EXISTS)
  assert.equal(j.active, true)
  await app.shutdown()
  await app.closed
  assert.equal(await probe('m'), 0)
  assert.equal(await probe('j'), 0)
  assert(Object.values(app.diagnostics).every((count) => count === 0))
  record('shutdownReleases', true)
} catch (error) {
  failure = error
  throw error
} finally {
  writeFileSync(
    join(output, 'global-shortcuts-macos.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
  if (failure !== undefined) await app?.shutdown().catch(() => {})
}
