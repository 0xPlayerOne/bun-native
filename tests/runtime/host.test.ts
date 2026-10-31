import { describe, expect, test } from 'bun:test'
import { NativeHost } from '@bun-native/runtime'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { trace } from './trace'

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

async function releasePipeHolder(directory: string): Promise<void> {
  trace('test', 'holder-release-requested', { directory })
  // Only this test's holder reads its private release file. The holder also has
  // a hard self-expiry; cleanup never signals an unrelated process.
  writeFileSync(join(directory, 'release'), '')
  if (!existsSync(join(directory, 'ready'))) return
  const finished = join(directory, 'finished')
  const until = performance.now() + 1_500
  while (!existsSync(finished) && performance.now() < until) await Bun.sleep(10)
  if (!existsSync(finished)) {
    const ownedPid = Number(readFileSync(join(directory, 'ready'), 'utf8'))
    let signalZero: unknown = 'alive'
    try {
      process.kill(ownedPid, 0)
    } catch (error) {
      signalZero = String(error)
    }
    trace('test', 'holder-release-failed', { directory, ownedPid, signalZero })
    if (process.platform === 'win32' && Number.isSafeInteger(ownedPid) && ownedPid > 0) {
      const result = Bun.spawnSync(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,HasExited | ConvertTo-Json -Compress`,
        ],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 }
      )
      trace('test', 'holder-os-status', {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      })
    }
    throw new Error('Test-owned pipe holder did not release')
  }
  trace('test', 'holder-released', { directory })
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
    trace('test', 'held-pipe-assertions-passed', { mode })
  } catch (error) {
    trace('test', 'held-pipe-assertion-failed', { mode, error: String(error) })
    throw error
  } finally {
    await releasePipeHolder(directory)
    if (host)
      await deadline(
        host.shutdown().catch(() => {}),
        'host cleanup'
      )
    rmSync(directory, { recursive: true, force: true })
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
    await expect(host.send({ type: 'close' })).rejects.toThrow('not running')
  })

  test('command rejection preserves the healthy session', async () => {
    trace('test', 'rejection-test-start', {})
    const host = await NativeHost.launch(options())
    try {
      await expect(host.send({ type: 'update', text: 'reject' })).rejects.toThrow('invalid_state')
      trace('test', 'rejection-observed', {})
      await host.send({ type: 'update', text: 'accepted' })
      trace('test', 'subsequent-update-accepted', {})
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

  test.each(['wrong-version', 'bad-json', 'wrong-id', 'wrong-ack', 'duplicate-ready', 'exit'])(
    'rejects and reaps a host with %s',
    async (mode) => {
      await expect(NativeHost.launch(options(mode))).rejects.toThrow()
    }
  )

  test('bounds startup when the native process stops responding', async () => {
    await expect(NativeHost.launch(options('silent', 100))).rejects.toThrow('timed out')
  })

  test('rejects invalid options before spawning', async () => {
    await expect(NativeHost.launch({ executable: 'relative' })).rejects.toThrow('absolute')
    await expect(NativeHost.launch(options('normal', 0))).rejects.toThrow('requestTimeoutMs')
  })

  test('bounds an unconsumed event flood and terminates the native process', async () => {
    const host = await NativeHost.launch(options('flood'))
    await host.send({ type: 'open', title: 'Test', text: '', input: '' })
    await host.exited
    await expect(host.shutdown()).rejects.toThrow('event limit')
  })

  test('bounds shutdown after native exit when inherited pipes stay open', async () => {
    await withPipeHolder('shutdown', async (host, finished) => {
      await expect(deadline(host.shutdown(), 'shutdown')).rejects.toThrow('Native')
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
      await expect(pending).rejects.toThrow('Native')
      expect(await host.exited).toBe(23)
      expect(existsSync(finished)).toBe(false)
    })
  })
})
