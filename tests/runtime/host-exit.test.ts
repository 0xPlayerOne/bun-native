import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MAX_DIAGNOSTIC_TAIL, NativeHost, NativeHostExitError } from '@bun-native/runtime'
import { resolve } from 'node:path'

// Crash qualification for #247: a native panic, abort or noisy failure must
// surface as one typed, bounded and redacted diagnostic, reject every waiter
// with that same error and reap the owned process.
const fixture = resolve(import.meta.dir, 'protocol-peer.ts')
const secret = 'bn-secret-' + crypto.randomUUID()
const open = {
  type: 'open',
  window_id: 1,
  root_id: 1,
  title: 'Crash',
  width: 320,
  height: 240,
} as const

beforeEach(() => {
  process.env['BUN_NATIVE_TEST_SECRET'] = secret
})
afterEach(() => {
  delete process.env['BUN_NATIVE_TEST_SECRET']
})

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  // Await the real operation; pinned Bun's .rejects matcher stalls Windows pipes.
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('Expected operation to reject')
}

async function crashDuringOpen(mode: string): Promise<{
  host: NativeHost
  error: NativeHostExitError
  iteratorError: Error
}> {
  const host = await NativeHost.launch({
    executable: process.execPath,
    args: [fixture, mode],
    requestTimeoutMs: 2_000,
  })
  const events = host[Symbol.asyncIterator]()
  const waiting = rejectedError(events.next())
  const error = await rejectedError(host.send(open))
  if (!(error instanceof NativeHostExitError))
    throw new Error(`Expected NativeHostExitError, got ${error.name}: ${error.message}`)
  const iteratorError = await waiting
  return { host, error, iteratorError }
}

function expectRedacted(error: NativeHostExitError): void {
  const serialized = JSON.stringify({
    message: error.message,
    ...error.diagnostic,
  })
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain('a1'.repeat(24))
  expect(serialized).not.toContain(process.execPath)
  expect(error.diagnostic.stderrTail.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TAIL)
  expect(error.diagnostic.stderrTail.split('\n').length).toBeLessThanOrEqual(32)
  expect(Object.isFrozen(error.diagnostic)).toBe(true)
}

describe('native host exit diagnostics (headless protocol peer)', () => {
  test('a Rust-shaped panic is typed, located, redacted and contained', async () => {
    const { host, error, iteratorError } = await crashDuringOpen('panic')
    expect(error.diagnostic).toMatchObject({
      reason: 'panic',
      exitCode: 101,
      signal: null,
      phase: 'running',
      pendingRequests: 1,
      panicLocation: 'native/gpui-host/src/session.rs:42:9',
      stderrTruncated: false,
    })
    expect(error.message).toStartWith('Native host exited unexpectedly (101). ')
    expect(error.diagnostic.stderrTail).toContain('window state corrupted')
    expect(error.diagnostic.stderrTail).toContain('BUN_NATIVE_TEST_SECRET=[redacted]')
    expect(error.diagnostic.stderrTail).toContain('authorization: [redacted]')
    expectRedacted(error)
    // Every waiter observes the same failure and the session stays closed.
    expect(iteratorError).toBe(error)
    expect(await rejectedError(host.send(open))).toBe(error)
    expect(await rejectedError(host.shutdown())).toBe(error)
    expect(await host.exited).toBe(101)
  })

  test('a signal-terminated host reports its signal without an exit code', async () => {
    const { host, error, iteratorError } = await crashDuringOpen('signal')
    expect(error.diagnostic).toMatchObject({
      reason: 'panic',
      // Windows has no POSIX signals; a forced termination is an exit code.
      ...(process.platform === 'win32' ? {} : { exitCode: null, signal: 'SIGKILL' }),
      phase: 'running',
      pendingRequests: 1,
      panicLocation: 'native/gpui-host/src/session.rs:42:9',
    })
    expectRedacted(error)
    expect(iteratorError).toBe(error)
    expect(await rejectedError(host.shutdown())).toBe(error)
    await host.exited
  })

  test('unbounded native output is clipped before it is redacted', async () => {
    const { host, error } = await crashDuringOpen('noisy-exit')
    expect(error.diagnostic).toMatchObject({
      reason: 'panic',
      exitCode: 3,
      signal: null,
      stderrTruncated: true,
    })
    expectRedacted(error)
    expect(error.diagnostic.stderrTail).not.toContain('noise')
    expect(await rejectedError(host.shutdown())).toBe(error)
    expect(await host.exited).toBe(3)
  })

  test('an exit during startup rejects launch with a startup-phase diagnostic', async () => {
    const error = await rejectedError(
      NativeHost.launch({
        executable: process.execPath,
        args: [fixture, 'exit'],
      })
    )
    expect(error).toBeInstanceOf(NativeHostExitError)
    expect((error as NativeHostExitError).diagnostic).toMatchObject({
      reason: 'exit',
      exitCode: 23,
      signal: null,
      phase: 'starting',
      pendingRequests: 1,
      panicLocation: null,
    })
  })

  // #584: Ctrl-C signals the terminal's foreground process group; only the
  // application should receive it, and it shuts the host down.
  test.skipIf(process.platform === 'win32')(
    "the host runs outside the application's process group",
    async () => {
      const host = await NativeHost.launch({
        executable: process.execPath,
        args: [fixture, 'ready'],
      })
      try {
        const group = (pid: number) =>
          Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)])
            .stdout.toString()
            .trim()
        const children = Bun.spawnSync([
          'pgrep',
          '-P',
          String(process.pid),
          '-f',
          'protocol-peer.ts ready',
        ])
          .stdout.toString()
          .split('\n')
          .filter(Boolean)
          .map(Number)
        const groups = children.map(group).filter(Boolean)
        expect(groups).toHaveLength(1)
        expect(groups).not.toContain(group(process.pid))
      } finally {
        await host.shutdown()
      }
      expect(await host.exited).toBe(0)
    }
  )
})
