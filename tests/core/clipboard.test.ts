import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function withClipboard(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = { clipboardRead: 'allow', clipboardWrite: 'allow' }
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-clipboard-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'clipboard-peer.ts'), directory, mode],
      permissions,
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    writeFileSync(join(directory, 'release'), '')
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
    .map((line) => JSON.parse(line) as { type: string })
    .filter((value) => value.type === type)
}

async function received(directory: string, count = 1) {
  const deadline = performance.now() + 1_000
  while (requests(directory, 'clipboard_read').length < count) {
    if (performance.now() >= deadline)
      throw new Error('Clipboard request did not reach the headless peer')
    await Bun.sleep(2)
  }
}

describe('clipboard lifecycle and independent scheduling (headless real subprocess)', () => {
  test('read and write are separately default-denied native operations', () =>
    withClipboard(
      async (app, directory) => {
        expect(app.serviceCapabilities.clipboardText).toEqual({
          availability: 'available',
          read: 'deny',
          write: 'deny',
          scope: 'owned_window',
          backend: 'x11',
        })
        expect(Object.isFrozen(app.serviceCapabilities.clipboardText)).toBe(true)
        expect(Object.isFrozen(app.capabilities)).toBe(true)
        const window = await app.openWindow({ title: 'Explicit policy' })
        await assert.rejects(window.readClipboardText(), {
          name: 'NativeServiceError',
          service: 'clipboard_read',
          code: 'permission_denied',
        })
        await assert.rejects(window.writeClipboardText('Not granted'), {
          name: 'NativeServiceError',
          service: 'clipboard_write',
          code: 'permission_denied',
        })
        expect(requests(directory, 'clipboard_read')).toHaveLength(1)
        expect(requests(directory, 'clipboard_write')).toHaveLength(1)
      },
      'normal',
      {}
    ))

  test.each(['clipboardRead', 'clipboardWrite'] as const)(
    'one grant does not imply the other: %s',
    (permission) =>
      withClipboard(
        async (app) => {
          const window = await app.openWindow({ title: 'Separate grants' })
          if (permission === 'clipboardRead') {
            expect(await window.readClipboardText()).toEqual({ kind: 'empty' })
            await assert.rejects(window.writeClipboardText('No'), { code: 'permission_denied' })
          } else {
            await window.writeClipboardText('Explicit')
            await assert.rejects(window.readClipboardText(), { code: 'permission_denied' })
          }
        },
        'normal',
        { [permission]: 'allow' }
      )
  )

  test('no owner, empty text and Unicode text remain distinct immutable values', () =>
    withClipboard(async (app) => {
      const window = await app.openWindow({ title: 'Typed text result' })
      expect(await window.readClipboardText()).toEqual({ kind: 'empty' })
      for (const text of ['', '世界🙂\r\n']) {
        await window.writeClipboardText(text)
        const result = await window.readClipboardText()
        expect(result).toEqual({ kind: 'text', text })
        expect(Object.isFrozen(result)).toBe(true)
      }
    }))

  test('a held read cannot occupy the shared tree transaction queue', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Independent native queues' })
      const read = window.readClipboardText()
      await received(directory)
      expect(app.diagnostics.serviceRequests).toBe(1)
      await window.batch((batch) =>
        batch.append(
          window.root,
          batch.create({ kind: 'text', text: 'Commit progresses before read completes' })
        )
      )
      expect(window.revision).toBe(1)
      expect(app.diagnostics.queuedTransactions).toBe(0)
      expect(app.diagnostics.serviceRequests).toBe(1)
      writeFileSync(join(directory, 'release'), '')
      expect(await read).toEqual({ kind: 'empty' })
    }, 'hold'))

  test('pre-dispatch cancellation and invalid JS options send no read', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Pre-dispatch cancellation' })
      await assert.rejects(
        window.readClipboardText({ signal: AbortSignal.abort() }),
        NativeServiceError
      )
      const controller = new AbortController()
      const queued = window.readClipboardText({ signal: controller.signal })
      controller.abort()
      await assert.rejects(queued, { code: 'cancelled' })
      await assert.rejects(window.readClipboardText({ grant: true } as never), TypeError)
      await assert.rejects(
        window.readClipboardText({ signal: { aborted: false } } as never),
        TypeError
      )
      expect(requests(directory, 'clipboard_read')).toHaveLength(0)
    }))

  test('submitted cancellation drains and validates without blocking subsequent commits', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Submitted cancellation' })
      const controller = new AbortController()
      const pending = window.readClipboardText({ signal: controller.signal })
      const rejected = assert.rejects(pending, { code: 'cancelled', service: 'clipboard_read' })
      await received(directory)
      controller.abort()
      await window.batch((batch) =>
        batch.append(window.root, batch.create({ kind: 'text', text: 'Still responsive' }))
      )
      expect(app.diagnostics.serviceRequests).toBe(1)
      writeFileSync(join(directory, 'release'), '')
      await rejected
      expect(await window.readClipboardText()).toEqual({ kind: 'empty' })
    }, 'hold'))

  test('window close cancels pending operations without waiting for an external reply', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Revoked clipboard owner' })
      const read = window.readClipboardText()
      const rejected = assert.rejects(read, NativeStateError)
      await received(directory)
      await window.close()
      await rejected
      expect(existsSync(join(directory, 'release'))).toBe(false)
      await assert.rejects(window.readClipboardText(), { code: 'invalid_handle' })
      await assert.rejects(window.writeClipboardText('Stale'), { code: 'invalid_handle' })
      expect(requests(directory, 'clipboard_read')).toHaveLength(1)
      expect(requests(directory, 'clipboard_write')).toHaveLength(0)
    }, 'hold'))

  test('shutdown cancels and joins pending service outcomes before completion', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Clipboard shutdown' })
      const read = window.readClipboardText()
      const rejected = assert.rejects(read, { code: 'invalid_handle' })
      await received(directory)
      await app.shutdown()
      await rejected
      await app.closed
      expect(app.diagnostics.serviceRequests).toBe(0)
      expect(existsSync(join(directory, 'release'))).toBe(false)
    }, 'hold'))

  test('service capacity is bounded independently from close and tree cleanup capacity', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Bounded clipboard queue' })
      const pending = Array.from({ length: 8 }, () => window.readClipboardText())
      const rejections = pending.map((read) => assert.rejects(read, { code: 'invalid_handle' }))
      await received(directory, 8)
      await assert.rejects(window.readClipboardText(), { code: 'limit_exceeded' })
      expect(app.diagnostics.serviceRequests).toBe(8)
      await window.close()
      await Promise.all(rejections)
      expect(requests(directory, 'clipboard_read')).toHaveLength(8)
    }, 'hold'))

  test.each(['operation_timed_out', 'payload_too_large', 'native_failure'])(
    'native failure remains typed: %s',
    (code) =>
      withClipboard(async (app) => {
        const window = await app.openWindow({ title: 'Typed service error' })
        await assert.rejects(window.readClipboardText(), {
          name: 'NativeServiceError',
          service: 'clipboard_read',
          code,
        })
        await window.close()
      }, code)
  )

  test('unsupported platform is visible and cannot return a cached result', () =>
    withClipboard(async (app) => {
      expect(app.serviceCapabilities.clipboardText).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const window = await app.openWindow({ title: 'Unavailable clipboard' })
      await assert.rejects(window.readClipboardText(), { code: 'service_unavailable' })
      await assert.rejects(window.writeClipboardText('No cache'), { code: 'service_unavailable' })
    }, 'unavailable'))

  test('wrong-owner replies remain fatal even after cancellation', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Malformed cancelled read' })
      const controller = new AbortController()
      const pending = window.readClipboardText({ signal: controller.signal })
      const rejected = assert.rejects(pending, ProtocolError)
      await received(directory)
      controller.abort()
      writeFileSync(join(directory, 'release'), '')
      await rejected
      await assert.rejects(app.closed, ProtocolError)
    }, 'hold-wrong-owner'))

  test('write validation and negotiated limits precede any request', () =>
    withClipboard(async (app, directory) => {
      const window = await app.openWindow({ title: 'Small negotiated limit' })
      for (const text of ['ééx', 'a\0', '\ud800', 1])
        await assert.rejects(window.writeClipboardText(text as string), ProtocolError)
      expect(requests(directory, 'clipboard_write')).toHaveLength(0)
      await window.writeClipboardText('éé')
      expect(await window.readClipboardText()).toEqual({ kind: 'text', text: 'éé' })
    }, 'lower-limit'))

  test('a native reply cannot exceed its advertised text bound', () =>
    withClipboard(async (app) => {
      const window = await app.openWindow({ title: 'Bad advertised limit' })
      await assert.rejects(window.readClipboardText(), ProtocolError)
      await assert.rejects(app.closed, ProtocolError)
    }, 'lower-limit-response'))

  test('native readiness must echo both explicit clipboard grants', async () => {
    await assert.rejects(
      withClipboard(async () => {
        throw new Error('Wrong-policy peer was exposed')
      }, 'wrong-policy'),
      ProtocolError
    )
  })
})
