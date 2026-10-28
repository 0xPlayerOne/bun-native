import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import {
  BunTerminalDriver,
  TerminalService,
  type TerminalDriver,
  type TerminalDriverObserver,
  type TerminalDriverSpawnOptions,
} from '../packages/runtime/src/terminal.ts'
import { QualificationTerminal } from '../benchmarks/pty/terminal-consumer.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

class TerminalWriter implements BinaryStreamWriter {
  readonly outcome = deferred<StreamOutcome>()
  readonly finished = this.outcome.promise
  readonly hash = createHash('sha256')
  readonly records: Record<string, unknown>[] = []
  readonly waiters = new Map<string, ReturnType<typeof deferred<Record<string, unknown>>>>()
  readonly terminal = new QualificationTerminal((record) => {
    this.records.push(record)
    this.waiters.get(String(record['type']))?.resolve(record)
  })
  bytes = 0
  async write(chunk: Uint8Array) {
    await this.terminal.consume(chunk)
    this.hash.update(chunk)
    this.bytes += chunk.byteLength
  }
  async end() {
    this.outcome.resolve({ ok: true })
  }
  cancel() {
    this.outcome.resolve({ ok: false, code: 'CANCELLED' })
  }
  wait(type: string) {
    const existing = this.records.find((record) => record['type'] === type)
    if (existing) return Promise.resolve(existing)
    const waiter = deferred<Record<string, unknown>>()
    this.waiters.set(type, waiter)
    return waiter.promise
  }
  dispose() {
    this.terminal.dispose()
  }
}

class CapturingDriver implements TerminalDriver {
  readonly delegate = new BunTerminalDriver()
  readonly hash = createHash('sha256')
  bytes = 0
  spawn(options: TerminalDriverSpawnOptions, observer: TerminalDriverObserver) {
    return this.delegate.spawn(options, {
      ...observer,
      output: (chunk) => {
        this.hash.update(chunk)
        this.bytes += chunk.byteLength
        observer.output(chunk)
      },
    })
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const child = fileURLToPath(new URL('./fixtures/terminal-service-child.ts', import.meta.url))
const options = {
  executable: process.execPath,
  cwd: root,
  argv: [child],
  env: { BUNLY_TERMINAL_FIXTURE: 'fixed-repo-child' },
  cols: 100,
  rows: 30,
}
const input = (value: string) => new TextEncoder().encode(value + '\n')

const pinnedRuntimeTest = test.skipIf(Bun.version !== '1.4.3')
pinnedRuntimeTest(
  'real pinned Bun terminal service exercises input, resize, binary output, exit and close',
  async () => {
    expect(Bun.version).toBe('1.4.3')
    const driver = new CapturingDriver()
    const service = new TerminalService({ driver })
    const writer = new TerminalWriter()
    try {
      const handle = await service.create({}, writer, options)
      const observation = service.observe(handle)
      expect(await writer.wait('ready')).toMatchObject({
        tty: true,
        token: 'fixed-repo-child',
        inheritedSentinel: null,
      })
      const encoded = Buffer.from('owned café-🐙').toString('base64')
      await service.write(handle, input(`input:${encoded}`))
      expect(await writer.wait('input')).toMatchObject({ value: 'owned café-🐙' })

      writer.terminal.resize(110, 37)
      service.resize(handle, 110, 37)
      await service.write(handle, input('size'))
      expect(await writer.wait('size')).toMatchObject({ cols: 110, rows: 37 })
      await service.write(handle, input('binary'))
      await writer.wait('binary-complete')
      await service.write(handle, input('exit'))

      expect(await observation.processExited).toMatchObject({ started: true, exitCode: 7 })
      const closure = await observation.terminalClosed
      expect(closure.status === 0 || (process.platform === 'linux' && closure.status === 1)).toBe(
        true
      )
      expect(await observation.outputFinished).toEqual({ ok: true })
      await observation.released
      expect(await writer.wait('final')).toMatchObject({ type: 'final' })
      expect(driver.bytes).toBe(writer.bytes)
      expect(driver.hash.digest('hex')).toBe(writer.hash.digest('hex'))
      expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })

      const closingWriter = new TerminalWriter()
      const closingService = new TerminalService({ driver: new CapturingDriver() })
      try {
        const closing = await closingService.create({}, closingWriter, options)
        await closingWriter.wait('ready')
        const closingObservation = closingService.observe(closing)
        const result = await closingService.close(closing)
        expect(result).toEqual({
          processExited: true,
          terminalClosed: true,
          outputDrained: true,
          released: true,
        })
        expect(await closingObservation.outputFinished).toEqual({ ok: false, code: 'CANCELLED' })
        expect((await closingObservation.processExited).exitCode).not.toBe(0)
      } finally {
        await closingService.dispose()
        closingWriter.dispose()
      }
    } finally {
      await service.dispose()
      writer.dispose()
    }
  },
  20_000
)
