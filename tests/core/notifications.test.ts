import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type NativeApplication,
  type NotificationEvent,
  type NotificationOptions,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { peerRequests, settle, withServicePeer } from './service-peer.ts'

const ALLOW: ServicePermissions = { notifications: 'allow' }
const CONTENT: NotificationOptions = { title: 'Build finished', body: 'All tests passed' }

const withNotifications = (
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = ALLOW
) => withServicePeer('notification-peer', run, mode, permissions)

describe('owned desktop notifications (headless real subprocess)', () => {
  test('reports the implemented backend and the immutable launch grant', async () => {
    for (const [permissions, permission] of [
      [ALLOW, 'allow'],
      [{}, 'deny'],
    ] as const)
      await withNotifications(
        async (app) => {
          expect(app.serviceCapabilities.notifications).toEqual({
            availability: 'available',
            permission,
            scope: 'owned_window',
            backend: process.platform === 'darwin' ? 'user_notifications' : 'freedesktop',
          })
          expect(Object.isFrozen(app.serviceCapabilities.notifications)).toBe(true)
        },
        'normal',
        permissions
      )
    await withNotifications(async (app) => {
      expect(app.serviceCapabilities.notifications).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const window = await app.openWindow({ title: 'Unavailable notifications' })
      await assert.rejects(
        window.postNotification(CONTENT, () => {}),
        {
          name: 'NativeServiceError',
          service: 'notifications',
          code: 'service_unavailable',
        }
      )
    }, 'unavailable')
  })

  test('delivers an owned activation and stops delivery on withdrawal', async () => {
    await withNotifications(async (app, directory) => {
      const window = await app.openWindow({ title: 'Notification owner' })
      const events: NotificationEvent[] = []
      const notification = await window.postNotification(CONTENT, (event) => {
        events.push(event)
      })
      expect(notification.title).toBe(CONTENT.title)
      expect(notification.body).toBe(CONTENT.body!)
      expect(notification.activatable).toBe(true)
      expect(notification.active).toBe(true)
      expect(Object.isFrozen(notification)).toBe(true)
      await settle(app)
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('notification_activated')
      expect(events[0]!.notification).toBe(notification)
      expect(events[0]!.signal.aborted).toBe(false)
      expect(peerRequests(directory, 'post_notification')).toEqual([
        {
          id: expect.any(Number),
          type: 'post_notification',
          window_id: 1,
          notification_id: 1,
          title: CONTENT.title,
          body: CONTENT.body,
        },
      ])
      const withdrawn = notification.withdraw()
      // Revocation is synchronous; the server close completes asynchronously.
      expect(notification.active).toBe(false)
      expect(events[0]!.signal.aborted).toBe(true)
      expect(notification.withdraw()).toBe(withdrawn)
      await withdrawn
      await settle(app)
      // The peer published an activation after withdrawal; it was never delivered.
      expect(events).toHaveLength(1)
      expect(peerRequests(directory, 'withdraw_notification')).toHaveLength(1)
      await window.close()
    }, 'late')
  })

  test('a server dismissal is the final delivery', async () => {
    await withNotifications(async (app, directory) => {
      const window = await app.openWindow({ title: 'Dismissed' })
      const events: NotificationEvent[] = []
      const notification = await window.postNotification({ title: 'Ping' }, (event) => {
        events.push(event)
      })
      expect(notification.body).toBe('')
      await settle(app)
      expect(events.map((event) => event.type)).toEqual([
        'notification_activated',
        'notification_dismissed',
      ])
      expect(events[1]).toMatchObject({ reason: 'dismissed', notification })
      expect(notification.active).toBe(false)
      expect(events[1]!.signal.aborted).toBe(true)
      await notification.withdraw()
      expect(peerRequests(directory, 'withdraw_notification')).toHaveLength(0)
    }, 'dismiss')
  })

  test('reports a server without actions as not activatable', async () => {
    await withNotifications(async (app) => {
      const window = await app.openWindow({ title: 'No actions' })
      const notification = await window.postNotification(CONTENT, () => {})
      expect(notification.activatable).toBe(false)
      await notification.withdraw()
    }, 'no-actions')
  })

  test('owner close revokes delivery without a separate withdrawal', async () => {
    await withNotifications(async (app, directory) => {
      const window = await app.openWindow({ title: 'Closing owner' })
      let delivered = 0
      const notification = await window.postNotification(CONTENT, () => {
        delivered += 1
      })
      await settle(app)
      expect(delivered).toBe(1)
      await window.close()
      expect(notification.active).toBe(false)
      await notification.withdraw()
      await settle(app)
      expect(delivered).toBe(1)
      expect(peerRequests(directory, 'withdraw_notification')).toHaveLength(0)
      await assert.rejects(
        window.postNotification(CONTENT, () => {}),
        {
          name: 'NativeStateError',
          code: 'invalid_handle',
        }
      )
    }, 'late')
  })

  test('maps denial and a missing server to typed service errors', async () => {
    await withNotifications(
      async (app) => {
        const window = await app.openWindow({ title: 'Denied' })
        await assert.rejects(
          window.postNotification(CONTENT, () => {}),
          {
            name: 'NativeServiceError',
            service: 'notifications',
            code: 'permission_denied',
          }
        )
      },
      'normal',
      {}
    )
    await withNotifications(async (app) => {
      const window = await app.openWindow({ title: 'No server' })
      const error = await window.postNotification(CONTENT, () => {}).catch((e) => e)
      expect(error).toBeInstanceOf(NativeServiceError)
      expect(error).toMatchObject({ service: 'notifications', code: 'service_unavailable' })
    }, 'no-server')
  })

  test('rejects unsupported content locally, without a native request', async () => {
    await withNotifications(async (app, directory) => {
      const window = await app.openWindow({ title: 'Validation' })
      const invalid: unknown[] = [
        {},
        { title: '' },
        { title: 't'.repeat(257) },
        { title: 'é'.repeat(129) },
        { title: 'a\nb' },
        { title: 'a', body: 'x\ty' },
        { title: 'a', body: 'x\r\ny' },
        { title: 'a', body: 'b'.repeat(2_049) },
        { title: 'a', body: 1 },
        { title: '\ud800' },
        { title: 'a', actions: ['open'] },
        { title: 'a', command: 'xdg-open https://example.com' },
        ['a'],
        null,
      ]
      for (const options of invalid)
        await assert.rejects(
          window.postNotification(options as NotificationOptions, () => {}),
          TypeError
        )
      await assert.rejects(
        window.postNotification(CONTENT, 'listener' as unknown as () => void),
        TypeError
      )
      expect(peerRequests(directory, 'post_notification')).toHaveLength(0)
      const multiline = await window.postNotification(
        { title: 'é'.repeat(128), body: 'one\ntwo' },
        () => {}
      )
      expect(multiline.body).toBe('one\ntwo')
      await multiline.withdraw()
    })
  })

  test('an activation naming an unallocated notification fails the application', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-notification-peer-'))
    try {
      const app = await createApplication({
        executable: process.execPath,
        args: [resolve(import.meta.dir, 'notification-peer.ts'), directory, 'foreign'],
        permissions: ALLOW,
        requestTimeoutMs: 2_000,
      })
      const window = await app.openWindow({ title: 'Foreign activation' })
      await window.postNotification(CONTENT, () => {}).catch(() => {})
      await assert.rejects(app.closed, ProtocolError)
      await app.shutdown().catch(() => {})
      expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('shutdown revokes live notifications', async () => {
    await withNotifications(async (app) => {
      const window = await app.openWindow({ title: 'Shutdown' })
      const notification = await window.postNotification(CONTENT, () => {})
      await app.shutdown()
      expect(notification.active).toBe(false)
      await notification.withdraw()
      await assert.rejects(
        window.postNotification(CONTENT, () => {}),
        NativeStateError
      )
    })
  })
})
