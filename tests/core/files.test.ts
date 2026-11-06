import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  ProtocolError,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { peerRequests, withServicePeer } from './service-peer.ts'

const ROOTS: ServicePermissions = {
  filesystemRoots: [
    { id: 'work', path: '/srv/work', access: 'read_write' },
    { id: 'docs', path: '/srv/docs', access: 'read' },
  ],
}

const withFiles = (
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = ROOTS
) => withServicePeer('file-peer', run, mode, permissions)

const cancelled = (error: unknown) =>
  error instanceof NativeServiceError &&
  error.service === 'filesystem_grants' &&
  error.code === 'cancelled'

describe('filesystem grants through the public core (headless subprocess)', () => {
  test('launch roots become reserved arguments and a frozen capability record', async () => {
    await withFiles(async (app, directory) => {
      expect(app.serviceCapabilities.filesystemGrants).toEqual({
        availability: 'available',
        roots: { work: { access: 'read_write' }, docs: { access: 'read' } },
        scope: 'owned_window',
        backend:
          process.platform === 'darwin'
            ? 'openat_walk'
            : process.platform === 'win32'
              ? 'ntcreatefile_walk'
              : 'openat2',
      })
      expect(Object.isFrozen(app.serviceCapabilities.filesystemGrants)).toBe(true)
      const window = await app.openWindow({ title: 'Grants' })
      const grant = await window.openFileGrant('work', { access: 'read_write' })
      expect(Object.isFrozen(grant)).toBe(true)
      expect([grant.root, grant.access, grant.active]).toEqual(['work', 'read_write', true])
      expect(await grant.stat('a')).toEqual({ kind: 'file', size: 2, modifiedMs: 7 })
      expect(await grant.read('a')).toEqual({
        bytes: new TextEncoder().encode('hi'),
        endOfFile: true,
      })
      expect(await grant.write('a', new TextEncoder().encode('hi'), { mode: 'append' })).toBe(2)
      expect(await grant.list()).toEqual({
        entries: [{ name: 'a', kind: 'file' }],
        complete: true,
        omitted: 1,
      })
      expect(await grant.createDirectory('d')).toBeUndefined()
      expect(peerRequests(directory, 'open_file_grant')).toEqual([
        {
          id: 3,
          type: 'open_file_grant',
          window_id: 1,
          grant_id: 1,
          root: 'work',
          access: 'read_write',
        },
      ])
      expect(
        peerRequests(directory, 'file_request').map((request) => request['operation'])
      ).toEqual([
        { kind: 'stat' },
        { kind: 'read', offset: 0, length: 16_384 },
        { kind: 'write', mode: 'append', data: 'aGk=' },
        { kind: 'list' },
        { kind: 'create_directory' },
      ])
    })
  })

  test('invalid roots and paths fail before any native request', async () => {
    for (const filesystemRoots of [
      [{ id: 'work', path: 'relative', access: 'read' }],
      [{ id: 'work', path: '/a/../b', access: 'read' }],
      [
        { id: 'work', path: '/a', access: 'read' },
        { id: 'work', path: '/b', access: 'read' },
      ],
      [{ id: 'work', path: '/a', access: 'write' }],
    ])
      await expect(
        createApplication({
          executable: process.execPath,
          permissions: { filesystemRoots } as never,
        })
      ).rejects.toThrow(TypeError)
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Paths' })
      await expect(window.openFileGrant('/srv/work')).rejects.toThrow(TypeError)
      await expect(window.openFileGrant('work', { access: 'write' as never })).rejects.toThrow(
        TypeError
      )
      const grant = await window.openFileGrant('work', { access: 'read_write' })
      for (const path of ['../x', '/etc/passwd', 'a/../b', 'a//b', '.', 'a\nb'])
        await expect(grant.stat(path)).rejects.toThrow(TypeError)
      await expect(grant.write('', new Uint8Array())).rejects.toThrow(TypeError)
      await expect(grant.remove('')).rejects.toThrow(TypeError)
      await expect(grant.write('a', new Uint8Array(16_385))).rejects.toThrow(TypeError)
      await expect(grant.write('a', 'text' as never)).rejects.toThrow(TypeError)
      await expect(grant.read('a', { length: 0 })).rejects.toThrow(TypeError)
      await expect(grant.list('', { after: 'a/b' })).rejects.toThrow(TypeError)
      expect(peerRequests(directory, 'file_request')).toEqual([])
    })
  })

  test('closing withholds an in-flight result and later calls send nothing', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Slow' })
      const grant = await window.openFileGrant('docs')
      const pending = grant.stat('a')
      await Bun.sleep(20)
      await grant.close()
      await grant.close()
      expect(grant.active).toBe(false)
      expect(cancelled(await pending.catch((error: unknown) => error))).toBe(true)
      expect(cancelled(await grant.read('a').catch((error: unknown) => error))).toBe(true)
      await Bun.sleep(150)
      expect(peerRequests(directory, 'file_request')).toHaveLength(1)
      expect(peerRequests(directory, 'close_file_grant')).toHaveLength(1)
      const owned = await window.openFileGrant('docs')
      await window.close()
      expect(owned.active).toBe(false)
      expect(cancelled(await owned.stat('a').catch((error: unknown) => error))).toBe(true)
      // Window close revokes natively; no separate close request is sent.
      expect(peerRequests(directory, 'close_file_grant')).toHaveLength(1)
    }, 'slow')
  })

  test('a result of the wrong shape fails the channel', async () => {
    await withFiles(async (app, directory) => {
      const window = await app.openWindow({ title: 'Mismatch' })
      const grant = await window.openFileGrant('docs')
      const stat = await grant.stat('a').catch((error: unknown) => error)
      const closed = await app.closed.catch((error: unknown) => error)
      // On failure, name what the peer received and finished replying.
      const trace = ['requests.jsonl', 'replies.jsonl']
        .map((name) => join(directory, name))
        .map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : '(none)'))
        .join('\n')
      expect([stat instanceof ProtocolError, closed instanceof ProtocolError, trace]).toEqual([
        true,
        true,
        trace,
      ])
    }, 'mismatch')
  })

  test('a reported policy that differs from the launch request fails launch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-file-peer-'))
    try {
      await expect(
        createApplication({
          executable: process.execPath,
          args: [resolve(import.meta.dir, 'file-peer.ts'), directory, 'policy'],
          permissions: ROOTS,
          requestTimeoutMs: 2_000,
        })
      ).rejects.toThrow(/launch permissions/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('targets without confinement report the service unavailable', async () => {
    await withFiles(async (app) => {
      expect(app.serviceCapabilities.filesystemGrants).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
    }, 'unavailable')
  })
})
