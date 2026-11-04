import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  type NativeApplication,
  type ServicePermissions,
} from '@bun-native/core'
import { NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function withService(
  run: (app: NativeApplication, directory: string) => Promise<void>,
  mode = 'normal',
  permissions?: ServicePermissions
) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-service-'))
  let app: NativeApplication | undefined
  try {
    app = await createApplication({
      executable: process.execPath,
      args: [resolve(import.meta.dir, 'services-peer.ts'), directory, mode],
      requestTimeoutMs: 2_000,
      ...(permissions ? { permissions } : {}),
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

async function received(directory: string) {
  const deadline = performance.now() + 2_000
  while (!existsSync(join(directory, 'received'))) {
    if (performance.now() >= deadline) throw new Error('Service request did not reach its peer')
    await Bun.sleep(5)
  }
}

function requests(directory: string) {
  return readFileSync(join(directory, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string })
    .filter((item) => item.type === 'display_snapshot')
}

describe('owned desktop service lifecycle (headless subprocess)', () => {
  test('invalid launch grants and reserved arguments fail before a native process can start', async () => {
    const executable = resolve(import.meta.dir, 'service-policy-must-not-start')
    for (const permissions of [
      null,
      [],
      'allow',
      { windowDisplay: true },
      { windowDisplay: undefined },
      { windowDisplay: 'ask' },
      { clipboardText: 'allow' },
    ])
      await assert.rejects(
        NativeHost.launch({ executable, permissions: permissions as never }),
        TypeError
      )
    for (const argument of ['--bun-native-allow-window-display', '--bun-native-allow-clipboard', 1])
      await assert.rejects(
        NativeHost.launch({ executable, args: [argument] as never }),
        /reserved for the explicit permissions option/
      )
  })

  test('default deny is reported by the native peer, not replaced with fabricated data', () =>
    withService(async (app, directory) => {
      expect(app.serviceCapabilities.windowDisplay).toEqual({
        availability: 'available',
        permission: 'deny',
        scope: 'owned_window',
      })
      for (const [name, value] of Object.entries(app.serviceCapabilities)) {
        expect(Object.isFrozen(value)).toBe(true)
        if (name === 'clipboardText')
          expect(value).toEqual({ availability: 'unavailable', reason: 'unsupported_platform' })
        else if (name !== 'windowDisplay')
          expect(value).toEqual({ availability: 'unavailable', reason: 'not_implemented' })
      }
      const window = await app.openWindow({ title: 'Denied service' })
      await assert.rejects(window.displaySnapshot(), {
        name: 'NativeServiceError',
        code: 'permission_denied',
        service: 'window_display',
      })
      expect(requests(directory)).toHaveLength(1)
      await window.batch((batch) =>
        batch.append(window.root, batch.create({ kind: 'text', text: 'Session remains usable' }))
      )
    }))

  test('an explicit grant returns an immutable, window-scoped snapshot', () =>
    withService(
      async (app) => {
        expect(app.serviceCapabilities.windowDisplay.permission).toBe('allow')
        const window = await app.openWindow({ title: 'Display service' })
        const snapshot = await window.displaySnapshot()
        expect(snapshot).toEqual({
          bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1.5,
        })
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.bounds)).toBe(true)
      },
      'normal',
      { windowDisplay: 'allow' }
    ))

  test('already-aborted and queued-aborted reads never cross the native boundary', () =>
    withService(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'Cancelled reads' })
        const already = AbortSignal.abort()
        await assert.rejects(window.displaySnapshot({ signal: already }), NativeServiceError)
        const cancellation = new AbortController()
        const queued = window.displaySnapshot({ signal: cancellation.signal })
        cancellation.abort()
        await assert.rejects(queued, { code: 'cancelled' })
        expect(requests(directory)).toHaveLength(0)
      },
      'normal',
      { windowDisplay: 'allow' }
    ))

  test('a cancelled in-flight read is drained without delivering data or poisoning the next read', () =>
    withService(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'In-flight cancellation' })
        const cancellation = new AbortController()
        const pending = window.displaySnapshot({ signal: cancellation.signal })
        const rejected = assert.rejects(pending, { code: 'cancelled' })
        await received(directory)
        cancellation.abort()
        writeFileSync(join(directory, 'release'), '')
        await rejected
        expect((await window.displaySnapshot()).scaleFactor).toBe(1.5)
        expect(requests(directory)).toHaveLength(2)
      },
      'hold',
      { windowDisplay: 'allow' }
    ))

  test('window close revokes an in-flight response and stale handles cannot submit another read', () =>
    withService(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'Owned service lifetime' })
        const pending = window.displaySnapshot()
        const rejected = assert.rejects(pending, NativeStateError)
        await received(directory)
        const closing = window.close()
        writeFileSync(join(directory, 'release'), '')
        await rejected
        await closing
        await assert.rejects(window.displaySnapshot(), { code: 'invalid_handle' })
        expect(requests(directory)).toHaveLength(1)
      },
      'hold',
      { windowDisplay: 'allow' }
    ))

  test('shutdown withholds a late service result and drains every owned transaction', () =>
    withService(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'Shutdown service lifetime' })
        const pending = window.displaySnapshot()
        const rejected = assert.rejects(pending, { code: 'invalid_handle' })
        await received(directory)
        const stopping = app.shutdown()
        writeFileSync(join(directory, 'release'), '')
        await rejected
        await stopping
        await app.closed
        await assert.rejects(app.openWindow({ title: 'Too late' }), {
          code: 'invalid_state',
        })
      },
      'hold',
      { windowDisplay: 'allow' }
    ))

  test('platform unavailability is typed and does not silently substitute another result', () =>
    withService(
      async (app) => {
        const window = await app.openWindow({ title: 'Unavailable display' })
        await assert.rejects(window.displaySnapshot(), {
          code: 'service_unavailable',
          service: 'window_display',
        })
      },
      'unavailable',
      { windowDisplay: 'allow' }
    ))

  test('wrong-window responses terminate the private channel instead of exposing data', () =>
    withService(
      async (app) => {
        const window = await app.openWindow({ title: 'Wrong service owner' })
        await assert.rejects(window.displaySnapshot(), ProtocolError)
        await assert.rejects(app.closed, ProtocolError)
      },
      'wrong-owner',
      { windowDisplay: 'allow' }
    ))

  test('cancellation cannot conceal a malformed in-flight native response', () =>
    withService(
      async (app, directory) => {
        const window = await app.openWindow({ title: 'Cancelled malformed response' })
        const cancellation = new AbortController()
        const pending = window.displaySnapshot({ signal: cancellation.signal })
        const rejected = assert.rejects(pending, ProtocolError)
        await received(directory)
        cancellation.abort()
        writeFileSync(join(directory, 'release'), '')
        await rejected
        await assert.rejects(app.closed, ProtocolError)
      },
      'hold-wrong-owner',
      { windowDisplay: 'allow' }
    ))

  test.each(['wrong-policy', 'missing-service'])(
    'rejects incompatible native readiness: %s',
    async (mode) => {
      await assert.rejects(
        withService(async () => {
          throw new Error('Invalid host was exposed')
        }, mode),
        ProtocolError
      )
    }
  )

  test('JavaScript cannot self-grant through per-request options or a fake AbortSignal', () =>
    withService(async (app, directory) => {
      const window = await app.openWindow({ title: 'Strict service options' })
      await assert.rejects(window.displaySnapshot({ grant: true } as never), TypeError)
      await assert.rejects(
        window.displaySnapshot({ signal: { aborted: false } } as never),
        TypeError
      )
      expect(requests(directory)).toHaveLength(0)
    }))
})
