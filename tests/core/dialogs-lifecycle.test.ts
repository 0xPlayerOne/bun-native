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

// Headless: the peer answers like the host and is never evidence of an OS dialog.
const ALLOW: ServicePermissions = { fileDialogs: 'allow' }
const ZERO = [0, 0, 0, 0, 0, 0, 0]

async function withDialogs(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'hold'
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-dialogs-lifecycle-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'file-dialog-peer.ts'), directory, mode],
      permissions: ALLOW,
      requestTimeoutMs: 2_000,
    })
    await run(app, directory)
  } finally {
    await app?.shutdown().catch(() => {})
    await app?.closed.catch(() => {})
    if (app) expect(Object.values(app.diagnostics)).toEqual(ZERO)
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
  const deadline = performance.now() + 2_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for the peer')
    await Bun.sleep(2)
  }
}

const filter = { name: 'Text', patterns: ['*.txt'] }

describe('file dialog option validation (headless subprocess)', () => {
  test('malformed open and save options are TypeErrors that never reach the host', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Validation' })
      const open: unknown[] = [
        undefined,
        null,
        'Open',
        ['Open'],
        { title: 1 },
        { title: 'x'.repeat(257) },
        { title: 'é'.repeat(129) },
        { title: 'Open', acceptLabel: '' },
        { title: 'Open', acceptLabel: 'x'.repeat(65) },
        { title: 'Open', folder: '' },
        { title: 'Open', folder: 'C:\\Users\\me' },
        { title: 'Open', folder: 'C:/Users/me' },
        { title: 'Open', folder: '/a\0b' },
        { title: 'Open', folder: '/' + 'x'.repeat(4096) },
        { title: 'Open', filters: '*.txt' },
        { title: 'Open', filters: { name: 'Text', patterns: ['*.txt'] } },
        { title: 'Open', filters: [null] },
        { title: 'Open', filters: ['*.txt'] },
        { title: 'Open', filters: [[filter]] },
        { title: 'Open', filters: [{ name: 'Text', patterns: '*.txt' }] },
        { title: 'Open', filters: [{ name: '', patterns: ['*.txt'] }] },
        { title: 'Open', filters: [{ name: 'x'.repeat(129), patterns: ['*.txt'] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: ['*'.repeat(65)] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: [''] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: ['a\tb'] }] },
        { title: 'Open', filters: [{ name: 'Text', patterns: Array(17).fill('*.txt') }] },
        { title: 'Open', filters: Array(17).fill(filter) },
        { title: 'Open', select: 'files', name: 'a.txt' },
      ]
      for (const options of open)
        await assert.rejects(window.showOpenDialog(options as never), TypeError)
      const save: unknown[] = [
        null,
        { title: 'Save', select: 'file' },
        { title: 'Save', name: '' },
        { title: 'Save', name: '.' },
        { title: 'Save', name: 'a/b' },
        { title: 'Save', name: 'x'.repeat(256) },
        { title: 'Save', name: 'a\nb' },
        { title: 'Save', folder: 'relative' },
        { title: 'Save', filters: [{ name: 'Text' }] },
      ]
      for (const options of save)
        await assert.rejects(window.showSaveDialog(options as never), TypeError)
      expect(requests(directory, 'show_file_dialog')).toEqual([])
    })
  })

  test('limits are inclusive and absent or empty optional fields are omitted', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Bounds' })
      const title = 'é'.repeat(128)
      const patterns = Array.from({ length: 16 }, (_, index) => `*.${index}`)
      const filters = Array.from({ length: 16 }, (_, index) => ({ name: `F${index}`, patterns }))
      expect(
        await window.showOpenDialog({
          title,
          acceptLabel: 'x'.repeat(64),
          folder: '/' + 'x'.repeat(4095),
          filters,
          select: 'files',
        })
      ).toEqual({ kind: 'cancelled' })
      expect(
        // Untyped callers may pass explicit undefined; it means absent.
        await window.showOpenDialog({
          title: 'Folder',
          select: 'directory',
          filters: [],
          acceptLabel: undefined,
          folder: undefined,
        } as never)
      ).toEqual({ kind: 'cancelled' })
      expect(
        await window.showSaveDialog({ title: 'Save', name: 'x'.repeat(255), filters: [filter] })
      ).toEqual({ kind: 'cancelled' })
      const sent = requests(directory, 'show_file_dialog').map((item) => item['options'])
      expect(sent[0]).toEqual({
        mode: 'open_files',
        title,
        accept_label: 'x'.repeat(64),
        folder: '/' + 'x'.repeat(4095),
        filters,
      })
      expect(sent[1]).toEqual({ mode: 'open_directory', title: 'Folder' })
      expect(sent[2]).toEqual({
        mode: 'save_file',
        title: 'Save',
        name: 'x'.repeat(255),
        filters: [filter],
      })
    }, 'cancel')
  })

  test('the caller keeps ownership of its option arrays', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Copies' })
      const patterns = ['*.txt']
      const filters = [{ name: 'Text', patterns }]
      await window.showOpenDialog({ title: 'Open', filters })
      patterns.push('*.md')
      filters.push({ name: 'More', patterns })
      expect(requests(directory, 'show_file_dialog')[0]!['options']).toEqual({
        mode: 'open_file',
        title: 'Open',
        filters: [{ name: 'Text', patterns: ['*.txt'] }],
      })
    }, 'cancel')
  })
})

describe('file dialog results and lifetime (headless subprocess)', () => {
  test('a native failure rejects as a typed service error', async () => {
    await withDialogs(async (app) => {
      const window = await app.openWindow({ title: 'Failure' })
      await assert.rejects(
        window.showSaveDialog({ title: 'Save' }),
        (error: unknown) =>
          error instanceof NativeServiceError &&
          error.service === 'file_dialogs' &&
          error.code === 'native_failure'
      )
      // The window can show another dialog after a failure.
      await assert.rejects(window.showOpenDialog({ title: 'Again' }), { code: 'native_failure' })
    }, 'native-failure')
  })

  test('dialog identities increase across cancellations, failures and windows', async () => {
    await withDialogs(async (app, directory) => {
      const first = await app.openWindow({ title: 'First' })
      const second = await app.openWindow({ title: 'Second' })
      expect(await first.showOpenDialog({ title: 'One' })).toEqual({ kind: 'cancelled' })
      expect(await second.showSaveDialog({ title: 'Two' })).toEqual({ kind: 'cancelled' })
      const aborted = new AbortController()
      aborted.abort()
      await assert.rejects(first.showOpenDialog({ title: 'Never' }, { signal: aborted.signal }), {
        code: 'cancelled',
      })
      await assert.rejects(first.showOpenDialog({ title: 'Invalid', filters: 'x' } as never))
      expect(await first.showOpenDialog({ title: 'Three' })).toEqual({ kind: 'cancelled' })
      expect(
        requests(directory, 'show_file_dialog').map(({ window_id, dialog_id }) => ({
          window_id,
          dialog_id,
        }))
      ).toEqual([
        { window_id: 1, dialog_id: 1 },
        { window_id: 2, dialog_id: 2 },
        { window_id: 1, dialog_id: 3 },
      ])
    }, 'cancel')
  })

  test('cancelling a dialog the host already finished settles quietly', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Finished' })
      const controller = new AbortController()
      const pending = window.showOpenDialog({ title: 'Open' }, { signal: controller.signal })
      await until(() => requests(directory, 'show_file_dialog').length === 1)
      await until(() => app.diagnostics.serviceRequests === 0)
      controller.abort()
      await assert.rejects(pending, { name: 'NativeServiceError', code: 'cancelled' })
      // The host answers the close with invalid_handle; that is not a failure.
      await until(() => requests(directory, 'close_file_dialog').length === 1)
      const again = new AbortController()
      const next = window.showSaveDialog({ title: 'Save' }, { signal: again.signal })
      await until(() => requests(directory, 'show_file_dialog').length === 2)
      again.abort()
      await assert.rejects(next, { code: 'cancelled' })
      await until(() => requests(directory, 'close_file_dialog').length === 2)
    }, 'forget')
  })

  test('a closed window or stopped application shows no dialog', async () => {
    await withDialogs(async (app, directory) => {
      const window = await app.openWindow({ title: 'Closed' })
      await window.close()
      await assert.rejects(window.showOpenDialog({ title: 'Open' }), NativeStateError)
      await assert.rejects(window.showSaveDialog({ title: 'Save' }), NativeStateError)
      const other = await app.openWindow({ title: 'Other' })
      await app.shutdown()
      await assert.rejects(other.showOpenDialog({ title: 'Open' }))
      expect(requests(directory, 'show_file_dialog')).toEqual([])
    })
  })

  test('a completion addressed to another window fails the channel', async () => {
    await withDialogs(async (app) => {
      const owner = await app.openWindow({ title: 'Owner' })
      await app.openWindow({ title: 'Bystander' })
      void owner.showOpenDialog({ title: 'Open' }).catch(() => {})
      await assert.rejects(app.closed, ProtocolError)
      await assert.rejects(app.closed, /outside its owner/)
    }, 'cross')
  })
})
