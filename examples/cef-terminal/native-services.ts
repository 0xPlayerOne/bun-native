/** Exact installed guardian + TerminalService + ServiceSupervisor integration.
 * Not another process supervisor or backend generation replacement mechanism. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { BinaryStreamWriter, StreamOutcome } from '../../packages/contracts/src/streams.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { TerminalService, type TerminalProcessExit } from '../../packages/runtime/src/terminal.ts'
import {
  ServiceSupervisor,
  type ServiceGeneration,
} from '../../packages/runtime/src/service-supervisor.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
class Consumer implements BinaryStreamWriter {
  readonly outcome = deferred<StreamOutcome>()
  readonly finished = this.outcome.promise
  readonly ready = deferred<boolean>()
  readonly hash = createHash('sha256')
  readonly decoder = new TextDecoder('utf-8', { fatal: true })
  bytes = 0
  text = ''
  async write(chunk: Uint8Array) {
    assert.ok(this.bytes + chunk.length <= 4096, 'Bounded service fixture output')
    this.bytes += chunk.length
    this.hash.update(chunk)
    this.text += this.decoder.decode(chunk, { stream: true })
    if (this.text.includes(':ready')) this.ready.resolve(true)
  }
  async end() {
    this.text += this.decoder.decode()
    this.outcome.resolve({ ok: true })
  }
  cancel() {
    this.outcome.resolve({ ok: false, code: 'CANCELLED' })
    this.ready.resolve(false)
  }
}

export async function qualifyNativeServices(backend: CefBackend) {
  const delegate = await backend.createTerminalDriver({ profile: 'non-detaching' })
  type Capture = {
    hash: ReturnType<typeof createHash>
    bytes: number
    exit?: Pick<TerminalProcessExit, 'exitCode' | 'signalCode' | 'waitError'>
    terminalStatus?: number
  }
  const captures: Capture[] = []
  const service = new TerminalService({
    driver: {
      spawn(options, observer) {
        assert.ok(captures.length < 5, 'Bounded native service launches')
        const capture: Capture = { hash: createHash('sha256'), bytes: 0 }
        captures.push(capture)
        return delegate.spawn(options, {
          ...observer,
          terminalClosed(status) {
            capture.terminalStatus = status
            observer.terminalClosed(status)
          },
          processExited(exit) {
            capture.exit = { ...exit }
            observer.processExited(exit)
          },
          output(bytes) {
            capture.hash.update(bytes)
            capture.bytes += bytes.length
            observer.output(bytes)
          },
        })
      },
    },
    limits: {
      maxTerminals: 2,
      maxTerminalsPerOwner: 1,
      maxOutputBytes: 32 * 1024,
      maxOutputBytesPerOwner: 16 * 1024,
      maxOutputBytesPerTerminal: 16 * 1024,
    },
  })
  const child = fileURLToPath(new URL('./service-child.js', import.meta.url))
  const launch = (mode: string) => ({
    executable: process.execPath,
    argv: [child, mode],
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { BUNLY_SERVICE_FIXTURE: 'fixed-owned-service' },
    maxOutputBytes: 16 * 1024,
  })
  const finish = new TextEncoder().encode('finish\n')
  const unrelatedWriter = new Consumer()
  const unrelated = await service.create({}, unrelatedWriter, launch('unrelated'))
  const unrelatedObservation = service.observe(unrelated)
  const writers: Consumer[] = [],
    identities: ServiceGeneration[] = []
  const sent = new Set<ServiceGeneration>()
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
    createOutput(context) {
      assert.equal(service.diagnostics(owner).terminals, 0)
      identities.push(context.generation)
      assert.equal(disposals, writers.length)
      const writer = new Consumer()
      writers.push(writer)
      return {
        writer,
        async dispose() {
          assert.equal(service.diagnostics(owner).terminals, 0)
          assert.deepEqual(await writer.finished, { ok: true })
          disposals++
        },
      }
    },
    readiness: () => writers.at(-1)!.ready.promise,
    async onChange(snapshot) {
      if (snapshot.state === 'ready') {
        assert.ok(snapshot.generation && !sent.has(snapshot.generation))
        sent.add(snapshot.generation)
        await supervisor.write(snapshot.generation!, finish.subarray(0, 3))
        await supervisor.write(snapshot.generation!, finish.subarray(3))
      }
    },
  })
  let stopped: ServiceSupervisor | undefined
  try {
    assert.equal(await unrelatedWriter.ready.promise, true)
    supervisor.start()
    await supervisor.settled
    assert.equal(supervisor.snapshot.state, 'failed')
    assert.equal(supervisor.snapshot.failure, 'ATTEMPTS_EXHAUSTED')
    assert.equal(supervisor.snapshot.cleanupPending, false)
    assert.equal(supervisor.snapshot.attempts, 3)
    assert.equal(disposals, 3)
    assert.equal(identities.length, 3)
    assert.equal(new Set(identities).size, 3)
    assert.equal(sent.size, 3)
    const generations = writers.map((writer, index) => {
      const capture = captures[index + 1]!
      assert.deepEqual(capture.exit, { exitCode: 7, signalCode: null, waitError: false })
      assert.ok(
        capture.terminalStatus === 0 ||
          (process.platform === 'linux' && capture.terminalStatus === 1)
      )
      assert.ok(
        writer.text.includes('service:fail:ready') && writer.text.includes('service:fail:final')
      )
      assert.equal(writer.bytes, capture.bytes)
      const sha256 = writer.hash.digest('hex')
      assert.equal(sha256, capture.hash.digest('hex'))
      return {
        attempt: index + 1,
        exitCode: 7,
        callbackBytes: capture.bytes,
        consumedBytes: writer.bytes,
        sha256,
        terminalStatus: capture.terminalStatus,
        outputDrained: true,
        disposedBeforeReplacement: true,
      }
    })
    assert.equal(service.diagnostics().terminals, 1)
    const stale = identities[0]!
    await assert.rejects(supervisor.write(stale, finish))
    assert.equal(captures.length, 4, 'Stale request must not launch or replay work')
    await service.write(unrelated, finish)
    assert.equal((await unrelatedObservation.processExited).exitCode, 0)
    assert.deepEqual(await unrelatedObservation.outputFinished, { ok: true })
    await unrelatedObservation.released
    assert.ok(unrelatedWriter.text.includes('service:unrelated:final'))
    assert.equal(unrelatedWriter.hash.digest('hex'), captures[0]!.hash.digest('hex'))
    assert.equal(service.diagnostics().terminals, 0)
    assert.equal(supervisor.diagnostics().timer, 0)
    assert.equal(supervisor.diagnostics().activeGenerations, 0)
    assert.equal(supervisor.diagnostics().observerCalls, 0)
    assert.equal(supervisor.diagnostics().observerFailures, 0)

    const stopWriter = new Consumer(),
      stopReady = deferred<void>()
    stopped = new ServiceSupervisor({
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
      createOutput: () => ({ writer: stopWriter, dispose() {} }),
      readiness: () => stopWriter.ready.promise,
      onChange(snapshot) {
        if (snapshot.state === 'ready') stopReady.resolve()
      },
    })
    stopped.start()
    await stopReady.promise
    stopped.stop()
    await stopped.settled
    assert.equal(stopped.snapshot.state, 'stopped')
    assert.equal(stopped.snapshot.attempts, 1)
    assert.equal(stopped.snapshot.cleanupPending, false)
    assert.deepEqual(stopped.snapshot.output, { ok: false, code: 'CANCELLED' })
    const exit = stopped.snapshot.exit!
    assert.equal(exit.observed, true)
    assert.equal(exit.waitError, false)
    assert.equal(exit.failure, null)
    assert.ok(exit.exitCode !== 0)
    assert.equal(captures.length, 5)
    for (const field of [
      'terminals',
      'sourceStreams',
      'sourceReservedBytes',
      'reservedOutputBytes',
      'pendingDriverWrites',
      'driverFailures',
    ] as const)
      assert.equal(service.diagnostics()[field], 0)
    assert.equal(stopped.diagnostics().timer, 0)
    assert.equal(stopped.diagnostics().observerCalls, 0)
    assert.equal(stopped.diagnostics().observerFailures, 0)
    return {
      profile: 'native-non-detaching',
      generations,
      attemptsExhausted: true,
      staleGenerationRejected: true,
      unrelatedPreserved: true,
      explicitStop: {
        attempts: 1,
        observed: true,
        exitCode: exit.exitCode,
        signalCode: exit.signalCode,
        output: { ok: false, code: 'CANCELLED' },
        restarted: false,
      },
      finalResources: {
        terminals: 0,
        sourceStreams: 0,
        sourceReservedBytes: 0,
        timers: 0,
        observerCalls: 0,
      },
    }
  } finally {
    supervisor.dispose()
    stopped?.dispose()
    await service.dispose()
  }
}
