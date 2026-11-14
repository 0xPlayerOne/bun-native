/**
 * Correlate a direct-core AOT workload's signal acknowledgements with the
 * host's opt-in phase trace. Both sources retain their own clock domain; only
 * durations and batch order are compared, never absolute clock timestamps.
 */
import { readFileSync } from 'node:fs'
import { describe } from './stats.ts'

const columns = [
  'id',
  'windowId',
  'operations',
  'startedNanos',
  'prepareNanos',
  'applyNanos',
  'replyEnqueueNanos',
  'rendersBefore',
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object in the diagnostic record')
  return value as Record<string, unknown>
}

/** Fail closed if the exact one-window direct-core sequence is not established. */
export function analyzePhaseTrace(report: unknown, trace: unknown) {
  const workload = object(report)
  const native = object(trace)
  const shape = object(workload['workload'])
  const signal = object(object(workload['phases'])['signals'])
  const acknowledgement = object(signal['acknowledgement'])
  const mutations = object(signal['mutations'])
  const rows = shape['rows']
  const iterations = shape['iterations']
  const samples = acknowledgement['samplesMs']
  if (
    workload['status'] !== 'passed' ||
    workload['adapter'] !== 'core' ||
    workload['declaredMode'] !== 'aot' ||
    typeof rows !== 'number' ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 128 ||
    typeof iterations !== 'number' ||
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > 10_000 ||
    shape['warmup'] !== 20 ||
    !Array.isArray(samples) ||
    samples.length !== iterations ||
    mutations['set'] !== iterations ||
    mutations['create'] !== 0 ||
    mutations['insert'] !== 0 ||
    mutations['remove'] !== 0
  )
    throw new Error('Unexpected direct-core workload or incomplete signal samples')
  if (
    native['schemaVersion'] !== 1 ||
    JSON.stringify(native['batchColumns']) !== JSON.stringify(columns) ||
    native['droppedBatches'] !== 0 ||
    JSON.stringify(native['foregroundColumns']) !==
      JSON.stringify(['id', 'readToForegroundNanos', 'previousYieldOverlapNanos']) ||
    native['droppedForeground'] !== 0 ||
    !Array.isArray(native['foreground']) ||
    !Array.isArray(native['batches'])
  )
    throw new Error('Unexpected or truncated host phase trace')
  const batches = native['batches'] as unknown[]
  const end = 21 + iterations
  if (batches.length < end) throw new Error('Host trace lacks signal batches')
  const prefix = batches.slice(0, end)
  for (let index = 0; index < prefix.length; index += 1) {
    const batch = prefix[index]
    if (
      !Array.isArray(batch) ||
      batch.length !== columns.length ||
      !batch.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      batch[1] !== 1 ||
      batch[2] !== (index === 0 ? 2 * (5 + rows) : 1) ||
      (index > 0 && batch[0] !== (prefix[index - 1] as number[])[0]! + 1) ||
      (index > 0 && batch[3] < (prefix[index - 1] as number[])[3]!) ||
      (index > 0 && batch[7] < (prefix[index - 1] as number[])[7]!)
    )
      throw new Error(`Unexpected batch sequence at ${index}`)
  }
  const foreground = new Map<number, { wait: number; overlap: number }>()
  for (const row of native['foreground'] as unknown[]) {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      !row.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      (row[2] as number) > (row[1] as number) ||
      foreground.has(row[0] as number)
    )
      throw new Error('Invalid foreground trace')
    foreground.set(row[0] as number, { wait: row[1] as number, overlap: row[2] as number })
  }
  const observations = samples.map((value: unknown, index: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`Invalid acknowledgement sample ${index}`)
    const batch = prefix[21 + index] as number[]
    const previous = prefix[20 + index] as number[]
    const wait = foreground.get(batch[0]!)
    if (wait === undefined) throw new Error(`Missing foreground timing at ${index}`)
    const prepareMs = batch[4]! / 1e6
    const applyMs = batch[5]! / 1e6
    const replyEnqueueMs = batch[6]! / 1e6
    const hostMs = prepareMs + applyMs + replyEnqueueMs
    const previousReply = previous[3]! + previous[4]! + previous[5]! + previous[6]!
    if (batch[3]! < previousReply) throw new Error(`Overlapping host batches at ${index}`)
    return {
      index,
      requestId: batch[0]!,
      acknowledgementMs: value,
      readToForegroundMs: wait.wait / 1e6,
      previousYieldOverlapMs: wait.overlap / 1e6,
      hostMs,
      prepareMs,
      applyMs,
      replyEnqueueMs,
      previousHostGapMs: (batch[3]! - previousReply) / 1e6,
      rendersSincePrevious: batch[7]! - previous[7]!,
    }
  })
  const slow = observations.filter((sample) => sample.acknowledgementMs >= 10)
  return {
    meaning:
      'Read-to-foreground starts after command decoding and validation and includes channel enqueue and scheduling. Host time covers preflight through reply enqueue. The previous host gap begins at the preceding reply, not at this application request; it also includes application work, scheduling and transport. Neither interval measures presentation or partitions the acknowledgement.',
    signalSamples: observations.length,
    slowAtLeast10Ms: slow.length,
    acknowledgementMs: describe(observations.map((sample) => sample.acknowledgementMs)),
    hostMs: describe(observations.map((sample) => sample.hostMs)),
    slowHostMs: describe(slow.map((sample) => sample.hostMs)),
    slowPreviousYieldOverlapMs: describe(slow.map((sample) => sample.previousYieldOverlapMs)),
    slowWithYieldOverlap: slow.filter((sample) => sample.previousYieldOverlapMs > 0).length,
    slowReadToForegroundMs: describe(slow.map((sample) => sample.readToForegroundMs)),
    slowPrepareMs: describe(slow.map((sample) => sample.prepareMs)),
    slowApplyMs: describe(slow.map((sample) => sample.applyMs)),
    slowReplyEnqueueMs: describe(slow.map((sample) => sample.replyEnqueueMs)),
    slowPreviousHostGapMs: describe(slow.map((sample) => sample.previousHostGapMs)),
    slowWithInterveningRender: slow.filter((sample) => sample.rendersSincePrevious > 0).length,
    samples: observations,
  }
}

if (import.meta.main) {
  const [, , reportPath, tracePath] = process.argv
  if (!reportPath || !tracePath) throw new Error('Usage: bun phase-analysis.ts REPORT TRACE')
  console.log(
    JSON.stringify(
      analyzePhaseTrace(
        JSON.parse(readFileSync(reportPath, 'utf8')),
        JSON.parse(readFileSync(tracePath, 'utf8'))
      ),
      null,
      2
    )
  )
}
