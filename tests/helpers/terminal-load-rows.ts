import { LOAD, BATCHES } from '../../examples/cef-terminal-load/workload.ts'
const hash = 'a'.repeat(64)
export function fixture() {
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
export const raw = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
