import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  acceptGraphicalTerminal,
  acceptNativeServices,
} from '../benchmarks/lib/cef-terminal-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

type MutableObservation = Omit<CommandObservation, 'stderr'> & {
  schema: 1
  stderr: string[]
}

const hash = (digit: string) => digit.repeat(64)

function serviceReceipt() {
  return {
    profile: 'native-non-detaching',
    generations: [1, 2, 3].map((attempt) => ({
      attempt,
      exitCode: 7,
      callbackBytes: 120,
      consumedBytes: 120,
      sha256: hash('a'),
      terminalStatus: 0,
      outputDrained: true,
      disposedBeforeReplacement: true,
    })),
    attemptsExhausted: true,
    staleGenerationRejected: true,
    unrelatedPreserved: true,
    explicitStop: {
      attempts: 1,
      observed: true,
      exitCode: null as number | null,
      signalCode: 15 as number | null,
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
}

function receipt() {
  const renderer = [0, 1].map((terminal) => {
    const records = terminal === 0 ? 37 : 38
    return {
      terminal,
      records,
      bytes: 1000 + terminal,
      sha256: hash(String(terminal + 1)),
      order: Array.from({ length: records }, (_, index) => index),
      callbacks: 2,
      callbackDurationsMs: [0.5, 1.25],
      unicodeObserved: true,
      recordContentsVerified: true,
    }
  })
  return {
    event: 'bunly.native.graphical-terminal',
    schema: 3,
    nativeServices: serviceReceipt(),
    classification: 'functional',
    renderer: {
      terminals: renderer,
      controlRoundtripsMs: [1, 2, 3, 4, 5, 6, 7, 8],
      heldConsumer: true,
      rpcWhileHeld: true,
      siblingWhileHeld: true,
      parserCallbacks: true,
      totalElapsedMs: 20,
    },
    runtime: {
      terminals: renderer.map((entry, index) => ({
        processExit: {
          started: true,
          observed: true,
          exitCode: 0,
          signalCode: null,
          waitError: false,
          failure: null,
        },
        terminalClose: {
          started: true,
          observed: true,
          status: index === 0 ? 0 : 1,
          failure: null,
        },
        terminalEof: index === 0 ? 'clean-status-0' : 'linux-status-1-ambiguous',
        output: { ok: true },
        released: true,
        callbackBytes: entry.bytes,
        callbackCount: entry.callbacks,
        callbackSha256: entry.sha256,
        streamWriteCount: entry.callbacks,
      })),
      navigation: {
        exactOwner: true,
        processExit: {
          started: true,
          observed: true,
          exitCode: null,
          signalCode: 9,
          waitError: false,
          failure: null,
        },
        terminalClose: { started: true, observed: true, status: 0, failure: null },
        output: { ok: false, code: 'CANCELLED' },
        released: true,
        siblingCompleted: true,
      },
      overload: {
        processExit: {
          started: true,
          observed: true,
          exitCode: null,
          signalCode: 9,
          waitError: false,
          failure: null,
        },
        terminalClose: { started: true, observed: true, status: 0, failure: null },
        output: { ok: false, code: 'OVERLOADED' },
        released: true,
        callbackBytes: 65536,
        callbackCount: 9,
      },
    },
    gates: ['consumer-0:held', 'consumer-0:release'],
    budgets: {
      terminal: {
        terminals: 0,
        reservedOutputBytes: 0,
        owners: 0,
        sourceReservedBytes: 0,
        sourceStreams: 0,
        spawning: 0,
        live: 0,
        closing: 0,
        pendingDriverWrites: 0,
        driverFailures: 0,
      },
      stream: { connections: 0, budget: { reservedBytes: 0, streams: 0, views: 0 } },
    },
    queuePeaks: { frames: 4, bytes: 32768 },
    nativeFinal: { windows: 1, views: 0, sessions: 0, streamIncomingBytes: 0 },
    viewModes: {
      foreground: 'visible-window-exercised',
      background: 'NOT_QUALIFIED-no-maintained-native-visibility-control',
      minimized: 'NOT_QUALIFIED-no-maintained-native-minimize-control',
    },
    baseline: 'NOT_CLAIMED-no-identical-baseline-workload',
  }
}

function observation(extra: unknown[] = []): MutableObservation {
  const events = [
    receipt(),
    { event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start' },
    { event: 'bunly.backend.exit', code: 0, forced: false },
    {
      event: 'bunly.native.output-drained',
      schema: 1,
      frames: 0,
      ordinaryFrames: 0,
      retainedWireBytes: 0,
      ordinaryWireBytes: 0,
    },
    { event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'complete', durationMs: 1 },
    ...['host-release', 'asset-service-stop', 'cef-shutdown'].flatMap((phase) => [
      { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
      { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: 1 },
    ]),
    { event: 'bunly.host.shutdown', clean: true },
    ...extra,
  ]
  return {
    schema: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cleanupSurvivors: [],
    outputOverflow: false,
    observedOrphans: [],
    elapsedMs: 25,
    peakTreeRssBytes: 1024,
    peakTreeThreads: 4,
    stdoutTail: [],
    stderr: events.map((event) => JSON.stringify(event)),
    samples: [],
    environment: { classification: 'synthetic-parser-input-not-native-evidence', os: 'Linux' },
  }
}

test('graphical terminal acceptance requires exact raw functional observations', () => {
  const accepted = acceptGraphicalTerminal(observation())
  assert.equal(accepted.bytes, 2001)
  assert.equal(accepted.callbacks, 4)
  assert.deepEqual(accepted.controlRoundtripsMs, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(accepted.consumerCallbackDurationsMs.length, 4)
})

test('graphical terminal acceptance rejects missing, duplicate, malformed and partial checksums', () => {
  const missing = observation()
  missing.stderr = missing.stderr.filter((line) => !line.includes('graphical-terminal'))
  assert.throws(() => acceptGraphicalTerminal(missing), /missing or duplicated/)
  assert.throws(() => acceptGraphicalTerminal(observation([receipt()])), /missing or duplicated/)
  for (const value of ['', 'a'.repeat(63), 'g'.repeat(64)]) {
    const changed = observation()
    const parsed = receipt()
    parsed.renderer.terminals[0]!.sha256 = value
    changed.stderr[changed.stderr.findIndex((line) => line.includes('graphical-terminal'))] =
      JSON.stringify(parsed)
    assert.throws(() => acceptGraphicalTerminal(changed), /checksum/)
  }
})

test('graphical terminal acceptance rejects false control, consumer, exit and release receipts', () => {
  for (const mutate of [
    (row: ReturnType<typeof receipt>) => (row.renderer.rpcWhileHeld = false),
    (row: ReturnType<typeof receipt>) =>
      (row.renderer.terminals[0]!.recordContentsVerified = false),
    (row: ReturnType<typeof receipt>) => (row.renderer.parserCallbacks = false),
    (row: ReturnType<typeof receipt>) => (row.runtime.terminals[0]!.processExit.observed = false),
    (row: ReturnType<typeof receipt>) => (row.runtime.terminals[1]!.released = false),
    (row: ReturnType<typeof receipt>) => (row.runtime.navigation.siblingCompleted = false),
    (row: ReturnType<typeof receipt>) => (row.runtime.overload.output = { ok: true } as never),
  ]) {
    const changed = observation()
    const parsed = receipt()
    mutate(parsed)
    changed.stderr[changed.stderr.findIndex((line) => line.includes('graphical-terminal'))] =
      JSON.stringify(parsed)
    assert.throws(() => acceptGraphicalTerminal(changed))
  }
})

test('graphical terminal acceptance rejects record gaps, byte divergence and nonzero final budgets', () => {
  for (const mutate of [
    (row: ReturnType<typeof receipt>) => row.renderer.terminals[0]!.order.pop(),
    (row: ReturnType<typeof receipt>) => row.renderer.terminals[1]!.order.splice(4, 1, 9),
    (row: ReturnType<typeof receipt>) => row.runtime.terminals[0]!.callbackBytes++,
    (row: ReturnType<typeof receipt>) => (row.runtime.terminals[1]!.callbackSha256 = hash('9')),
    (row: ReturnType<typeof receipt>) => row.budgets.terminal.sourceReservedBytes++,
    (row: ReturnType<typeof receipt>) =>
      ((row.budgets.stream as { budget: unknown }).budget = { reservedBytes: 0 }),
    (row: ReturnType<typeof receipt>) => row.nativeFinal.streamIncomingBytes++,
  ]) {
    const changed = observation()
    const parsed = receipt()
    mutate(parsed)
    changed.stderr[changed.stderr.findIndex((line) => line.includes('graphical-terminal'))] =
      JSON.stringify(parsed)
    assert.throws(() => acceptGraphicalTerminal(changed))
  }
})

test('graphical acceptance permits real chunk splitting without replacing bytes or consumer callbacks', () => {
  const changed = observation()
  const parsed = receipt()
  parsed.runtime.terminals[0]!.callbackCount = 1
  changed.stderr[changed.stderr.findIndex((line) => line.includes('graphical-terminal'))] =
    JSON.stringify(parsed)
  assert.equal(acceptGraphicalTerminal(changed).bytes, 2001)
})

test('graphical acceptance cannot hide leaked output or a receipt produced after shutdown', () => {
  const changed = observation()
  const graphical = changed.stderr.shift()!
  changed.stderr.push(graphical)
  assert.throws(() => acceptGraphicalTerminal(changed), /precede shutdown/)
  for (const mutate of [
    (rows: string[]) => rows.filter((line) => !line.includes('output-drained')),
    (rows: string[]) =>
      rows.map((line) =>
        line.includes('output-drained') ? line.replace('"frames":0', '"frames":1') : line
      ),
    (rows: string[]) => [...rows, rows.find((line) => line.includes('output-drained'))!],
  ]) {
    const failed = observation()
    failed.stderr = mutate(failed.stderr)
    assert.throws(() => acceptGraphicalTerminal(failed))
  }
})

test('native guarded service acceptance requires three exact drained generations and preserved unrelated work', () => {
  acceptNativeServices(serviceReceipt(), 'Darwin')
  const windows = serviceReceipt()
  windows.explicitStop.exitCode = 1
  windows.explicitStop.signalCode = null
  acceptNativeServices(windows, 'Windows')
  for (const mutate of [
    (r: ReturnType<typeof serviceReceipt>) => r.generations.pop(),
    (r: ReturnType<typeof serviceReceipt>) => r.generations.push(r.generations[0]!),
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[1]!.attempt = 1),
    (r: ReturnType<typeof serviceReceipt>) => r.generations[0]!.consumedBytes++,
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[0]!.callbackBytes = 4097),
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[0]!.sha256 = 'invalid'),
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[0]!.exitCode = 0),
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[0]!.outputDrained = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.generations[0]!.disposedBeforeReplacement = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.attemptsExhausted = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.staleGenerationRejected = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.unrelatedPreserved = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.explicitStop.restarted = true),
    (r: ReturnType<typeof serviceReceipt>) => (r.explicitStop.attempts = 2),
    (r: ReturnType<typeof serviceReceipt>) => (r.explicitStop.observed = false),
    (r: ReturnType<typeof serviceReceipt>) => (r.explicitStop.exitCode = 0),
    (r: ReturnType<typeof serviceReceipt>) => (r.finalResources.timers = 1),
    (r: ReturnType<typeof serviceReceipt>) => (r.finalResources.terminals = 1),
    (r: ReturnType<typeof serviceReceipt>) => (r.profile = 'standalone-direct-child'),
  ]) {
    const row = serviceReceipt()
    mutate(row)
    assert.throws(() => acceptNativeServices(row, 'Darwin'))
  }
  const linux = serviceReceipt()
  linux.generations[0]!.terminalStatus = 1
  acceptNativeServices(linux, 'Linux')
  assert.throws(() => acceptNativeServices(linux, 'Windows'))
})

test('graphical terminal acceptance cannot omit or downgrade guarded service integration', () => {
  for (const edit of [
    (r: Record<string, unknown>) => {
      delete r['nativeServices']
    },
    (r: Record<string, unknown>) => {
      r['schema'] = 2
    },
    (r: Record<string, unknown>) => {
      r['nativeServices'] = { passed: true }
    },
  ]) {
    const changed = observation(),
      row = receipt()
    edit(row)
    changed.stderr[changed.stderr.findIndex((line) => line.includes('graphical-terminal'))] =
      JSON.stringify(row)
    assert.throws(() => acceptGraphicalTerminal(changed))
  }
})
