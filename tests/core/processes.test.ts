import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  ProtocolError,
  type NativeApplication,
  type ProcessEvent,
  type ServicePermissions,
} from '@bun-native/core'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const POLICY: ServicePermissions = {
  processes: [
    { id: 'shell', executable: '/bin/sh' },
    { id: 'tool', executable: '/opt/a:b/tool' },
  ],
  filesystemRoots: [{ id: 'work', path: '/srv/work', access: 'read' }],
}

async function withProcesses(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions: ServicePermissions = POLICY
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-process-peer-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'process-peer.ts'), directory, mode],
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

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Waits for delivery through the real pipes; the peer answers immediately. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 400 && !done(); turn += 1) await Bun.sleep(5)
  expect(done()).toBe(true)
}

function collector() {
  const events: ProcessEvent[] = []
  let ended!: () => void
  const exited = new Promise<void>((resolve) => (ended = resolve))
  return {
    events,
    exited,
    listener: (event: ProcessEvent) => {
      events.push(event)
      if (event.type === 'process_exited') ended()
    },
  }
}

describe('owned processes through the public core (headless subprocess)', () => {
  test('launch executables become reserved arguments and a frozen capability record', async () => {
    await withProcesses(async (app, directory) => {
      expect(app.serviceCapabilities.ptyProcess).toEqual({
        availability: 'available',
        executables: {
          shell: { executable: '/bin/sh' },
          tool: { executable: '/opt/a:b/tool' },
        },
        scope: 'owned_window',
        backend: 'posix',
      })
      expect(Object.isFrozen(app.serviceCapabilities.ptyProcess)).toBe(true)
      const argv = JSON.parse(readFileSync(join(directory, 'argv.json'), 'utf8')) as string[]
      expect(argv.filter((item) => item.startsWith('--bun-native-process='))).toEqual([
        '--bun-native-process=shell:/bin/sh',
        '--bun-native-process=tool:/opt/a:b/tool',
      ])
    })
  })

  test('output arrives in order, each settled callback returns credit, and the exit is last', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Processes' })
      const seen = collector()
      const child = await window.spawnProcess(
        'shell',
        { args: ['-c', 'echo hi'], env: { LANG: 'C.UTF-8' } },
        seen.listener
      )
      expect(Object.isFrozen(child)).toBe(true)
      expect([child.executable, child.terminal, child.active, child.exit]).toEqual([
        'shell',
        false,
        true,
        undefined,
      ])
      await seen.exited
      expect(
        seen.events.map((event) =>
          event.type === 'process_output' ? [event.stream, text(event.bytes)] : event.exit
        )
      ).toEqual([['stdout', 'hello '], ['stderr', 'world'], { code: 7 }])
      expect(seen.events.every((event) => event.process === child)).toBe(true)
      expect(child.exit).toEqual({ code: 7 })
      expect(child.active).toBe(true)
      expect(requests(directory, 'spawn_process')[0]?.['launch']).toEqual({
        executable: 'shell',
        args: ['-c', 'echo hi'],
        env: { LANG: 'C.UTF-8' },
      })
      expect(
        requests(directory, 'acknowledge_process_output').map((item) => item['chunk'])
      ).toEqual([1, 2])
      await child.release()
      await child.release()
      expect(child.active).toBe(false)
      expect(requests(directory, 'release_process')).toHaveLength(1)
    })
  })

  test('a pending callback withholds its acknowledgement', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Backpressure' })
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const seen: string[] = []
      await window.spawnProcess('shell', { terminal: { columns: 80, rows: 24 } }, async (event) => {
        if (event.type !== 'process_output') return
        seen.push(event.stream)
        await gate
      })
      await until(() => seen.length === 1)
      expect(seen).toEqual(['terminal'])
      expect(requests(directory, 'acknowledge_process_output')).toEqual([])
      release()
      await until(() => seen.length === 2)
      expect(seen).toEqual(['terminal', 'terminal'])
      await until(() => requests(directory, 'acknowledge_process_output').length === 2)
      expect(
        requests(directory, 'acknowledge_process_output').map((item) => item['chunk'])
      ).toEqual([1, 2])
    })
  })

  test('input, resize, signals and a grant directory map to explicit requests', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Controls' })
      const grant = await window.openFileGrant('work')
      const echoes: string[] = []
      const child = await window.spawnProcess(
        'shell',
        { cwd: { grant, path: 'src' }, terminal: { columns: 80, rows: 24 } },
        (event) => {
          if (event.type === 'process_output') echoes.push(text(event.bytes))
        }
      )
      await child.write(new TextEncoder().encode('ls\n'))
      await child.resize({ columns: 100, rows: 30 })
      await child.signal('interrupt')
      await child.closeInput()
      await until(() => echoes.length === 1)
      expect(echoes).toEqual(['echo'])
      expect(requests(directory, 'spawn_process')[0]?.['launch']).toEqual({
        executable: 'shell',
        args: [],
        env: {},
        cwd: { grant_id: 1, path: 'src' },
        terminal: { columns: 80, rows: 24 },
      })
      expect(requests(directory, 'write_process')[0]?.['data']).toBe('bHMK')
      expect(requests(directory, 'resize_process')[0]?.['size']).toEqual({ columns: 100, rows: 30 })
      expect(requests(directory, 'signal_process')[0]?.['signal']).toBe('interrupt')
      expect(requests(directory, 'close_process_input')).toHaveLength(1)
    }, 'quiet')
  })

  test('invalid launches and calls fail before any native request', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Invalid' })
      const other = await app.openWindow({ title: 'Other' })
      const foreign = await other.openFileGrant('work')
      const listener = () => {}
      for (const [executable, options] of [
        ['/bin/sh', {}],
        ['Shell', {}],
        ['shell', { args: 'echo hi' }],
        ['shell', { args: ['a\0b'] }],
        ['shell', { args: Array.from({ length: 65 }, () => 'a') }],
        ['shell', { env: { '1A': 'x' } }],
        ['shell', { env: { A: 1 } }],
        ['shell', { terminal: { columns: 0, rows: 24 } }],
        ['shell', { cwd: { grant: foreign, path: 'a' } }],
        ['shell', { cwd: '/tmp' }],
        ['shell', { command: 'echo hi' }],
      ] as const)
        await expect(window.spawnProcess(executable, options as never, listener)).rejects.toThrow(
          TypeError
        )
      await expect(window.spawnProcess('shell', {}, 'listener' as never)).rejects.toThrow(TypeError)
      expect(requests(directory, 'spawn_process')).toEqual([])
      const child = await window.spawnProcess('shell', {}, listener)
      await expect(child.write(new Uint8Array(16_385))).rejects.toThrow(TypeError)
      await expect(child.write(new Uint8Array())).rejects.toThrow(TypeError)
      await expect(child.write('text' as never)).rejects.toThrow(TypeError)
      await expect(child.signal('stop' as never)).rejects.toThrow(TypeError)
      await expect(child.resize({ columns: 1001, rows: 1 })).rejects.toThrow(TypeError)
      expect(requests(directory, 'write_process')).toEqual([])
      expect(requests(directory, 'signal_process')).toEqual([])
      expect(requests(directory, 'resize_process')).toEqual([])
    }, 'quiet')
  })

  test('release and window close stop delivery; close needs no release request', async () => {
    await withProcesses(async (app, directory) => {
      const window = await app.openWindow({ title: 'Release' })
      const child = await window.spawnProcess('shell', {}, () => {})
      await child.release()
      const released = (await child
        .write(new Uint8Array([1]))
        .catch((error: unknown) => error)) as NativeServiceError
      expect([released.service, released.code]).toEqual(['processes', 'cancelled'])
      const owned = await window.spawnProcess('tool', {}, () => {})
      await window.close()
      expect(owned.active).toBe(false)
      expect(requests(directory, 'release_process')).toHaveLength(1)
    }, 'quiet')
  })

  test('typed errors from the host map to the processes service', async () => {
    await withProcesses(async (app) => {
      const window = await app.openWindow({ title: 'Missing' })
      const error = (await window
        .spawnProcess('shell', {}, () => {})
        .catch((cause: unknown) => cause)) as NativeServiceError
      expect(error).toBeInstanceOf(NativeServiceError)
      expect([error.service, error.code]).toEqual(['processes', 'not_found'])
    }, 'missing')
  })

  for (const mode of ['reorder', 'after-exit'])
    test(`${mode} output fails the channel`, async () => {
      await withProcesses(async (app) => {
        const window = await app.openWindow({ title: mode })
        await window.spawnProcess('shell', {}, () => {}).catch(() => {})
        await expect(app.closed).rejects.toBeInstanceOf(ProtocolError)
      }, mode)
    })

  test('targets without process support report the service unavailable', async () => {
    await withProcesses(async (app) => {
      expect(app.serviceCapabilities.ptyProcess).toEqual({
        availability: 'unavailable',
        reason: 'unsupported_platform',
      })
      const window = await app.openWindow({ title: 'Unavailable' })
      const error = (await window
        .spawnProcess('shell', {}, () => {})
        .catch((cause: unknown) => cause)) as NativeServiceError
      expect([error.service, error.code]).toEqual(['processes', 'service_unavailable'])
    }, 'unavailable')
  })
})
