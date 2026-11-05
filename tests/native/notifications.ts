/**
 * Real freedesktop notification qualification: an isolated Xvfb + openbox
 * session with its own D-Bus session bus and the dunst notification server.
 * Activation and dismissal come from the server itself (dunstctl), never from
 * the test or the host; an independent bus client proves forged signals are
 * ignored and a bus without a notification server reports unavailability.
 */
import {
  createApplication,
  NativeServiceError,
  type NativeApplication,
  type NotificationEvent,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_NOTIFICATION_EVIDENCE']
const executable = process.env['BUN_NATIVE_HOST']
const mode = process.env['BUN_NATIVE_NOTIFICATION_MODE']
if (
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !executable ||
  !isAbsolute(executable) ||
  (mode !== 'development' && mode !== 'aot') ||
  !process.env['DISPLAY'] ||
  !process.env['DBUS_SESSION_BUS_ADDRESS'] ||
  process.env['WAYLAND_DISPLAY']
)
  throw new Error(
    'An isolated X11 display and D-Bus session, evidence directory, host and mode are required'
  )
const host = executable

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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 3_000
) {
  const until = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(10)
  }
}

/** No delivery within a bounded quiet window after a real server action. */
async function quiet(count: () => number, expected: number) {
  await Bun.sleep(300)
  assert.equal(count(), expected)
}

const displayed = async () => Number(await run(['dunstctl', 'count', 'displayed']))

/** The real notification server, owned by this test for its whole run. */
async function startServer() {
  const server = Bun.spawn(['dunst'], { stdout: 'ignore', stderr: 'pipe' })
  await waitFor(async () => {
    const owner = Bun.spawn(
      [
        'dbus-send',
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        'string:org.freedesktop.Notifications',
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    return (await new Response(owner.stdout).text()).includes('boolean true')
  }, 'the notification server')
  return server
}

/** A session bus with no notification server and no service activation. */
async function emptyBus() {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-empty-bus-'))
  const config = join(directory, 'bus.conf')
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${directory}</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`
  )
  const daemon = Bun.spawn(
    ['dbus-daemon', '--config-file=' + config, '--nofork', '--print-address=1'],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const reader = daemon.stdout.getReader()
  let address = ''
  while (!address.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) throw new Error('isolated bus exited before reporting its address')
    address += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return {
    address: address.trim(),
    async stop() {
      daemon.kill()
      await daemon.exited
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function deniedByDefault() {
  const app = await createApplication({ executable: host })
  try {
    assert.deepEqual(app.serviceCapabilities.notifications, {
      availability: 'available',
      permission: 'deny',
      scope: 'owned_window',
      backend: 'freedesktop',
    })
    const window = await app.openWindow({ title: 'Notification denial' })
    await assert.rejects(
      window.postNotification({ title: 'Denied' }, () => {}),
      (error: unknown) =>
        error instanceof NativeServiceError &&
        error.service === 'notifications' &&
        error.code === 'permission_denied'
    )
    assert.equal(await displayed(), 0)
    record('nativeDefaultDenial', { code: 'permission_denied', displayed: 0 })
  } finally {
    await app.shutdown()
    await app.closed
  }
}

async function noServer() {
  const bus = await emptyBus()
  try {
    // The same host binary, launched on the isolated bus through env(1).
    const app = await createApplication({
      executable: '/usr/bin/env',
      args: ['DBUS_SESSION_BUS_ADDRESS=' + bus.address, host],
      permissions: { notifications: 'allow' },
    })
    try {
      const window = await app.openWindow({ title: 'No notification server' })
      await assert.rejects(
        window.postNotification({ title: 'Nobody listens' }, () => {}),
        (error: unknown) =>
          error instanceof NativeServiceError &&
          error.service === 'notifications' &&
          error.code === 'service_unavailable'
      )
    } finally {
      await app.shutdown()
      await app.closed
    }
    record('noServerUnavailable', { code: 'service_unavailable' })
  } finally {
    await bus.stop()
  }
}

async function qualify(app: NativeApplication) {
  assert.deepEqual(app.serviceCapabilities.notifications, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    backend: 'freedesktop',
  })
  const owner = await app.openWindow({ title: 'Notification owner', width: 360, height: 200 })
  const other = await app.openWindow({ title: 'Other window', width: 360, height: 200 })

  // Posting shows exactly one server notification; the server's own action
  // activates it, then closes it.
  const events: NotificationEvent[] = []
  const first = await owner.postNotification(
    { title: 'Build finished', body: 'Plain <b>text</b> & one\nsecond line' },
    (event) => {
      events.push(event)
    }
  )
  assert.equal(first.activatable, true)
  assert.equal(await displayed(), 1)
  record('posted', { activatable: first.activatable, displayed: 1 })
  await run(['dunstctl', 'action', '0'])
  await waitFor(() => events.length === 1, 'activation')
  assert.equal(events[0]!.type, 'notification_activated')
  assert.equal(events[0]!.notification, first)
  assert.equal(events[0]!.signal.aborted, false)
  // dunst closes an activated notification on its own schedule (seconds).
  await waitFor(() => events.length === 2, 'the server close after activation', 10_000)
  assert.equal(events[1]!.type, 'notification_dismissed')
  const closedBy = events[1]!.type === 'notification_dismissed' ? events[1]!.reason : undefined
  assert.equal(first.active, false)
  assert.equal(events[0]!.signal.aborted, true)
  assert.equal(await displayed(), 0)
  record('activatedByServerAction', { events: events.map((event) => event.type), closedBy })

  // A user dismissal through the server is the final delivery.
  const dismissedEvents: NotificationEvent[] = []
  const second = await owner.postNotification({ title: 'Dismiss me' }, (event) => {
    dismissedEvents.push(event)
  })
  await run(['dunstctl', 'close'])
  await waitFor(() => dismissedEvents.length === 1, 'user dismissal')
  assert.deepEqual(
    dismissedEvents.map((event) => (event.type === 'notification_dismissed' ? event.reason : '')),
    ['dismissed']
  )
  assert.equal(second.active, false)
  record('userDismissal', { reason: 'dismissed' })

  // Forged signals from an independent bus client never reach the owner.
  let forged = 0
  const target = await owner.postNotification({ title: 'Forgery target' }, () => {
    forged += 1
  })
  for (let id = 1; id <= 16; id += 1) {
    await run([
      'dbus-send',
      '--session',
      '--type=signal',
      '/org/freedesktop/Notifications',
      'org.freedesktop.Notifications.ActionInvoked',
      'uint32:' + id,
      'string:default',
    ])
    await run([
      'dbus-send',
      '--session',
      '--type=signal',
      '/org/freedesktop/Notifications',
      'org.freedesktop.Notifications.NotificationClosed',
      'uint32:' + id,
      'uint32:2',
    ])
  }
  await quiet(() => forged, 0)
  assert.equal(target.active, true)
  record('forgedSignalsIgnored', { forgedIds: 16, deliveries: forged })

  // Withdrawal closes it on the server and stops delivery.
  await target.withdraw()
  assert.equal(target.active, false)
  assert.equal(await displayed(), 0)
  record('withdrawalClosed', { displayed: 0, deliveries: forged })

  // Owner close withdraws its notifications without an application request.
  let closedDeliveries = 0
  const owned = await owner.postNotification({ title: 'Owned by a closing window' }, () => {
    closedDeliveries += 1
  })
  assert.equal(await displayed(), 1)
  await owner.close()
  assert.equal(owned.active, false)
  await waitFor(async () => (await displayed()) === 0, 'owner-close withdrawal')
  await quiet(() => closedDeliveries, 0)
  record('ownerCloseWithdrew', { displayed: 0, deliveries: closedDeliveries })

  // Shutdown withdraws the remaining notification.
  const remaining = await other.postNotification({ title: 'Withdrawn at shutdown' }, () => {})
  assert.equal(await displayed(), 1)
  return remaining
}

const server = await startServer()
try {
  await deniedByDefault()
  await noServer()
  const app = await createApplication({ executable: host, permissions: { notifications: 'allow' } })
  let remaining: Awaited<ReturnType<typeof qualify>> | undefined
  try {
    remaining = await qualify(app)
  } finally {
    await app.shutdown()
    await app.closed
  }
  assert.equal(remaining.active, false)
  assert.equal(await displayed(), 0)
  record('shutdownWithdrew', { displayed: 0 })
  assert.deepEqual(Object.values(app.diagnostics), [0, 0, 0, 0, 0, 0, 0])
  record('ownershipReleased', app.diagnostics)
} finally {
  server.kill()
  await server.exited
}

writeFileSync(
  join(output, 'notifications.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      mode,
      bun: process.versions.bun,
      revision: Bun.revision,
      display: 'isolated Xvfb with openbox',
      bus: 'isolated D-Bus session bus',
      server: 'dunst ' + (await run(['dunst', '-v'])).split('\n')[0],
      input: 'notification server actions via dunstctl',
      outcomes,
    },
    null,
    2
  ) + '\n'
)
console.log('Notification qualification passed: ' + Object.keys(outcomes).length + ' outcomes')
