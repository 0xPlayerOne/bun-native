import { createApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

/**
 * The event-stress driver injects exactly 1,000 lowercase x edits into the owned
 * native input. This listener never echoes a value or sends a per-edit batch.
 * Every event is checked; timings describe Bun callback observations, not OS
 * event timestamps, wire transit, display presentation or maximum capacity.
 */
const EVENT_COUNT = 1_000
const EXPECTED_TEXT = 'x'.repeat(EVENT_COUNT)
const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host')

const startedAt = new Date().toISOString()
const started = performance.now()
const observationsMs: number[] = []
let observedEvents = 0
let lastSequence = 0
let peakQueuedCallbacks = 0
let peakActiveCallbacks = 0
let inputSignal: AbortSignal | undefined
let failure: Error | undefined
const app = await createApplication({ executable: resolve(executable) })

function fail(cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  failure ??= error
  return error
}

const deadline = setTimeout(() => {
  fail(new Error('Native event throughput fixture exceeded 45 seconds'))
  void app.shutdown().catch(fail)
}, 45_000)

try {
  const window = await app.openWindow({
    title: 'Bun Native event throughput',
    width: 560,
    height: 380,
  })
  const input = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'Native input throughput',
      style: { font_size: 28 },
    })
    const description = batch.create({ kind: 'text', text: 'Recording 1000 OS-delivered edits' })
    const input = batch.create({
      kind: 'input',
      value: '',
      placeholder: '1000 lowercase x edits',
      style: { width: 'fill', font_size: 20 },
    })
    for (const node of [heading, description, input]) batch.append(window.root, node)
    return input
  })
  window.onInput(input, (event) => {
    try {
      const observedAt = performance.now() - started
      const expected = observedEvents + 1
      assert(expected <= EVENT_COUNT, 'The fixed workload must not emit additional edits')
      assert.equal(event.node, input)
      // Global native order also includes key and focus events. Input callbacks
      // are a strictly ordered subset; their edit revisions remain contiguous.
      assert(event.sequence > lastSequence, 'Input callbacks must preserve native event order')
      lastSequence = event.sequence
      assert.equal(event.revision, expected, 'Every accepted edit must advance its revision')
      assert.equal(event.value, EXPECTED_TEXT.slice(0, expected), 'Every edit value must match')
      assert.equal(event.signal.aborted, false)
      const current = window.input(input)
      assert(current.revision >= event.revision, 'Ingestion may lead callbacks but cannot lag')
      assert(current.revision <= EVENT_COUNT)
      assert.equal(current.value, EXPECTED_TEXT.slice(0, current.revision))
      assert.equal(window.revision, 1, 'Native edits must not mutate the tree revision')
      inputSignal = event.signal
      observedEvents = expected
      observationsMs.push(observedAt)
      const counts = app.diagnostics
      peakQueuedCallbacks = Math.max(peakQueuedCallbacks, counts.queuedCallbacks)
      peakActiveCallbacks = Math.max(peakActiveCallbacks, counts.activeCallbacks)
      assert(counts.queuedCallbacks <= 128)
      assert.equal(counts.activeCallbacks, 1)
      assert.equal(counts.queuedTransactions, 0)
      assert.equal(counts.nodes, 4)
      assert.equal(counts.callbacks, 1)
      recordEvidence({
        type: 'input',
        sequence: event.sequence,
        input_revision: event.revision,
        value: event.value,
        observed_at_ms: observedAt,
      })
    } catch (cause) {
      throw fail(cause)
    }
  })
  await window.closed
  assert.equal(observedEvents, EVENT_COUNT)
  assert.equal(inputSignal?.aborted, true, 'OS close must revoke the input listener')
} catch (cause) {
  fail(cause)
}

clearTimeout(deadline)
try {
  await app.shutdown()
  await app.closed
  assert.deepEqual(app.diagnostics, {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
} catch (cause) {
  fail(cause)
}

const firstObservation = observationsMs[0]
const lastObservation = observationsMs.at(-1)
const spanMs =
  firstObservation !== undefined && lastObservation !== undefined
    ? lastObservation - firstObservation
    : undefined
const gapsMs = observationsMs.slice(1).map((time, index) => time - observationsMs[index]!)
const sortedGaps = [...gapsMs].sort((left, right) => left - right)
const gapPercentile = (fraction: number) =>
  sortedGaps[Math.max(0, Math.ceil(sortedGaps.length * fraction) - 1)]
const result = {
  schemaVersion: 1,
  status: failure ? 'failed' : 'passed',
  startedAt,
  elapsedMs: performance.now() - started,
  runtime: { bunVersion: Bun.version, bunRevision: Bun.revision, executable: process.execPath },
  platform: { os: platform(), architecture: arch(), kernel: release() },
  checks: {
    expectedEvents: EVENT_COUNT,
    observedEvents,
    orderedSequencesContiguousRevisionsAndValues: !failure && observedEvents === EVENT_COUNT,
    nativeTreeRevision: 1,
    applicationInputReplacementBatches: 0,
    peakObservedQueuedCallbacks: peakQueuedCallbacks,
    peakObservedActiveCallbacks: peakActiveCallbacks,
    listenerRevokedOnClose: inputSignal?.aborted ?? false,
    finalOwnership: app.diagnostics,
  },
  applicationObservations: {
    firstMs: firstObservation,
    lastMs: lastObservation,
    spanMs,
    intervals: Math.max(0, observationsMs.length - 1),
    callbacksPerSecond:
      spanMs !== undefined && spanMs > 0
        ? ((observationsMs.length - 1) * 1_000) / spanMs
        : undefined,
    gapP50Ms: gapPercentile(0.5),
    gapP95Ms: gapPercentile(0.95),
    gapP99Ms: gapPercentile(0.99),
    samplesMs: observationsMs,
    gapsMs,
  },
  methodology: {
    clock: 'Bun performance.now at synchronous input-listener entry',
    rate: '(callback count - 1) / (last callback observation - first callback observation)',
    instrumentation: 'Prefix validation and one bounded synchronous JSONL append per callback',
    inputLoad: 'Exactly 1000 x edits; the external XTest driver requests 1ms character delay',
    timingLimits:
      'Callback observation gaps include the injection schedule, native input processing, IPC and Bun scheduling. They are not per-event dispatch or input-to-presentation latency. The two process clocks are not correlated.',
    capacity: 'This fixed offered load does not establish maximum sustainable throughput',
    externalEvidence:
      'The input driver verifies every logged sequence/revision/value, native final paint, observed injection interval, owned-process cleanup and artifact/source evidence. AOT qualification requires the separate build manifest.',
  },
  error: failure ? { name: failure.name, message: failure.message } : undefined,
}
const json = JSON.stringify(result, null, 2) + '\n'
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG']
if (evidenceLog)
  writeFileSync(join(dirname(evidenceLog), 'event-throughput.json'), json, { flag: 'wx' })
console.log(json)
if (failure) throw failure
