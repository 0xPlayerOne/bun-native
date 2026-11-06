import { describe, expect, test } from 'bun:test'
import {
  NativeCommandError,
  NativeServiceError,
  NativeStateError,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import { peerRequests, withServicePeer } from './service-peer.ts'

const ROOTS: ServicePermissions = {
  filesystemRoots: [
    { id: 'work', path: '/srv/work', access: 'read_write' },
    { id: 'docs', path: '/srv/docs', access: 'read' },
  ],
}

const withFiles = (
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode: string
) => withServicePeer('file-peer', run, mode, ROOTS)

const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error
  )

const service = (error: unknown) =>
  error instanceof NativeServiceError ? [error.service, error.code] : error

const FILE_CODES = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'limit_exceeded',
  'not_found',
  'already_exists',
  'path_denied',
  'wrong_kind',
  'not_empty',
  'access_denied',
]

describe('filesystem grant lifecycle edges (headless subprocess)', () => {
  test('malformed grants, options and paths are rejected before any native request', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Validation' })
      for (const [root, options] of [
        [1, {}],
        ['work', null],
        ['work', []],
        ['work', { access: 'read', mode: 'create' }],
      ])
        expect(await failure(window.openFileGrant(root as never, options as never))).toBeInstanceOf(
          TypeError
        )
      expect(peerRequests(directory, 'open_file_grant')).toEqual([])
      const grant = await window.openFileGrant('work', { access: 'read_write' })
      const bytes = new Uint8Array([1])
      for (const call of [
        () => grant.stat(1 as never),
        () => grant.stat('a/'.repeat(32) + 'a'),
        () => grant.stat('a'.repeat(256)),
        () => grant.read('a', null as never),
        () => grant.read('a', [] as never),
        () => grant.read('a', { size: 1 } as never),
        () => grant.read('a', { offset: -1 }),
        () => grant.read('a', { offset: 1.5 }),
        () => grant.read('a', { offset: Number.MAX_SAFE_INTEGER }),
        () => grant.read('a', { length: 16_385 }),
        () => grant.list('', { after: 1 } as never),
        () => grant.list('', { after: '' }),
        () => grant.list('', { after: '..' }),
        () => grant.write('a', bytes, { mode: 'overwrite' } as never),
        () => grant.createDirectory(''),
        () => grant.remove('a/../b'),
      ])
        expect(await failure(call())).toBeInstanceOf(TypeError)
      expect(peerRequests(directory, 'file_request')).toEqual([])
    }, 'normal')
  })

  test('defaults, cursors, offsets and removal map to explicit operations', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Operations' })
      const grant = await window.openFileGrant('work')
      expect(grant.access).toBe('read')
      const writable = await window.openFileGrant('work', { access: 'read_write' })
      await grant.list('src', { after: 'a.ts' })
      await grant.read('src/a.ts', { offset: 32, length: 8 })
      await writable.write('b', new Uint8Array())
      await writable.remove('src/old')
      expect(
        peerRequests(directory, 'file_request').map((item) => [
          item['grant_id'],
          item['path'],
          item['operation'],
        ])
      ).toEqual([
        [1, 'src', { kind: 'list', after: 'a.ts' }],
        [1, 'src/a.ts', { kind: 'read', offset: 32, length: 8 }],
        [2, 'b', { kind: 'write', mode: 'create', data: '' }],
        [2, 'src/old', { kind: 'remove' }],
      ])
      expect(peerRequests(directory, 'open_file_grant').map((item) => item['access'])).toEqual([
        'read',
        'read_write',
      ])
    }, 'normal')
  })

  for (const code of FILE_CODES)
    test(`a ${code} grant open maps to the filesystem service`, async () => {
      await withFiles(async (app) => {
        const window = await app.openWindow({ title: code })
        const error = await failure(window.openFileGrant('docs'))
        expect(service(error)).toEqual(['filesystem_grants', code])
        // A failed open leaves nothing registered.
        expect(app.diagnostics.serviceRequests).toBe(0)
      }, 'open-error:' + code)
    })

  test('request errors map to the service; other codes pass through; the grant stays live', async () => {
    for (const code of [...FILE_CODES, 'invalid_handle'])
      await withFiles(async (app) => {
        const window = await app.openWindow({ title: code })
        const grant = await window.openFileGrant('docs')
        const error = await failure(grant.stat('a'))
        if (code === 'invalid_handle') {
          expect(error).toBeInstanceOf(NativeCommandError)
          expect((error as NativeCommandError).code).toBe(code)
        } else expect(service(error)).toEqual(['filesystem_grants', code])
        expect(grant.active).toBe(true)
      }, 'request-error:' + code)
  })

  test('closing revokes locally before the native close; the in-flight result is withheld', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Order' })
      const grant = await window.openFileGrant('docs')
      const pending = failure(grant.stat('a'))
      // Wait until the request has reached the peer, which holds its answer.
      for (let turn = 0; turn < 400 && !peerRequests(directory, 'file_request').length; turn += 1)
        await Bun.sleep(5)
      const closing = grant.close()
      expect(grant.active).toBe(false)
      const later = failure(grant.read('a'))
      await closing
      expect(grant.close()).toBe(closing)
      // The peer answered the stat before acknowledging the close.
      expect(service(await pending)).toEqual(['filesystem_grants', 'cancelled'])
      expect(service(await later)).toEqual(['filesystem_grants', 'cancelled'])
      expect(peerRequests(directory, 'file_request')).toHaveLength(1)
      expect(peerRequests(directory, 'close_file_grant')).toHaveLength(1)
    }, 'hold')
  })

  test('a result racing a window close is withheld', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Window' })
      const grant = await window.openFileGrant('docs')
      const pending = failure(grant.stat('a'))
      for (let turn = 0; turn < 400 && !peerRequests(directory, 'file_request').length; turn += 1)
        await Bun.sleep(5)
      await window.close()
      // The window stopped accepting results before the grant was revoked.
      const error = await pending
      expect(error).toBeInstanceOf(NativeStateError)
      expect((error as NativeStateError).code).toBe('invalid_handle')
      expect(grant.active).toBe(false)
      expect(service(await failure(grant.stat('a')))).toEqual(['filesystem_grants', 'cancelled'])
      expect(peerRequests(directory, 'close_file_grant')).toEqual([])
    }, 'hold')
  })

  test('a close the host no longer knows still resolves', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Stale' })
      const grant = await window.openFileGrant('docs')
      await grant.close()
      expect(grant.active).toBe(false)
      expect(peerRequests(directory, 'close_file_grant')).toHaveLength(1)
    }, 'close-error:invalid_handle')
  })

  test('a close the host refuses rejects with its native error', async () => {
    await withFiles(async (app) => {
      const window = await app.openWindow({ title: 'Refused' })
      const grant = await window.openFileGrant('docs')
      expect(await failure(grant.close())).toBeInstanceOf(NativeCommandError)
      expect(grant.active).toBe(false)
    }, 'close-error:native_failure')
  })

  test('shutdown revokes grants; later calls and close send nothing', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Shutdown' })
      const grant = await window.openFileGrant('docs')
      await app.shutdown()
      expect(grant.active).toBe(false)
      await grant.close()
      expect(service(await failure(grant.stat('a')))).toEqual(['filesystem_grants', 'cancelled'])
      expect(await failure(window.openFileGrant('docs'))).toBeInstanceOf(NativeStateError)
      expect(peerRequests(directory, 'close_file_grant')).toEqual([])
      expect(peerRequests(directory, 'file_request')).toEqual([])
    }, 'normal')
  })

  test('file requests share the eight-request service bound', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Bound' })
      const grant = await window.openFileGrant('docs')
      const reads = Array.from({ length: 8 }, () => grant.stat('a'))
      const ninth = await failure(grant.stat('b'))
      expect(ninth).toBeInstanceOf(NativeStateError)
      expect((ninth as NativeStateError).code).toBe('limit_exceeded')
      // The peer answers only once all eight are in flight.
      expect((await Promise.all(reads)).every((stat) => stat.kind === 'file')).toBe(true)
      expect(peerRequests(directory, 'file_request')).toHaveLength(8)
    }, 'batch8')
  })
})
