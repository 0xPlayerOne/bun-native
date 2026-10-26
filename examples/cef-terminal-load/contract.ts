import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'
import type { LoadMode } from './mode-state.ts'
import type { ConsumerDiagnostic } from './diagnostics.ts'
import { BATCHES, LOAD, loadBatch } from './workload.ts'
export function check(value: unknown, message = 'Invalid load receipt'): asserts value {
  if (!value) throw new Error(message)
}
export function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function finite(value: unknown): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0)
  return value
}
export function integer(value: unknown, max: number): number {
  check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max)
  return Number(value)
}
export const none = (value: unknown): null => {
  check(value === null)
  return null
}
export const mode = (value: unknown): 'visible' | 'hidden' => {
  check(value === 'visible' || value === 'hidden')
  return value
}
export const loadMode = (value: unknown): LoadMode => {
  check(
    typeof value === 'string' && (LOAD.modes as readonly string[]).includes(value),
    'Unknown fixed load mode'
  )
  return value as LoadMode
}
export function receipt(value: unknown) {
  const row = object(value)
  check(
    Object.keys(row).sort().join(',') ===
      'batch,bytes,callbacks,consumerMs,controlMs,records,sha256,terminal,visibility'
  )
  check(typeof row['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(row['sha256']))
  check(row['records'] === LOAD.recordsPerBatch + 1)
  return {
    batch: loadBatch(row['batch']),
    terminal: integer(row['terminal'], 1),
    bytes: integer(row['bytes'], LOAD.maxBatchBytes),
    callbacks: integer(row['callbacks'], LOAD.maxCallbacksPerBatch),
    consumerMs: finite(row['consumerMs']),
    controlMs: finite(row['controlMs']),
    sha256: row['sha256'],
    records: row['records'],
    visibility: mode(row['visibility']),
  }
}
export function diagnostic(value: unknown): ConsumerDiagnostic {
  const row = object(value)
  check(
    Object.keys(row).sort().join(',') ===
      'batch,bytes,callbacks,control,error,records,stage,terminal,visibility'
  )
  check(
    [
      'xterm-write',
      'screen-parse',
      'control-rpc',
      'digest',
      'consumed-rpc',
      'ack-pending',
      'consume-return',
      'error',
    ].includes(String(row['stage']))
  )
  check(['idle', 'pending', 'resolved', 'failed'].includes(String(row['control'])))
  check(row['error'] === null || (typeof row['error'] === 'string' && row['error'].length <= 240))
  return {
    terminal: integer(row['terminal'], 1),
    batch: integer(row['batch'], BATCHES),
    bytes: integer(row['bytes'], LOAD.maxBatchBytes),
    callbacks: integer(row['callbacks'], LOAD.maxCallbacksPerBatch),
    records: integer(row['records'], BATCHES * (LOAD.recordsPerBatch + 1) + 1),
    visibility: mode(row['visibility']),
    stage: String(row['stage']),
    control: String(row['control']),
    error: row['error'] as string | null,
  }
}
export const schema = defineRpc({
  diagnostic: procedure(diagnostic, none),
  ready: procedure(mode, none),
  consumed: procedure(receipt, none),
  progress: procedure(
    (value) => integer(value, BATCHES),
    (value) => integer(value, BATCHES)
  ),
  visibility: procedure(mode, none),
  finished: procedure((value) => {
    const row = object(value)
    check(Object.keys(row).sort().join(',') === 'bytes,records,sha256,terminal')
    check(typeof row['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(row['sha256']))
    return {
      terminal: integer(row['terminal'], 1),
      records: integer(row['records'], 2),
      bytes: integer(row['bytes'], 1024),
      sha256: String(row['sha256']),
    }
  }, none),
})
