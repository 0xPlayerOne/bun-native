import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { LOAD, BATCHES, loadBatch, loadRecord } from '../examples/cef-terminal-load/workload.ts'
import { receipt } from '../examples/cef-terminal-load/contract.ts'
import {
  acceptLoadRows,
  loadProcessPhases,
  loadProcessQuarterTrends,
} from '../benchmarks/lib/terminal-load-acceptance.ts'
import type { ObservationSample } from '../benchmarks/lib/observation.ts'
const hash = 'a'.repeat(64)
function fixture() {
  const rows: Record<string, unknown>[] = [
    {
      kind: 'start',
      schema: 1,
      workload: LOAD,
      mode: 'hidden',
      visibilityReceipts: ['initial-visible', 'hidden'],
    },
  ]
  let batch = 0
  for (const phase of LOAD.phases) {
    for (let index = 0; index < phase.batches; index++, batch++)
      for (let terminal = 0; terminal < 2; terminal++)
        rows.push({
          kind: 'batch',
          phase: phase.name,
          batch,
          terminal,
          bytes: 3000,
          callbacks: 1,
          consumerMs: 1,
          controlMs: 2,
          records: 33,
          sha256: hash,
          visibility: 'hidden',
          runtimeBytes: 3000,
          acknowledgedBytes: 3000,
          runtimeSha256: hash,
          streamCallbacks: 1,
          runtimeCallbacks: 1,
          runtimePendingBytePeak: 3000,
          ptyCallbackToConsumptionAckMs: 4,
          triggerToConsumptionAckMs: 5,
          scheduleLagMs: 0,
          terminalBudget: {
            terminals: 2,
            reservedOutputBytes: 65536,
            sourceReservedBytes: 65536,
            sourceStreams: 2,
          },
          queueBytes: 3000,
          queueFrames: 1,
        })
    rows.push({
      kind: 'phase',
      phase: phase.name,
      batches: phase.batches,
      elapsedMs: phase.batches * phase.intervalMs,
    })
  }
  rows.push({
    kind: 'complete',
    batches: BATCHES,
    exits: [0, 1].map((terminal) => ({
      released: true,
      output: { ok: true },
      processExit: { started: true, observed: true, exitCode: 0, waitError: false, failure: null },
      terminalClose: { started: true, observed: true, status: 0, failure: null },
      final: { terminal, records: 1, bytes: 100, sha256: hash },
    })),
    terminalBudget: {
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
    streamBudget: {
      connectionFailures: 0,
      connections: 0,
      budget: { reservedBytes: 0, streams: 0, views: 0 },
    },
    native: {
      views: 0,
      sessions: 0,
      windows: 1,
      streamIncomingBytes: 0,
      streamDeliveryBytes: 0,
      streamDeliveryPackets: 0,
      rpcIncomingBytes: 0,
      rpcDeliveryBytes: 0,
      rpcDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      nativeDeliveryPackets: 0,
    },
  })
  return rows
}
const raw = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
test('load profile has finite identical work and a genuine 30-second sustained phase', () => {
  assert.equal(BATCHES, 700)
  assert.equal(LOAD.phases[2].batches * LOAD.phases[2].intervalMs, 30000)
  for (const value of [-1, 700, Infinity, 0.5, '1']) assert.throws(() => loadBatch(value))
  assert.deepEqual(loadRecord(2, 0), {
    type: 'record',
    index: 0,
    text: 'fixed-0-café-🐙',
    batch: 2,
  })
  const result = acceptLoadRows(raw(fixture()), 'hidden', 'Darwin')
  assert.equal(result[2]!.controlMs.count, 1200)
  assert.equal(result[2]!.bytes, 3600000)
})
test('load acceptance refuses shortened work, fabricated visibility, dropped bytes, gaps and unbounded queues', () => {
  const mutations = [
    (rows: Record<string, unknown>[]) => {
      rows[0]!['visibilityReceipts'] = ['initial-visible']
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['runtimeSha256'] = 'b'.repeat(64)
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['runtimeBytes'] = 2999
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['acknowledgedBytes'] = 2999
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['batch'] = 1
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['terminal'] = 1
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['visibility'] = 'visible'
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['queueBytes'] = 3000000
    },
    (rows: Record<string, unknown>[]) => {
      rows[1]!['controlMs'] = -1
    },
    (rows: Record<string, unknown>[]) => {
      rows.find((row) => row['kind'] === 'phase' && row['phase'] === 'sustained')!['elapsedMs'] =
        29900
    },
    (rows: Record<string, unknown>[]) => {
      rows.splice(1, 1)
    },
    (rows: Record<string, unknown>[]) => {
      rows.push(rows[1]!)
    },
    (rows: Record<string, unknown>[]) => {
      ;(rows.at(-1)!['terminalBudget'] as Record<string, unknown>)['sourceReservedBytes'] = 1
    },
  ]
  for (const mutate of mutations) {
    const rows = fixture()
    mutate(rows)
    assert.throws(() => acceptLoadRows(raw(rows), 'hidden', 'Darwin'))
  }
})
test('load receipt cannot carry native authority, unknown fields or unbounded data', () => {
  const valid = {
    batch: 0,
    bytes: 3000,
    callbacks: 1,
    consumerMs: 1,
    controlMs: 2,
    records: 33,
    sha256: hash,
    terminal: 0,
    visibility: 'visible',
  }
  assert.equal(receipt(valid).batch, 0)
  for (const changed of [
    { ...valid, pid: 123 },
    { ...valid, bytes: 32769 },
    { ...valid, callbacks: 257 },
    { ...valid, terminal: 2 },
    { ...valid, records: 32 },
    { ...valid, sha256: 'a' },
  ])
    assert.throws(() => receipt(changed))
})
test('CPU uses process birth identities and RSS quarters do not declare a plateau', () => {
  const samples = LOAD.phases.flatMap(({ name }) =>
    [0, 1, 2, 3].map((index) => ({
      phase: name,
      elapsedMs: index * 100,
      rssBytes: 1000 + index * 100,
      threads: 1,
      processes: [
        {
          pid: 1,
          creationTime: index < 2 ? 1 : 2,
          cpuSeconds: index < 2 ? index * 0.01 : 100 + index * 0.01,
          rssBytes: 1000,
          threads: 1,
          contextSwitches: null,
          descriptors: null,
        },
      ],
    }))
  )
  const result = loadProcessPhases(samples as ObservationSample[])
  assert.ok(result[0]!.treeCpuPercentOfOneCore! < 10)
  assert.deepEqual(result[0]!.rssQuarterMedians, [1000, 1100, 1200, 1300])
  assert.match(result[0]!.plateau, /DESCRIPTIVE_ONLY/)
})

test('quarter trends report measured CPU and refuse to join reused process identities', () => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    phase: 'sustained',
    elapsedMs: index * 100,
    rssBytes: 1000 + index,
    threads: 1,
    processes: [
      {
        pid: 1,
        creationTime: index === 3 ? 2 : 1,
        cpuSeconds: index * 0.01,
        rssBytes: 1000,
        threads: 1,
        contextSwitches: null,
        descriptors: null,
      },
    ],
  }))
  const result = loadProcessQuarterTrends(samples)
  assert.equal(result[0]!.incomplete, true)
  const quarters = result[2]!.quarters
  assert.ok(Math.abs(quarters[0]!.cpuPercentOfOneCore! - 10) < 0.001)
  assert.equal(quarters[1]!.cpuPercentOfOneCore, null)
  assert.equal(quarters[0]!.rssMedianBytes, 1000.5)
})
