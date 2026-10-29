import assert from 'node:assert/strict'
import {
  expectedVisibility,
  requireLoadMode,
  type LoadMode,
} from '../../examples/cef-terminal-load/mode-state.ts'
import { LOAD_PROFILE, LOAD_RAW_LIMIT } from '../../examples/cef-terminal-load/profile.ts'
import { LOAD, BATCHES } from '../../examples/cef-terminal-load/workload.ts'
import { receipt, object, finite } from '../../examples/cef-terminal-load/contract.ts'
import { validateCommandObservation, assertCleanCommand } from './observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import { nativeEvents } from './cef-acceptance.ts'
import { quantile } from './statistics.ts'
import type { ObservationSample } from './observation.ts'
export function descriptive(values: readonly number[]) {
  assert.ok(values.length > 0 && values.every((v) => Number.isFinite(v) && v >= 0))
  return {
    count: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    min: Math.min(...values),
    max: Math.max(...values),
    uncertainty:
      'Correlated within-launch samples; no independent-sample confidence interval or regression threshold.',
  }
}
/** Fixed resource/correctness gate, never an invented RSS/latency threshold. */
export function acceptLoadRows(
  raw: string,
  selected: string,
  os: unknown,
  host: 'cef' | 'electron' = 'cef',
  terminalOwnership?: 'native-non-detaching'
) {
  assert.ok(Buffer.byteLength(raw) <= LOAD_RAW_LIMIT, 'Raw instrumentation byte bound')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 2 + LOAD.phases.length + BATCHES * LOAD.terminals)
  const rows = lines.map((line) => object(JSON.parse(line)))
  const start = rows.shift()!
  assert.equal(start['kind'], 'start')
  const windowed = LOAD_PROFILE === 'windowed'
  assert.ok((LOAD.modes as readonly string[]).includes(selected))
  const expectedPage = expectedVisibility(selected as LoadMode)
  assert.equal(start['schema'], windowed ? 2 : 1)
  assert.deepEqual(start['workload'], LOAD)
  assert.equal(start['mode'], selected)
  assert.deepEqual(
    start['visibilityReceipts'],
    expectedPage === 'visible' ? ['initial-visible'] : ['initial-visible', 'hidden']
  )
  const final = rows.pop()!
  assert.equal(final['kind'], 'complete')
  const observedMode = (value: unknown, mode: LoadMode) => {
    const observation = object(value)
    assert.deepEqual(Object.keys(observation).sort(), ['mode', 'nativeState', 'visibility'])
    assert.equal(observation['mode'], mode)
    return requireLoadMode(mode, observation['nativeState'], observation['visibility'])
  }
  if (windowed) {
    const startMode = object(start['windowMode']),
      finalMode = object(final['windowMode'])
    observedMode(startMode['initial'], 'visible')
    observedMode(startMode['admitted'], selected as LoadMode)
    observedMode(finalMode['loaded'], selected as LoadMode)
    observedMode(finalMode['restored'], 'foreground')
  }

  if (terminalOwnership !== undefined) {
    assert.equal(host, 'cef')
    assert.equal(start['terminalOwnership'], terminalOwnership)
    assert.equal(final['terminalOwnership'], terminalOwnership)
  }

  assert.equal(final['batches'], BATCHES)
  const exits = final['exits']
  assert.ok(Array.isArray(exits) && exits.length === LOAD.terminals)
  for (const [index, exit] of exits.entries()) {
    const e = object(exit)
    assert.equal(e['released'], true)
    assert.deepEqual(e['output'], { ok: true })
    const process = object(e['processExit'])
    assert.equal(process['started'], true)
    assert.equal(process['observed'], true)
    assert.equal(process['exitCode'], 0)
    assert.equal(process['waitError'], false)
    assert.equal(process['failure'], null)
    const close = object(e['terminalClose'])
    assert.equal(close['started'], true)
    assert.equal(close['observed'], true)
    assert.equal(close['failure'], null)
    assert.ok(close['status'] === 0 || (os === 'Linux' && close['status'] === 1))
    const completion = object(e['final'])
    assert.equal(completion['terminal'], index)
    assert.equal(completion['records'], 1)
    assert.ok(Number(completion['bytes']) > 0 && Number(completion['bytes']) < 1024)
    assert.match(String(completion['sha256']), /^[a-f0-9]{64}$/)
  }
  const budget = object(final['terminalBudget'])
  for (const name of [
    'terminals',
    'reservedOutputBytes',
    'owners',
    'sourceReservedBytes',
    'sourceStreams',
    'spawning',
    'live',
    'closing',
    'pendingDriverWrites',
    'driverFailures',
  ])
    assert.equal(budget[name], 0)
  const streamBudget = object(final['streamBudget'])
  assert.equal(streamBudget['connectionFailures'], 0)
  assert.equal(streamBudget['connections'], 0)
  assert.deepEqual(streamBudget['budget'], { reservedBytes: 0, streams: 0, views: 0 })
  for (const ownerBudget of [budget, streamBudget]) {
    if (ownerBudget['scheduling'] !== undefined) {
      const scheduling = object(ownerBudget['scheduling'])
      for (const field of [
        'queueDepth',
        'bulkQueued',
        'controlQueued',
        'owners',
        'rejected',
        'coalesced',
        'dropped',
      ])
        assert.equal(scheduling[field], 0)
      assert.equal(scheduling['yieldPending'], false)
      assert.equal(
        scheduling['enqueued'],
        Number(scheduling['dispatched']) + Number(scheduling['cancelled'])
      )
    }
  }
  if (host === 'electron') {
    const electron = object(final['electron'])
    assert.equal(electron['controllerBun'], '1.4.4')
    const state = object(electron['nativeState'])
    if (!windowed) {
      assert.equal(state['visible'], selected === 'visible')
      assert.equal(state['minimized'], false)
    }
    assert.equal(typeof state[windowed ? 'active' : 'focused'], 'boolean')
    const stream = object(electron['stream'])
    for (const field of ['streams', 'queuedBytes', 'queuedFrames']) assert.equal(stream[field], 0)
    assert.deepEqual(start['nativeState'], state)
  } else {
    const native = object(final['native'])
    for (const field of [
      'views',
      'sessions',
      'streamIncomingBytes',
      'streamDeliveryBytes',
      'streamDeliveryPackets',
      'rpcIncomingBytes',
      'rpcDeliveryBytes',
      'rpcDeliveryPackets',
      'nativeDeliveryBytes',
      'nativeDeliveryPackets',
    ])
      assert.equal(native[field], 0)
    assert.equal(native['windows'], 1)
  }
  let batch = 0
  const phases = []
  for (const phase of LOAD.phases) {
    const accepted = []
    for (let index = 0; index < phase.batches; index++, batch++)
      for (let terminal = 0; terminal < LOAD.terminals; terminal++) {
        const row = rows.shift()!
        assert.equal(row['kind'], 'batch')
        assert.equal(row['phase'], phase.name)
        const r = receipt(
          Object.fromEntries(
            [
              'batch',
              'bytes',
              'callbacks',
              'consumerMs',
              'controlMs',
              'records',
              'sha256',
              'terminal',
              'visibility',
            ].map((key) => [key, row[key]])
          )
        )
        assert.equal(r.batch, batch)
        assert.equal(r.terminal, terminal)
        assert.equal(r.visibility, expectedPage)
        assert.ok(r.bytes > 0 && r.callbacks > 0)
        assert.equal(row['runtimeBytes'], r.bytes)
        assert.equal(row['acknowledgedBytes'], r.bytes)
        assert.equal(row['runtimeSha256'], r.sha256)
        assert.equal(row['streamCallbacks'], r.callbacks)
        assert.ok(
          Number.isSafeInteger(row['runtimeCallbacks']) &&
            Number(row['runtimeCallbacks']) > 0 &&
            Number(row['runtimeCallbacks']) <= LOAD.maxCallbacksPerBatch
        )
        assert.ok(finite(row['runtimePendingBytePeak']) <= LOAD.maxBatchBytes)
        const q = object(row['terminalBudget'])
        assert.equal(q['terminals'], 2)
        assert.equal(q['reservedOutputBytes'], 65536)
        assert.equal(q['sourceReservedBytes'], 65536)
        assert.equal(q['sourceStreams'], 2)
        assert.ok(finite(row['queueBytes']) <= 2 * 1024 * 1024 && finite(row['queueFrames']) <= 128)
        accepted.push({
          ...r,
          ack: finite(row['triggerToConsumptionAckMs']),
          ptyAck: finite(row['ptyCallbackToConsumptionAckMs']),
          lag: finite(row['scheduleLagMs']),
        })
      }
    const timing = rows.shift()!
    assert.equal(timing['kind'], 'phase')
    assert.equal(timing['phase'], phase.name)
    assert.equal(timing['batches'], phase.batches)
    if (windowed) observedMode(timing['windowMode'], selected as LoadMode)
    const elapsedMs = finite(timing['elapsedMs'])
    assert.ok(elapsedMs >= phase.batches * phase.intervalMs - 5, 'Sustained phase shortened')
    const bytes = accepted.reduce((sum, row) => sum + row.bytes, 0)
    phases.push({
      phase: phase.name,
      bytes,
      elapsedMs,
      bytesPerSecond: (bytes * 1000) / elapsedMs,
      controlMs: descriptive(accepted.map((row) => row.controlMs)),
      consumerMs: descriptive(accepted.map((row) => row.consumerMs)),
      triggerToConsumptionAckMs: descriptive(accepted.map((row) => row.ack)),
      ptyCallbackToConsumptionAckMs: descriptive(accepted.map((row) => row.ptyAck)),
      scheduleLagMs: descriptive(accepted.map((row) => row.lag)),
    })
  }
  assert.equal(rows.length, 0)
  return phases
}
/** Sampled trend, not automatic plateau acceptance. Birth identity is required for CPU deltas. */
export function loadProcessPhases(samples: readonly ObservationSample[]) {
  return LOAD.phases.map(({ name }) => {
    const selected = samples.filter((sample) => sample.phase === name)
    assert.ok(selected.length >= 2, 'Missing sustained process observations')
    let cpuSeconds = 0
    let matched = 0
    for (let index = 1; index < selected.length; index++) {
      for (const process of selected[index]!.processes) {
        const current = process as typeof process & { creationTime?: number }
        const previous = selected[index - 1]!.processes.find(
          (row) =>
            row.pid === current.pid && (row as typeof current).creationTime === current.creationTime
        )
        if (
          current.creationTime !== undefined &&
          previous &&
          current.cpuSeconds >= previous.cpuSeconds
        ) {
          cpuSeconds += current.cpuSeconds - previous.cpuSeconds
          matched++
        }
      }
    }
    const elapsedMs = selected.at(-1)!.elapsedMs - selected[0]!.elapsedMs
    const buckets = [0, 1, 2, 3].map((bucket) =>
      selected
        .filter(
          (sample) =>
            Math.min(
              3,
              Math.floor((4 * (sample.elapsedMs - selected[0]!.elapsedMs)) / elapsedMs)
            ) === bucket
        )
        .map((sample) => sample.rssBytes)
    )
    return {
      phase: name,
      samples: selected.length,
      sampledDurationMs: elapsedMs,
      treeCpuPercentOfOneCore: matched && elapsedMs > 0 ? (cpuSeconds * 100000) / elapsedMs : null,
      rssBytes: descriptive(selected.map((sample) => sample.rssBytes)),
      rssQuarterMedians: buckets.map((values) => (values.length ? quantile(values, 0.5) : null)),
      plateau:
        'DESCRIPTIVE_ONLY-review raw time series and repeated trials; RSS can double-count shared pages, sampling misses brief children',
    }
  })
}
/** Adjacent same-birth CPU deltas within each time quarter; boundary intervals omitted. */
export function loadProcessQuarterTrends(samples: readonly ObservationSample[]) {
  return LOAD.phases.map(({ name }) => {
    const selected = samples.filter((sample) => sample.phase === name)
    if (selected.length < 2) return { phase: name, quarters: [], incomplete: true }
    const first = selected[0]!.elapsedMs
    const duration = selected.at(-1)!.elapsedMs - first
    const bucket = (sample: ObservationSample) =>
      Math.min(3, Math.floor((4 * (sample.elapsedMs - first)) / duration))
    return {
      phase: name,
      incomplete: false,
      quarters: [0, 1, 2, 3].map((quarter) => {
        const rows = selected.filter((sample) => bucket(sample) === quarter)
        let cpuSeconds = 0,
          matched = 0
        for (let index = 1; index < rows.length; index++)
          for (const process of rows[index]!.processes) {
            const current = process as typeof process & { creationTime?: number }
            const previous = rows[index - 1]!.processes.find(
              (old) =>
                old.pid === current.pid &&
                (old as typeof current).creationTime === current.creationTime
            )
            if (
              current.creationTime !== undefined &&
              previous &&
              current.cpuSeconds >= previous.cpuSeconds
            ) {
              cpuSeconds += current.cpuSeconds - previous.cpuSeconds
              matched++
            }
          }
        const elapsed = rows.length > 1 ? rows.at(-1)!.elapsedMs - rows[0]!.elapsedMs : 0
        return {
          quarter,
          samples: rows.length,
          matchedIntervals: matched,
          sampledDurationMs: elapsed,
          cpuPercentOfOneCore: matched && elapsed > 0 ? (cpuSeconds * 100000) / elapsed : null,
          rssMedianBytes: rows.length
            ? quantile(
                rows.map((row) => row.rssBytes),
                0.5
              )
            : null,
        }
      }),
    }
  })
}
export function acceptTerminalLoad(
  input: unknown,
  raw: string,
  selected: string,
  terminalOwnership?: 'native-non-detaching'
) {
  const observed = validateCommandObservation(input)
  assertCleanCommand(observed)
  requireNativeShutdown(observeNativeShutdown(observed))
  const events = nativeEvents(observed)
  const receipts = events.filter((event) => event['event'] === 'bunly.native.terminal-load')
  assert.deepEqual(receipts, [
    {
      event: 'bunly.native.terminal-load',
      schema: LOAD_PROFILE === 'windowed' ? 3 : terminalOwnership === undefined ? 1 : 2,
      ...(terminalOwnership === undefined ? {} : { terminalOwnership }),
      mode: selected,
      batches: BATCHES,
      complete: true,
    },
  ])
  assert.ok(
    events.indexOf(receipts[0]!) <
      events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  )
  const drained = events.filter((event) => event['event'] === 'bunly.native.output-drained')
  assert.deepEqual(drained, [
    {
      event: 'bunly.native.output-drained',
      schema: 1,
      frames: 0,
      ordinaryFrames: 0,
      retainedWireBytes: 0,
      ordinaryWireBytes: 0,
    },
  ])
  assert.ok(
    events.indexOf(drained[0]!) >
      events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  )
  assert.ok(
    events.indexOf(drained[0]!) <
      events.findIndex(
        (event) =>
          event['event'] === 'bunly.host.shutdown-phase' &&
          event['phase'] === 'process-stop' &&
          event['state'] === 'complete'
      )
  )
  const phases = acceptLoadRows(raw, selected, observed.environment['os'], 'cef', terminalOwnership)
  return {
    phases,
    process: loadProcessPhases(observed.samples as unknown as readonly ObservationSample[]),
    status: 'descriptive-not-comparative',
    minimized:
      LOAD_PROFILE === 'windowed' && selected === 'minimized'
        ? 'NATIVE_STATE_AND_PAGE_VISIBILITY_OBSERVED'
        : 'NOT_QUALIFIED',
    foregroundFocus:
      LOAD_PROFILE === 'windowed' && selected === 'foreground'
        ? 'NATIVE_ACTIVE_AT_ADMISSION_AND_PHASE_CHECKPOINTS'
        : 'NOT_QUALIFIED-visible-is-not-proof-of-OS-focus',
  }
}
/** Preserve independent workload and teardown outcomes, including overlap. */
export function assessTerminalLoad(
  input: unknown,
  raw: string,
  selected: string,
  terminalOwnership?: 'native-non-detaching'
) {
  const observed = validateCommandObservation(input)
  const attempt = (run: () => unknown) => {
    try {
      return { passed: true, result: run() }
    } catch (error) {
      return { passed: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const rows = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)))
  const shutdown = observeNativeShutdown(observed)
  return {
    shutdownPhases: {
      complete:
        !shutdown.malformed &&
        shutdown.pendingPhase === null &&
        Object.values(shutdown.durationsMs).every((duration) => duration !== null),
      observation: shutdown,
    },
    workload: attempt(() =>
      acceptLoadRows(raw, selected, observed.environment['os'], 'cef', terminalOwnership)
    ),
    command: attempt(() => assertCleanCommand(observed)),
    teardown: attempt(() => requireNativeShutdown(observeNativeShutdown(observed))),
    lastBatch: [...rows].reverse().find((row) => row['kind'] === 'batch')?.['batch'] ?? null,
    failure: rows.find((row) => row['kind'] === 'failure') ?? null,
    watchdog: observed.stderr.some((line) => line.includes('Teardown watchdog expired')),
  }
}
