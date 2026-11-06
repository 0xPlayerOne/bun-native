import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type GlobalShortcutEvent,
  type GlobalShortcutOptions,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { peerRequests, settle, withServicePeer } from './service-peer.ts'

const ALLOW: ServicePermissions = { globalShortcuts: 'allow' }
const COMBINATION: GlobalShortcutOptions = { key: 'k', control: true, alt: true }

const withShortcuts = (
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = ALLOW
) => withServicePeer('shortcut-peer', run, mode, permissions)

describe('owned global shortcuts (headless real subprocess)', () => {
  test('reports the implemented backend and the immutable launch grant', async () => {
    for (const [permissions, permission] of [
      [ALLOW, 'allow'],
      [{}, 'deny'],
    ] as const)
      await withShortcuts(
        async (app) => {
          expect(app.serviceCapabilities.globalShortcuts).toEqual({
            availability: 'available',
            permission,
            scope: 'owned_window',
            backend: 'x11',
          })
          expect(Object.isFrozen(app.serviceCapabilities.globalShortcuts)).toBe(true)
        },
        'normal',
        permissions
      )
    await withShortcuts(async (app) => {
      expect(app.serviceCapabilities.globalShortcuts).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const window = await app.openWindow({ title: 'Unavailable shortcuts' })
      await assert.rejects(
        window.registerGlobalShortcut(COMBINATION, () => {}),
        {
          name: 'NativeServiceError',
          service: 'global_shortcuts',
          code: 'service_unavailable',
        }
      )
    }, 'unavailable')
  })

  test('delivers an owned activation and stops delivery on unregistration', async () => {
    await withShortcuts(async (app, directory) => {
      const window = await app.openWindow({ title: 'Shortcut owner' })
      const events: GlobalShortcutEvent[] = []
      const shortcut = await window.registerGlobalShortcut(COMBINATION, (event) => {
        events.push(event)
      })
      expect(shortcut.key).toBe('k')
      expect(shortcut.modifiers).toEqual({
        control: true,
        alt: true,
        shift: false,
        platform: false,
      })
      expect(Object.isFrozen(shortcut)).toBe(true)
      expect(Object.isFrozen(shortcut.modifiers)).toBe(true)
      expect(shortcut.active).toBe(true)
      await settle(app)
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('global_shortcut')
      expect(events[0]!.shortcut).toBe(shortcut)
      expect(events[0]!.signal.aborted).toBe(false)
      const [registration] = peerRequests(directory, 'register_global_shortcut')
      expect(registration).toMatchObject({
        window_id: 1,
        shortcut_id: 1,
        key: 'k',
        modifiers: { control: true, alt: true, shift: false, platform: false },
      })
      const released = shortcut.unregister()
      // Revocation is synchronous; the OS release completes asynchronously.
      expect(shortcut.active).toBe(false)
      expect(events[0]!.signal.aborted).toBe(true)
      expect(shortcut.unregister()).toBe(released)
      await released
      await settle(app)
      // The peer published a press after release; it was never delivered.
      expect(events).toHaveLength(1)
      expect(peerRequests(directory, 'unregister_global_shortcut')).toHaveLength(1)
      await window.close()
    }, 'late')
  })

  test('owner close revokes delivery without a separate native release', async () => {
    await withShortcuts(async (app, directory) => {
      const window = await app.openWindow({ title: 'Closing owner' })
      let delivered = 0
      const shortcut = await window.registerGlobalShortcut(
        { key: 'f12', platform: true, shift: true },
        () => {
          delivered += 1
        }
      )
      await settle(app)
      expect(delivered).toBe(1)
      await window.close()
      expect(shortcut.active).toBe(false)
      await shortcut.unregister()
      await settle(app)
      expect(delivered).toBe(1)
      expect(peerRequests(directory, 'unregister_global_shortcut')).toHaveLength(0)
      await assert.rejects(
        window.registerGlobalShortcut(COMBINATION, () => {}),
        {
          name: 'NativeStateError',
          code: 'invalid_handle',
        }
      )
    }, 'late')
  })

  test('maps denial and OS conflicts to typed service errors', async () => {
    await withShortcuts(
      async (app) => {
        const window = await app.openWindow({ title: 'Denied' })
        await assert.rejects(
          window.registerGlobalShortcut(COMBINATION, () => {}),
          {
            name: 'NativeServiceError',
            service: 'global_shortcuts',
            code: 'permission_denied',
          }
        )
      },
      'normal',
      {}
    )
    await withShortcuts(async (app) => {
      const window = await app.openWindow({ title: 'Conflict' })
      const error = await window.registerGlobalShortcut(COMBINATION, () => {}).catch((e) => e)
      expect(error).toBeInstanceOf(NativeServiceError)
      expect(error).toMatchObject({ service: 'global_shortcuts', code: 'conflict' })
    }, 'conflict')
  })

  test('rejects unsupported combinations locally, without a native request', async () => {
    await withShortcuts(async (app, directory) => {
      const window = await app.openWindow({ title: 'Validation' })
      const invalid: unknown[] = [
        { key: 'k' },
        { key: 'k', shift: true },
        { key: 'K', control: true },
        { key: 'space', control: true },
        { key: 'f13', control: true },
        { key: 'k', control: 'yes' },
        { key: 'k', control: true, hyper: true },
        ['k', 'control'],
        null,
      ]
      for (const options of invalid)
        await assert.rejects(
          window.registerGlobalShortcut(options as GlobalShortcutOptions, () => {}),
          TypeError
        )
      await assert.rejects(
        window.registerGlobalShortcut(COMBINATION, 'listener' as unknown as () => void),
        TypeError
      )
      expect(peerRequests(directory, 'register_global_shortcut')).toHaveLength(0)
    })
  })

  test('a press naming an unallocated registration fails the application', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-shortcut-peer-'))
    try {
      const app = await createApplication({
        executable: process.execPath,
        args: [resolve(import.meta.dir, 'shortcut-peer.ts'), directory, 'foreign'],
        permissions: ALLOW,
        requestTimeoutMs: 2_000,
      })
      const window = await app.openWindow({ title: 'Foreign press' })
      await window.registerGlobalShortcut(COMBINATION, () => {}).catch(() => {})
      await assert.rejects(app.closed, ProtocolError)
      await app.shutdown().catch(() => {})
      expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('shutdown revokes live registrations', async () => {
    await withShortcuts(async (app) => {
      const window = await app.openWindow({ title: 'Shutdown' })
      const shortcut = await window.registerGlobalShortcut(COMBINATION, () => {})
      await app.shutdown()
      expect(shortcut.active).toBe(false)
      await shortcut.unregister()
      await assert.rejects(
        window.registerGlobalShortcut(COMBINATION, () => {}),
        NativeStateError
      )
    })
  })
})
