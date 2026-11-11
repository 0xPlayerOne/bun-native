/**
 * macOS user notification qualification against the native host.
 *
 * `UNUserNotificationCenter` serves only an application bundle, so the
 * workflow runs this fixture with two hosts: the bare release executable,
 * which must not offer the service at all, and the same executable copied
 * into an ad-hoc-signed `.app` bundle, which must.
 *
 * What a hosted runner cannot automate: the first post of a bundle asks the
 * user for permission through an OS prompt that nobody answers here. A
 * bundled post therefore ends in exactly one of three ways, each with its own
 * deterministic checks, and the evidence records which one happened:
 *   - `posted`: alerts were already allowed; the handle is live and withdraws.
 *   - `denied`: alerts are not allowed; the post rejects `permission_denied`
 *     with the OS-denial message, not the launch-policy one.
 *   - `awaiting_authorization`: the prompt is unanswered; closing the owner
 *     rejects the post with `invalid_handle` and nothing is delivered.
 * Delivery to Notification Center, activation and dismissal by a user are not
 * observed: no independent process can read another application's
 * notifications, and nothing answers the prompt.
 */
import { createApplication, NativeServiceError, NativeStateError } from '@bun-native/core'
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const output = process.env['BUN_NATIVE_NOTIFICATION_EVIDENCE']
const bare = process.env['BUN_NATIVE_HOST']
const bundled = process.env['BUN_NATIVE_BUNDLED_HOST']
if (
  process.platform !== 'darwin' ||
  !output ||
  !isAbsolute(output) ||
  !statSync(output).isDirectory() ||
  !bare ||
  !isAbsolute(bare) ||
  !bundled ||
  !isAbsolute(bundled) ||
  !/\.app\/Contents\/MacOS\/[^/]+$/u.test(bundled)
)
  throw new Error(
    'macOS notifications need macOS, an evidence directory, a bare host and a host inside an .app bundle'
  )

const started = performance.now()
const outcomes: Record<string, unknown> = {}
const record = (name: string, value: unknown) => {
  outcomes[name] = value
  console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
}
const serviceError = (code: NativeServiceError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof NativeServiceError &&
  error.service === 'notifications' &&
  error.code === code &&
  (message === undefined || message.test(error.message))
const content = { title: 'Bun Native qualification', body: 'A hosted macOS notification check' }

let failure: unknown
try {
  // 1. A bare executable never touches the framework: no capability, and a
  // granted post is unavailable.
  {
    const app = await createApplication({
      executable: bare,
      permissions: { notifications: 'allow' },
    })
    try {
      assert.deepEqual(app.serviceCapabilities.notifications, {
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const window = await app.openWindow({ title: 'Bare host', width: 320, height: 200 })
      await assert.rejects(
        window.postNotification(content, () => {}),
        serviceError('service_unavailable', /application bundle/u)
      )
    } finally {
      await app.shutdown()
      await app.closed
    }
    record('bareHostUnavailable', true)
  }

  // 2. In a bundle the service is offered, and still denied without the grant.
  {
    const app = await createApplication({ executable: bundled })
    try {
      assert.deepEqual(app.serviceCapabilities.notifications, {
        availability: 'available',
        permission: 'deny',
        scope: 'owned_window',
        backend: 'user_notifications',
      })
      const window = await app.openWindow({ title: 'Bundle denial', width: 320, height: 200 })
      await assert.rejects(
        window.postNotification(content, () => {}),
        serviceError('permission_denied', /launch/u)
      )
    } finally {
      await app.shutdown()
      await app.closed
    }
    record('bundledDefaultDenial', true)
  }

  // 3. A granted post in a bundle ends in one of three ways (see above).
  {
    const app = await createApplication({
      executable: bundled,
      permissions: { notifications: 'allow' },
    })
    try {
      assert.deepEqual(app.serviceCapabilities.notifications, {
        availability: 'available',
        permission: 'allow',
        scope: 'owned_window',
        backend: 'user_notifications',
      })
      const window = await app.openWindow({ title: 'Bundle owner', width: 320, height: 200 })
      const events: unknown[] = []
      const pending = window.postNotification(content, (event) => {
        events.push(event.type)
      })
      const settled = await Promise.race([
        pending.then(
          (notification) => ({ kind: 'posted' as const, notification }),
          (error: unknown) => ({ kind: 'rejected' as const, error })
        ),
        Bun.sleep(8_000).then(() => ({ kind: 'pending' as const })),
      ])
      if (settled.kind === 'posted') {
        assert.equal(settled.notification.activatable, true)
        await settled.notification.withdraw()
        assert.equal(settled.notification.active, false)
        record('authorization', 'posted')
      } else if (settled.kind === 'rejected') {
        assert(
          serviceError('permission_denied', /not allowed/u)(settled.error),
          `unexpected rejection: ${String(settled.error)}`
        )
        record('authorization', 'denied')
      } else {
        const revoked = assert.rejects(
          pending,
          (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
        )
        await window.close()
        await revoked
        record('authorization', 'awaiting_authorization')
      }
      assert.deepEqual(events, [])
    } finally {
      await app.shutdown()
      await app.closed
    }
    assert(Object.values(app.diagnostics).every((count) => count === 0))
    record('bundledShutdownClean', true)
  }
} catch (error) {
  failure = error
  throw error
} finally {
  writeFileSync(
    join(output, 'notifications-macos.json'),
    JSON.stringify({ platform: process.platform, outcomes, failed: failure !== undefined }, null, 2)
  )
}
