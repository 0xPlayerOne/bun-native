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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALLOW: ServicePermissions = { fileDialogs: 'allow' }

async function withDialogs(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'hold',
  permissions: ServicePermissions = ALLOW
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-file-dialog-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'file-dialog-peer.ts'), directory, mode],
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

describe('owned OS file dialogs (headless real subprocess)', () => {
  test('reports the portal backend and the immutable, default-denied launch grant', async () => {
    for (const [permissions, permission] of [
      [ALLOW, 'allow'],
      [{}, 'deny'],
    ] as const)
      await withDialogs(
        async (app) => {
          expect(app.serviceCapabilities.fileDialogs).toEqual({
            availability: 'available',
            permission,
            scope: 'owned_window',
            backend: 'xdg_desktop_portal',
          })
          expect(app.serviceCapabilities.messageDialogs).toEqual({
            availability: 'unavailable',
            reason: 'not_implemented',
          })
          expect(Object.isFrozen(app.serviceCapabilities.fileDialogs)).toBe(true)
        },
        'hold',
        permissions
      )
    await withDialogs(async (app) => {
      expect(app.serviceCapabilities.fileDialogs).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
    }, 'unavailable')
  })

  test('a host that reports an ungranted dialog permission fails launch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-file-dialog-peer-'))
    try {
      await assert.rejects(
        createApplication({
          executable: process.execPath,
          args: [resolve(import.meta.dir, 'file-dialog-peer.ts'), directory, 'forged-grant'],
          requestTimeoutMs: 2_000,
        }),
        ProtocolError
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('denial, unavailability and invalid options never show a dialog', async () => {
    await withDialogs(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'Denied dialogs' })
        await assert.rejects(window.showOpenDialog({ title: 'Open' }), {
          name: 'NativeServiceError',
          service: 'file_dialogs',
          code: 'permission_denied',
        })
        expect(requests(directory, 'show_file_dialog')).toHaveLength(1)
      },
      'hold',
      {}
    )
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'No portal' })
      await assert.rejects(window.showSaveDialog({ title: 'Save' }), {
        name: 'NativeServiceError',
        code: 'service_unavailable',
      })
    }, 'no-portal')
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Invalid options' })
      for (const options of [
        {},
        { title: '' },
        { title: 'a\nb' },
        { title: 'Open', select: 'everything' },
        { title: 'Open', folder: 'relative/path' },
        { title: 'Open', name: 'a.txt' },
        { title: 'Open', select: 'directory', filters: [{ name: 'Text', patterns: ['*.txt'] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: [] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: ['*.txt'], extra: 1 }] },
        { title: 'Open', grant: true },
      ])
        await assert.rejects(window.showOpenDialog(options as never), TypeError)
      for (const options of [
        { title: 'Save', name: '../x' },
        { title: 'Save', name: '..' },
      ])
        await assert.rejects(window.showSaveDialog(options), TypeError)
      await assert.rejects(
        window.showOpenDialog({ title: 'Open' }, { signal: {} as never }),
        TypeError
      )
      expect(requests(directory, 'show_file_dialog')).toEqual([])
    })
  })

  test('selections resolve as frozen path data in each mode', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Selections' })
      const one = await window.showOpenDialog({
        title: 'Open',
        acceptLabel: 'Open',
        folder: '/data',
        filters: [{ name: 'Text', patterns: ['*.txt'] }],
      })
      expect(one).toEqual({ kind: 'selected', paths: ['/data/ü.txt'] })
      expect(Object.isFrozen(one)).toBe(true)
      if (one.kind === 'selected') expect(Object.isFrozen(one.paths)).toBe(true)
      expect(await window.showOpenDialog({ title: 'Import', select: 'files' })).toEqual({
        kind: 'selected',
        paths: ['/data/a.txt', '/data/b c.txt'],
      })
      expect(await window.showOpenDialog({ title: 'Folder', select: 'directory' })).toEqual({
        kind: 'selected',
        paths: ['/data/ü.txt'],
      })
      const saved = await window.showSaveDialog({ title: 'Save', name: 'report.txt' })
      expect(saved).toEqual({ kind: 'selected', path: '/data/ü.txt' })
      expect(requests(directory, 'show_file_dialog').map((item) => item['options'])).toEqual([
        {
          mode: 'open_file',
          title: 'Open',
          accept_label: 'Open',
          folder: '/data',
          filters: [{ name: 'Text', patterns: ['*.txt'] }],
        },
        { mode: 'open_files', title: 'Import' },
        { mode: 'open_directory', title: 'Folder' },
        { mode: 'save_file', title: 'Save', name: 'report.txt' },
      ])
      // A selection is data: it never asks the host for any further authority.
      expect(requests(directory, 'close_file_dialog')).toEqual([])
    }, 'select')
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'Cancelled' })
      expect(await window.showOpenDialog({ title: 'Open' })).toEqual({ kind: 'cancelled' })
      expect(await window.showSaveDialog({ title: 'Save' })).toEqual({ kind: 'cancelled' })
    }, 'cancel')
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'Too large' })
      await assert.rejects(window.showOpenDialog({ title: 'Open', select: 'files' }), {
        name: 'NativeServiceError',
        service: 'file_dialogs',
        code: 'payload_too_large',
      })
    }, 'too-large')
  })

  test('cancellation before dispatch sends nothing; after showing it closes the dialog', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Cancellation' })
      const early = new AbortController()
      early.abort()
      await assert.rejects(
        window.showOpenDialog({ title: 'Open' }, { signal: early.signal }),
        (error: unknown) => error instanceof NativeServiceError && error.code === 'cancelled'
      )
      expect(requests(directory, 'show_file_dialog')).toEqual([])

      const controller = new AbortController()
      const pending = window.showOpenDialog({ title: 'Open' }, { signal: controller.signal })
      await until(() => requests(directory, 'show_file_dialog').length === 1)
      await Bun.sleep(10)
      controller.abort()
      await assert.rejects(pending, { name: 'NativeServiceError', code: 'cancelled' })
      await until(() => requests(directory, 'close_file_dialog').length === 1)
      // A later dialog on the same window is allowed once the first is closed.
      const next = new AbortController()
      const again = window.showSaveDialog({ title: 'Save' }, { signal: next.signal })
      await until(() => requests(directory, 'show_file_dialog').length === 2)
      await Bun.sleep(10)
      next.abort()
      await assert.rejects(again, { code: 'cancelled' })
    }, 'late')
  })

  test('one dialog per window; owner close and shutdown revoke a live dialog', async () => {
    await withDialogs(async (app, directory) => {
      const first = await app.openWindow({ title: 'Owner' })
      const other = await app.openWindow({ title: 'Other' })
      const pending = first.showOpenDialog({ title: 'Open' })
      await until(() => requests(directory, 'show_file_dialog').length === 1)
      await Bun.sleep(10)
      await assert.rejects(first.showOpenDialog({ title: 'Second' }), {
        name: 'NativeServiceError',
        code: 'limit_exceeded',
      })
      const elsewhere = other.showSaveDialog({ title: 'Elsewhere' })
      await until(() => requests(directory, 'show_file_dialog').length === 2)
      const revoked = assert.rejects(
        pending,
        (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
      )
      const stopped = assert.rejects(elsewhere, NativeStateError)
      await first.close()
      await revoked
      // The late native response for the closed owner is not delivered anywhere.
      await Bun.sleep(20)
      await app.shutdown()
      await stopped
    }, 'late')
  })

  test('malformed completions fail the channel', async () => {
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'Foreign' })
      void window.showOpenDialog({ title: 'Open' }).catch(() => {})
      await assert.rejects(app.closed, /unallocated file dialog/)
    }, 'foreign')
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'Several' })
      void window.showSaveDialog({ title: 'Save' }).catch(() => {})
      await assert.rejects(app.closed, /single-selection/)
    }, 'several')
  })
})
