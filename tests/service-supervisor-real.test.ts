import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import {
  BunTerminalDriver,
  TerminalService,
  type TerminalDriverObserver,
  type TerminalDriverSpawnOptions,
} from '../packages/runtime/src/terminal.ts'
import {
  ServiceSupervisor,
  type ServiceSnapshot,
} from '../packages/runtime/src/service-supervisor.ts'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
class Consumer implements BinaryStreamWriter {
  outcome = deferred<StreamOutcome>()
  finished = this.outcome.promise
  ready = deferred<boolean>()
  hash = createHash('sha256')
  bytes = 0
  text = ''
  async write(chunk: Uint8Array) {
    this.bytes += chunk.length
    if (this.bytes > 4096) throw new Error('Fixture consumer bound exceeded')
    this.hash.update(chunk)
    this.text += new TextDecoder().decode(chunk)
    if (this.text.includes(':ready')) this.ready.resolve(true)
  }
  async end() {
    this.outcome.resolve({ ok: true })
  }
  cancel() {
    this.outcome.resolve({ ok: false, code: 'CANCELLED' })
    this.ready.resolve(false)
  }
}
const child = fileURLToPath(new URL('./fixtures/service-supervisor-child.ts', import.meta.url))
const launch = (mode: string) => ({
  executable: process.execPath,
  cwd: import.meta.dir,
  argv: [child, mode],
  env: { BUNLY_SERVICE_FIXTURE: 'fixed-owned-service' },
  maxOutputBytes: 16 * 1024,
})
const finish = new TextEncoder().encode('finish\n')
const pinnedRuntimeTest = test.skipIf(Bun.version !== '1.4.3')
pinnedRuntimeTest(
  'pinned real PTYs restart failing generations only after exact output and release, preserving unrelated child',
  async () => {
    expect(Bun.version).toBe('1.4.3')
    const delegate = new BunTerminalDriver()
    const captures: { hash: ReturnType<typeof createHash>; bytes: number }[] = []
    const service = new TerminalService({
      driver: {
        spawn(options: TerminalDriverSpawnOptions, observer: TerminalDriverObserver) {
          const capture = { hash: createHash('sha256'), bytes: 0 }
          captures.push(capture)
          return delegate.spawn(options, {
            ...observer,
            output(bytes) {
              capture.hash.update(bytes)
              capture.bytes += bytes.length
              observer.output(bytes)
            },
          })
        },
      },
    })
    const unrelatedWriter = new Consumer()
    const unrelated = await service.create({}, unrelatedWriter, launch('unrelated'))
    const unrelatedObservation = service.observe(unrelated)
    await unrelatedWriter.ready.promise
    const writers: Consumer[] = [],
      failures: ServiceSnapshot[] = []
    const owner = {}
    let disposals = 0
    const supervisor = new ServiceSupervisor({
      service,
      owner,
      launch: launch('fail'),
      startupTimeoutMs: 5000,
      restart: {
        mode: 'on-failure',
        maxAttempts: 3,
        initialBackoffMs: 5,
        maxBackoffMs: 10,
        totalBudgetMs: 10_000,
      },
      createOutput() {
        expect(service.diagnostics(owner).terminals).toBe(0)
        expect(disposals).toBe(writers.length)
        const writer = new Consumer()
        writers.push(writer)
        return {
          writer,
          dispose() {
            disposals++
          },
        }
      },
      readiness: () => writers.at(-1)!.ready.promise,
      async onChange(snapshot) {
        if (snapshot.state === 'ready') {
          // Split the input deliberately: readiness cannot depend on callback framing.
          await supervisor.write(snapshot.generation!, finish.subarray(0, 3))
          await supervisor.write(snapshot.generation!, finish.subarray(3))
        }
        if (snapshot.state === 'backoff' || snapshot.failure === 'ATTEMPTS_EXHAUSTED')
          failures.push(snapshot)
      },
    })
    try {
      supervisor.start()
      await supervisor.settled
      expect(supervisor.snapshot).toMatchObject({
        state: 'failed',
        attempts: 3,
        failure: 'ATTEMPTS_EXHAUSTED',
        cleanupPending: false,
      })
      expect(disposals).toBe(3)
      expect(failures.length).toBe(3)
      expect(new Set(failures.map((s) => s.generation)).size).toBe(3)
      for (let i = 0; i < 3; i++) {
        const snapshot = failures[i]!,
          writer = writers[i]!,
          capture = captures[i + 1]!
        expect(snapshot.exit).toEqual({
          started: true,
          observed: true,
          exitCode: 7,
          signalCode: null,
          waitError: false,
          failure: null,
        })
        expect(snapshot.terminal).toMatchObject({ observed: true, failure: null })
        expect(
          snapshot.terminal!.status === 0 ||
            (process.platform === 'linux' && snapshot.terminal!.status === 1)
        ).toBe(true)
        expect(snapshot.output).toEqual({ ok: true })
        expect(writer.text).toContain('service:fail:ready')
        expect(writer.text).toContain('service:fail:final')
        expect(writer.bytes).toBe(capture.bytes)
        expect(writer.hash.digest('hex')).toBe(capture.hash.digest('hex'))
      }
      expect(service.diagnostics()).toMatchObject({ terminals: 1, sourceStreams: 1 })
      await service.write(unrelated, finish)
      expect(await unrelatedObservation.processExited).toMatchObject({
        exitCode: 0,
        signalCode: null,
        observed: true,
      })
      expect(await unrelatedObservation.outputFinished).toEqual({ ok: true })
      await unrelatedObservation.released
      expect(unrelatedWriter.text).toContain('service:unrelated:final')
      expect(unrelatedWriter.hash.digest('hex')).toBe(captures[0]!.hash.digest('hex'))
      expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
      expect(supervisor.diagnostics()).toMatchObject({
        timer: 0,
        activeGenerations: 0,
        observerCalls: 0,
      })
    } finally {
      supervisor.dispose()
      await service.dispose()
    }
  },
  20_000
)

pinnedRuntimeTest(
  'real explicit service stop reports platform true exit and never restarts',
  async () => {
    const service = new TerminalService(),
      writer = new Consumer(),
      ready = deferred<void>()
    const supervisor = new ServiceSupervisor({
      service,
      owner: {},
      launch: launch('stop'),
      restart: {
        mode: 'on-failure',
        maxAttempts: 3,
        initialBackoffMs: 5,
        maxBackoffMs: 10,
        totalBudgetMs: 10_000,
      },
      createOutput: () => ({ writer, dispose() {} }),
      readiness: () => writer.ready.promise,
      onChange(snapshot) {
        if (snapshot.state === 'ready') ready.resolve()
      },
    })
    try {
      supervisor.start()
      await ready.promise
      supervisor.stop()
      await supervisor.settled
      expect(supervisor.snapshot).toMatchObject({
        state: 'stopped',
        attempts: 1,
        cleanupPending: false,
        output: { ok: false, code: 'CANCELLED' },
      })
      const exit = supervisor.snapshot.exit!
      expect(exit.observed).toBe(true)
      expect(exit.waitError).toBe(false)
      // Preserve the pinned Bun callback, including its Windows SIGTERM label.
      // That label is not a claim that Windows delivered a POSIX signal.
      expect(exit.exitCode).not.toBe(0)
      expect(exit.signalCode).toBe('SIGTERM')
      expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
    } finally {
      supervisor.dispose()
      await service.dispose()
    }
  },
  10_000
)
