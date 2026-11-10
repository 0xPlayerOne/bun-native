import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALLOW: ServicePermissions = { taskDialogs: 'allow' }
const buttons = [
  { id: 'save', label: 'Save', kind: 'primary' },
  { id: 'discard', label: 'Discard', kind: 'destructive' },
  { id: 'cancel', label: 'Cancel' },
] as const
const options = {
  title: 'Unsaved changes',
  message: 'Save the document before closing?',
  buttons,
  cancelButton: 'cancel',
} as const

async function withPeer(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'hold',
  permissions: ServicePermissions = ALLOW
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-message-dialog-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'message-dialog-peer.ts'), directory, mode],
      permissions,
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual([0, 0, 0, 0, 0, 0, 0])
    rmSync(directory, { recursive: true, force: true })
  }
}

function requests(directory: string, type: string) {
  const path = join(directory, 'requests.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((value) => value['type'] === type)
}

async function until(condition: () => boolean) {
  for (let index = 0; index < 100 && !condition(); index += 1) await Bun.sleep(5)
  expect(condition()).toBe(true)
}

describe('OS message dialogs (headless real subprocess)', () => {
  test('the OS backend needs the host capability and the launch grant', async () => {
    await withPeer(async (app) => {
      expect(app.serviceCapabilities.messageDialogs).toEqual({
        availability: 'available',
        scope: 'owned_window',
        // The host's platform names the OS backend.
        backend: process.platform === 'darwin' ? 'alert_sheet' : 'task_dialog',
      })
    })
    await withPeer(
      async (app) => {
        expect(app.serviceCapabilities.messageDialogs).toMatchObject({ backend: 'modal_overlay' })
      },
      'hold',
      {}
    )
    await withPeer(async (app) => {
      expect(app.serviceCapabilities.messageDialogs).toMatchObject({ backend: 'modal_overlay' })
    }, 'overlay-only')
  })

  test('a shown dialog sends only the wire fields and resolves the chosen button', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Native dialog' })
      const result = await window.showMessageDialog({ ...options, detail: 'Edits are lost.' })
      expect(result).toEqual({ kind: 'button', id: 'cancel' })
      expect(Object.isFrozen(result)).toBe(true)
      expect(requests(directory, 'show_message_dialog')[0]).toMatchObject({
        options: {
          title: 'Unsaved changes',
          message: 'Save the document before closing?',
          detail: 'Edits are lost.',
          buttons: [
            { id: 'save', label: 'Save' },
            { id: 'discard', label: 'Discard' },
            { id: 'cancel', label: 'Cancel' },
          ],
          default_button: 'save',
          cancel_button: 'cancel',
        },
      })
      expect(requests(directory, 'close_message_dialog')).toEqual([])
      expect(requests(directory, 'batch')).toEqual([])
    }, 'cancel')
  })

  test('confirm resolves false on cancel, dismissed and last-button results', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Confirm' })
      expect(await window.showConfirmDialog({ title: 'Delete', message: 'Delete it?' })).toBe(false)
    }, 'cancel')
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Confirm' })
      expect(await window.showConfirmDialog({ title: 'Delete', message: 'Delete it?' })).toBe(true)
      expect(
        await window.showMessageDialog({
          title: 'Choose',
          message: 'Pick one.',
          buttons,
          dismissible: true,
        })
      ).toEqual({ kind: 'button', id: 'cancel' })
    }, 'choose-last')
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Dismiss' })
      expect(await window.showMessageDialog({ ...options, dismissible: true })).toEqual({
        kind: 'dismissed',
      })
      expect(requests(directory, 'show_message_dialog')[0]).toMatchObject({
        options: { dismissible: true },
      })
    }, 'dismiss')
  })

  test('host failure, unavailability and denial map to service errors', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Failed' })
      await assert.rejects(window.showMessageDialog(options), {
        name: 'NativeServiceError',
        service: 'message_dialogs',
        code: 'native_failure',
      })
    }, 'failed')
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Unavailable' })
      await assert.rejects(window.showMessageDialog(options), {
        name: 'NativeServiceError',
        code: 'service_unavailable',
      })
      // The next queued dialog is still attempted.
      await assert.rejects(window.showMessageDialog(options), { code: 'service_unavailable' })
    }, 'unavailable')
  })

  test('invalid options are rejected before anything is sent', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Invalid' })
      await assert.rejects(window.showMessageDialog({ ...options, buttons: [] }), TypeError)
      await assert.rejects(window.showMessageDialog({ ...options, title: ' ' }), TypeError)
      expect(requests(directory, 'show_message_dialog')).toEqual([])
    })
  })

  test('abort closes the OS dialog, drops a late result and shows the next one', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Abort' })
      const first = new AbortController()
      const pending = window.showMessageDialog(options, { signal: first.signal })
      const queued = window.showMessageDialog({ ...options, title: 'Second' })
      await until(() => requests(directory, 'show_message_dialog').length === 1)
      await Bun.sleep(10)
      first.abort()
      await assert.rejects(pending, { name: 'NativeServiceError', code: 'cancelled' })
      expect(requests(directory, 'close_message_dialog')).toHaveLength(1)
      // The host's late completion for the closed dialog is not delivered to the second.
      await until(() => requests(directory, 'show_message_dialog').length === 2)
      const second = new AbortController()
      void queued.catch(() => {})
      const third = window.showMessageDialog(options, { signal: second.signal })
      second.abort()
      await assert.rejects(third, { code: 'cancelled' })
    }, 'late')
  })

  test('owner close and shutdown reject a live dialog without a close command', async () => {
    await withPeer(async (app, directory) => {
      const window = await app.openWindow({ title: 'Owner' })
      const pending = window.showMessageDialog(options)
      const queued = window.showMessageDialog({ ...options, title: 'Queued' })
      await until(() => requests(directory, 'show_message_dialog').length === 1)
      await Bun.sleep(10)
      const revoked = assert.rejects(
        pending,
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
      const alsoRevoked = assert.rejects(queued, NativeStateError)
      await window.close()
      await revoked
      await alsoRevoked
      expect(requests(directory, 'close_message_dialog')).toEqual([])
      expect(requests(directory, 'show_message_dialog')).toHaveLength(1)
    })
  })

  test('a completion for an unallocated dialog fails the channel', async () => {
    await withPeer(async (app) => {
      const window = await app.openWindow({ title: 'Foreign' })
      void window.showMessageDialog(options).catch(() => {})
      await assert.rejects(app.closed, /unallocated message dialog/)
    }, 'foreign')
  })
})
