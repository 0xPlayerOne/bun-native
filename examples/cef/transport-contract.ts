import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'
export { RPC_TRANSPORT_WORKLOAD } from '../../benchmarks/rpc-transport-comparison.ts'
export const transportLimits = Object.freeze({
  maxFrameBytes: 96 * 1024,
  maxMetadataBytes: 16 * 1024,
  maxTimeoutMs: 30000,
})
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected object')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 64) throw new TypeError('Expected bounded text')
  return value
}
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 30000)
    throw new TypeError('Expected finite bounded number')
  return value
}
const integer = (value: unknown): number => {
  const result = number(value)
  if (!Number.isSafeInteger(result)) throw new TypeError('Expected integer')
  return result
}
const none = (value: unknown): null => {
  if (value !== null) throw new TypeError('Expected null')
  return null
}
const structured = (value: unknown) => {
  const v = object(value)
  if (Object.keys(v).sort().join(',') !== 'index,label')
    throw new TypeError('Unexpected structured fields')
  return { index: integer(v['index']), label: text(v['label']) }
}
const binary = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== 65536)
    throw new TypeError('Expected exact 64 KiB binary workload')
  return value
}
export interface TransportPageReport {
  readonly handoffMs: number
  readonly structuredMs: number
  readonly binaryMs: number
  readonly cancellationMs: number
  readonly throttledMs: number
  readonly clientFrames: number
  readonly clientBytes: number
}
export function pageReport(value: unknown): TransportPageReport {
  const v = object(value)
  if (
    Object.keys(v).sort().join(',') !==
    'binaryMs,cancellationMs,clientBytes,clientFrames,handoffMs,structuredMs,throttledMs'
  )
    throw new TypeError('Unexpected report fields')
  const clientFrames = integer(v['clientFrames'])
  const clientBytes = v['clientBytes']
  if (
    typeof clientBytes !== 'number' ||
    !Number.isSafeInteger(clientBytes) ||
    clientBytes < 0 ||
    clientBytes > 2 * 1024 * 1024 ||
    clientFrames > 128
  )
    throw new TypeError('Invalid client queue bounds')
  return {
    handoffMs: number(v['handoffMs']),
    structuredMs: number(v['structuredMs']),
    binaryMs: number(v['binaryMs']),
    cancellationMs: number(v['cancellationMs']),
    throttledMs: number(v['throttledMs']),
    clientFrames,
    clientBytes,
  }
}
export const transportSchema = defineRpc({
  structured: procedure(structured, structured),
  binary: procedure(binary, binary),
  cancel: procedure(integer, none),
  cancelState: procedure(integer, text),
  barrier: procedure(text, text),
  report: procedure(pageReport, none),
  hold: procedure(text, text),
  holdState: procedure(text, text),
})
