import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeCommandError,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type NativeApplication,
  type ProcessEvent,
  type ServicePermissions,
} from '@bun-native/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { peerRequests, settle, withServicePeer } from './service-peer.ts'

const POLICY: ServicePermissions = {
  processes: [{ id: 'shell', executable: '/bin/sh' }],
  filesystemRoots: [{ id: 'work', path: '/srv/work', access: 'read' }],
}

const withProcesses = (
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode: string
) => withServicePeer('process-peer', run, mode, POLICY)

/** Waits for delivery through the real pipes; the peer answers immediately. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 400 && !done(); turn += 1) await Bun.sleep(5)
  expect(done()).toBe(true)
}

const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error
  )

const service = (error: unknown) =>
  error instanceof NativeServiceError ? [error.service, error.code] : error

describe('owned process lifecycle edges (headless subprocess)', () => {
  test('malformed launches are rejected before any native request', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Launch' })
      const grant = await window.openFileGrant('work')
      const closed = await window.openFileGrant('work')
      await closed.close()
      const listener = () => {}
      for (const options of [
        null,
        [],
        { env: [] },
        { env: Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['V' + index, ''])) },
        { env: { ['A'.repeat(129)]: 'x' } },
        { env: { A: 'a\0b' } },
        { args: Array.from({ length: 9 }, () => 'a'.repeat(4_096)) },
        { cwd: { grant, path: 'a', extra: true } },
        { cwd: { grant, path: '../a' } },
        { cwd: { grant: closed } },
        { cwd: { grant: {} } },
        { terminal: { columns: 80, rows: 1_001 } },
        { terminal: { columns: 80, rows: 24, pixels: 1 } },
      ])
        expect(
          await failure(window.spawnProcess('shell', options as never, listener))
        ).toBeInstanceOf(TypeError)
      expect(peerRequests(directory, 'spawn_process')).toEqual([])
      // The grant root itself is the default working directory.
      await window.spawnProcess('shell', { cwd: { grant } }, listener)
      expect(peerRequests(directory, 'spawn_process')[0]?.['launch']).toEqual({
        executable: 'shell',
        args: [],
        env: {},
        cwd: { grant_id: 1, path: '' },
      })
      await window.close()
      const late = await failure(window.spawnProcess('shell', {}, listener))
      expect(late).toBeInstanceOf(NativeStateError)
      expect((late as NativeStateError).code).toBe('invalid_handle')
      expect(peerRequests(directory, 'spawn_process')).toHaveLength(1)
    }, 'quiet')
  })

  for (const code of [
    'permission_denied',
    'limit_exceeded',
    'path_denied',
    'wrong_kind',
    'access_denied',
    'cancelled',
    'native_failure',
  ])
    test(`a ${code} spawn failure maps to the processes service`, async () => {
      await withProcesses(async (app) => {
        const window = await app.openWindow({ title: code })
        const error = await failure(window.spawnProcess('shell', {}, () => {}))
        expect(service(error)).toEqual(['processes', code])
      }, 'spawn-error:' + code)
    })

  test('a code outside the processes contract passes through unmapped', async () => {
    await withProcesses(async (app) => {
      const window = await app.openWindow({ title: 'Unmapped' })
      const error = await failure(window.spawnProcess('shell', {}, () => {}))
      expect(error).toBeInstanceOf(NativeCommandError)
      expect((error as NativeCommandError).code).toBe('invalid_handle')
    }, 'spawn-error:invalid_handle')
  })

  test('host answers to input, resize and signals map without revoking the process', async () => {
    await withProcesses(async (app) => {
      const window = await app.openWindow({ title: 'Calls' })
      const child = await window.spawnProcess('shell', {}, () => {})
      // Pending input over 64 KiB, input already closed, resize of a pipes process.
      expect(service(await failure(child.write(new Uint8Array([1]))))).toEqual([
        'processes',
        'limit_exceeded',
      ])
      expect(service(await failure(child.closeInput()))).toEqual(['processes', 'invalid_state'])
      expect(service(await failure(child.resize({ columns: 1, rows: 1 })))).toEqual([
        'processes',
        'wrong_kind',
      ])
      const signal = await failure(child.signal('kill'))
      expect(signal).toBeInstanceOf(NativeCommandError)
      expect((signal as NativeCommandError).code).toBe('invalid_handle')
      expect(child.active).toBe(true)
    }, 'call-error')
  })

  test('a release the host no longer knows still resolves', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Release' })
      const child = await window.spawnProcess('shell', {}, () => {})
      const releasing = child.release()
      // Revocation is local and synchronous; the native release follows.
      expect(child.active).toBe(false)
      await releasing
      expect(child.release()).toBe(releasing)
      expect(peerRequests(directory, 'release_process')).toHaveLength(1)
    }, 'release-error:invalid_handle')
  })

  test('a release the host refuses rejects with its native error', async () => {
    await withProcesses(async (app) => {
      const window = await app.openWindow({ title: 'Refused' })
      const child = await window.spawnProcess('shell', {}, () => {})
      const error = await failure(child.release())
      expect(error).toBeInstanceOf(NativeCommandError)
      expect(child.active).toBe(false)
    }, 'release-error:native_failure')
  })

  test('output and exit the host queued before a release are dropped', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Late release' })
      const events: ProcessEvent[] = []
      const child = await window.spawnProcess('shell', {}, (event) => void events.push(event))
      await child.release()
      await settle(app)
      expect(events).toEqual([])
      expect(child.exit).toBeUndefined()
      expect(peerRequests(directory, 'acknowledge_process_output')).toEqual([])
      // The channel stays healthy: a later process still starts.
      await window.spawnProcess('shell', {}, () => {})
    }, 'late-release')
  })

  test('output and exit racing a window close are dropped without a release request', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Late close' })
      const other = await app.openWindow({ title: 'Survivor' })
      const events: ProcessEvent[] = []
      const child = await window.spawnProcess('shell', {}, (event) => void events.push(event))
      await window.close()
      await settle(app)
      expect([child.active, events, child.exit]).toEqual([false, [], undefined])
      await child.release()
      expect(peerRequests(directory, 'release_process')).toEqual([])
      expect(peerRequests(directory, 'acknowledge_process_output')).toEqual([])
      await other.spawnProcess('shell', {}, () => {})
    }, 'late-close')
  })

  test('a release during a pending callback aborts it and withholds its credit', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Pending' })
      const signals: AbortSignal[] = []
      const child = await window.spawnProcess('shell', {}, (event) => {
        signals.push(event.signal)
        return new Promise<void>(() => {}) // Never settles on its own.
      })
      await until(() => signals.length === 1)
      expect(signals[0]!.aborted).toBe(false)
      await child.release()
      expect(signals[0]!.aborted).toBe(true)
      await settle(app)
      // The second chunk was queued behind the first and is dropped with it.
      expect(signals).toHaveLength(1)
      expect(peerRequests(directory, 'acknowledge_process_output')).toEqual([])
    }, 'normal')
  })

  test('an acknowledgement the host no longer knows is ignored', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Ack' })
      let exited!: () => void
      const done = new Promise<void>((resolve) => (exited = resolve))
      const child = await window.spawnProcess('shell', {}, (event) => {
        if (event.type === 'process_exited') exited()
      })
      await done
      expect(child.exit).toEqual({ code: 7 })
      expect(
        peerRequests(directory, 'acknowledge_process_output').map((item) => item['chunk'])
      ).toEqual([1, 2])
      await child.release()
    }, 'ack-error')
  })

  test('shutdown revokes processes; later calls send nothing', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Shutdown' })
      const child = await window.spawnProcess('shell', {}, () => {})
      await app.shutdown()
      expect(child.active).toBe(false)
      await child.release()
      expect(service(await failure(child.write(new Uint8Array([1]))))).toEqual([
        'processes',
        'cancelled',
      ])
      expect(peerRequests(directory, 'release_process')).toEqual([])
      expect(peerRequests(directory, 'write_process')).toEqual([])
      const late = await failure(window.spawnProcess('shell', {}, () => {}))
      expect(late).toBeInstanceOf(NativeStateError)
    }, 'quiet')
  })

  test('process controls share the eight-request service bound', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Bound' })
      const child = await window.spawnProcess('shell', {}, () => {})
      const writes = Array.from({ length: 8 }, () => child.write(new Uint8Array([1])))
      const ninth = await failure(child.write(new Uint8Array([2])))
      expect(ninth).toBeInstanceOf(NativeStateError)
      expect((ninth as NativeStateError).code).toBe('limit_exceeded')
      // The peer answers only once all eight are in flight.
      await Promise.all(writes)
      expect(peerRequests(directory, 'write_process')).toHaveLength(8)
      expect(app.diagnostics.serviceRequests).toBe(0)
    }, 'hold')
  })

  for (const [mode, message] of [
    ['foreign', /outside its owner/],
    ['wrong-stream', /wrong stream kind/],
    ['unallocated', /unallocated process/],
  ] as const)
    test(`${mode} process output fails the channel`, async () => {
      await withProcesses(async (app) => {
        await app.openWindow({ title: 'One' })
        const window = await app.openWindow({ title: 'Two' })
        await window.spawnProcess('shell', {}, () => {}).catch(() => {})
        const error = await failure(app.closed)
        expect(error).toBeInstanceOf(ProtocolError)
        expect((error as Error).message).toMatch(message)
      }, mode)
    })

  test('a reported process policy that differs from the launch request fails launch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-process-peer-'))
    try {
      await expect(
        createApplication({
          executable: process.execPath,
          args: [resolve(import.meta.dir, 'process-peer.ts'), directory, 'policy'],
          permissions: POLICY,
          requestTimeoutMs: 2_000,
        })
      ).rejects.toThrow(/launch permissions/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
