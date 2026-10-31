import { describe, expect, test } from 'bun:test'
import { ProtocolError } from '@bun-native/protocol'
import { NativeHost } from '@bun-native/runtime'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixture = resolve(import.meta.dir, 'protocol-peer.ts')
const options = (mode = 'normal', requestTimeoutMs = 1_000) => ({
  executable: process.execPath,
  args: [fixture, mode],
  requestTimeoutMs,
})

async function deadline<T>(operation: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test deadline exceeded: ${name}`)), 1_500)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  // Pinned Bun's .rejects matcher stalls Windows pipe callbacks while waiting.
  // Await the real operation before making synchronous assertions about it.
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('Expected operation to reject')
}

function holderIsAlive(directory: string): boolean {
  const ownedPid = Number(readFileSync(join(directory, 'ready'), 'utf8'))
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0)
    throw new Error('Invalid test-owned pipe holder PID')
  try {
    process.kill(ownedPid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function releasePipeHolder(directory: string): Promise<void> {
  // Only this test's holder reads its private release file. The holder also has
  // a hard self-expiry; cleanup never signals an unrelated process.
  writeFileSync(join(directory, 'release'), '')
  if (!existsSync(join(directory, 'ready'))) return
  const finished = join(directory, 'finished')
  const until = performance.now() + 1_500
  while (!existsSync(finished) && performance.now() < until) {
    if (!holderIsAlive(directory)) return
    await Bun.sleep(10)
  }
  if (!existsSync(finished)) throw new Error('Test-owned pipe holder did not release')
}

async function withPipeHolder(
  mode: 'shutdown' | 'exit',
  run: (host: NativeHost, finished: string) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-pipe-holder-'))
  const finished = join(directory, 'finished')
  let host: NativeHost | undefined
  try {
    host = await NativeHost.launch({
      ...options(`inherited-pipe-${mode}`, 300),
      args: [fixture, `inherited-pipe-${mode}`, directory],
    })
    await run(host, finished)
    // A terminated descendant cannot establish held-open-pipe coverage.
    expect(holderIsAlive(directory)).toBe(true)
  } finally {
    try {
      await releasePipeHolder(directory)
    } finally {
      try {
        if (host)
          await deadline(
            host.shutdown().catch(() => {}),
            'host cleanup'
          )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
}

describe('native process transport (headless protocol peer)', () => {
  test('negotiates, opens, updates, receives ordered events, closes and tears down', async () => {
    const host = await NativeHost.launch(options())
    const events = host[Symbol.asyncIterator]()
    try {
      await host.send({ type: 'open', title: 'Test', text: 'Hello', input: '世界' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'input', value: '世界' } })
      await host.send({ type: 'update', text: 'emit-click' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'click' } })
      await host.send({ type: 'close' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'closed' } })
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
    expect(await events.next()).toEqual({ done: true, value: undefined })
    await host.shutdown()
    expect((await rejectedError(host.send({ type: 'close' }))).message).toContain('not running')
  })

  test('command rejection preserves the healthy session', async () => {
    const host = await NativeHost.launch(options())
    try {
      const error = await rejectedError(host.send({ type: 'update', text: 'reject' }))
      expect(error.message).toContain('invalid_state')
      await host.send({ type: 'update', text: 'accepted' })
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
  })

  test('returning from the event iterator releases the owned native process', async () => {
    const host = await NativeHost.launch(options())
    const reader = host[Symbol.asyncIterator]()
    const waiting = reader.next()
    await reader.return?.()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(await host.exited).toBe(0)
    expect(() => host[Symbol.asyncIterator]()).toThrow('exactly one consumer')
  })

  test.each([
    ['wrong-version', 'Native protocol version mismatch'],
    ['bad-json', 'Invalid UTF-8 or JSON in native frame'],
    ['wrong-id', 'Unknown native response id'],
    ['wrong-ack', 'Native response type does not match its request'],
    ['duplicate-ready', 'Unexpected ready event'],
  ])('rejects and reaps a host with %s', async (mode, message) => {
    const error = await rejectedError(NativeHost.launch(options(mode)))
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.message).toBe(message)
  })

  test('rejects and reaps a host that exits during startup', async () => {
    const error = await rejectedError(NativeHost.launch(options('exit')))
    expect(error.message).toMatch(
      /^Native (output closed before shutdown|host exited unexpectedly \(23\))/
    )
  })

  test('bounds startup when the native process stops responding', async () => {
    const error = await rejectedError(NativeHost.launch(options('silent', 100)))
    expect(error.message).toBe('Native hello request 1 timed out')
  })

  test('rejects invalid options before spawning', async () => {
    const pathError = await rejectedError(NativeHost.launch({ executable: 'relative' }))
    expect(pathError.message).toContain('absolute')
    const timeoutError = await rejectedError(NativeHost.launch(options('normal', 0)))
    expect(timeoutError.message).toContain('requestTimeoutMs')
  })

  test('bounds an unconsumed event flood and terminates the native process', async () => {
    const host = await NativeHost.launch(options('flood'))
    await host.send({ type: 'open', title: 'Test', text: '', input: '' })
    await host.exited
    expect((await rejectedError(host.shutdown())).message).toBe('Native event limit exceeded')
  })

  test('bounds shutdown after native exit when inherited pipes stay open', async () => {
    await withPipeHolder('shutdown', async (host, finished) => {
      const error = await rejectedError(deadline(host.shutdown(), 'shutdown'))
      expect(error.message).toMatch(
        /^Native (host did not exit|output remained open after host exit)$/
      )
      expect(await host.exited).toBe(0)
      expect(existsSync(finished)).toBe(false)
    })
  })

  test('rejects a waiting iterator on unexpected exit despite inherited pipes', async () => {
    await withPipeHolder('exit', async (host, finished) => {
      const events = host[Symbol.asyncIterator]()
      const pending = deadline(events.next(), 'event after native exit')
      // The peer acknowledges this request before exiting. There is no pending
      // command timeout to rescue the event iterator when the process exits.
      await host.send({ type: 'update', text: 'exit-after-ack' })
      const error = await rejectedError(pending)
      expect(error.message).toBe('Native output remained open after host exit')
      expect(await host.exited).toBe(23)
      expect(existsSync(finished)).toBe(false)
    })
  })
})
