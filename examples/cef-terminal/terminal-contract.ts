import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

export const TERMINAL_COUNT = 2
export const TERMINAL_RECORDS = 32
export const TERMINAL_COLS = 96
export const TERMINAL_ROWS = 28
export const RESIZED_COLS = 111
export const RESIZED_ROWS = 37

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected object')
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, fields: readonly string[]) => {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(','))
    throw new TypeError('Unexpected fields')
}
const text = (value: unknown, limit = 128): string => {
  if (typeof value !== 'string' || !value || value.length > limit || value.includes('\0'))
    throw new TypeError('Expected bounded text')
  return value
}
const integer = (value: unknown, maximum = 1_000_000): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)
    throw new TypeError('Expected bounded integer')
  return Number(value)
}
const finite = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 600_000)
    throw new TypeError('Expected bounded duration')
  return value
}
const none = (value: unknown): null => {
  if (value !== null) throw new TypeError('Expected null')
  return null
}

export type TerminalAction =
  | 'input'
  | 'resize'
  | 'binary'
  | 'emit'
  | 'stall'
  | 'overload'
  | 'exit'
  | 'cancel'
export interface TerminalControl {
  readonly terminal: number
  readonly action: TerminalAction
  readonly value: string
}
const control = (value: unknown): TerminalControl => {
  const row = object(value)
  exact(row, ['terminal', 'action', 'value'])
  const action = text(row['action'])
  if (
    !['input', 'resize', 'binary', 'emit', 'stall', 'overload', 'exit', 'cancel'].includes(action)
  )
    throw new TypeError('Unknown terminal action')
  return {
    terminal: integer(row['terminal'], 2),
    action: action as TerminalAction,
    value: text(row['value'], 2048),
  }
}

export interface TerminalRecordReceipt {
  readonly terminal: number
  readonly records: number
  readonly bytes: number
  readonly sha256: string
  readonly order: readonly number[]
  readonly callbacks: number
  readonly callbackDurationsMs: readonly number[]
  readonly recordContentsVerified: boolean
  readonly unicodeObserved: boolean
}
const checksum = (value: unknown): string => {
  const result = text(value, 64)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('Expected SHA-256')
  return result
}
const durations = (value: unknown): readonly number[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096)
    throw new TypeError('Expected callback durations')
  return Object.freeze(value.map(finite))
}
const recordReceipt = (value: unknown): TerminalRecordReceipt => {
  const row = object(value)
  exact(row, [
    'terminal',
    'records',
    'bytes',
    'sha256',
    'order',
    'callbacks',
    'callbackDurationsMs',
    'unicodeObserved',
    'recordContentsVerified',
  ])
  if (!Array.isArray(row['order'])) throw new TypeError('Expected record order')
  return Object.freeze({
    terminal: integer(row['terminal'], 2),
    records: integer(row['records'], 4096),
    bytes: integer(row['bytes'], 64 * 1024 * 1024),
    sha256: checksum(row['sha256']),
    order: Object.freeze(row['order'].map((entry) => integer(entry, 4096))),
    callbacks: integer(row['callbacks'], 4096),
    callbackDurationsMs: durations(row['callbackDurationsMs']),
    unicodeObserved: row['unicodeObserved'] === true,
    recordContentsVerified: row['recordContentsVerified'] === true,
  })
}

export interface TerminalPageReport {
  readonly terminals: readonly TerminalRecordReceipt[]
  readonly controlRoundtripsMs: readonly number[]
  readonly heldConsumer: boolean
  readonly rpcWhileHeld: boolean
  readonly siblingWhileHeld: boolean
  readonly parserCallbacks: boolean
  readonly totalElapsedMs: number
}
export const pageReport = (value: unknown): TerminalPageReport => {
  const row = object(value)
  exact(row, [
    'terminals',
    'controlRoundtripsMs',
    'heldConsumer',
    'rpcWhileHeld',
    'siblingWhileHeld',
    'parserCallbacks',
    'totalElapsedMs',
  ])
  if (!Array.isArray(row['terminals']) || row['terminals'].length !== TERMINAL_COUNT)
    throw new TypeError('Expected exact terminal receipts')
  const terminals = row['terminals'].map(recordReceipt)
  if (new Set(terminals.map((entry) => entry.terminal)).size !== TERMINAL_COUNT)
    throw new TypeError('Duplicate terminal receipt')
  return Object.freeze({
    terminals: Object.freeze(terminals),
    controlRoundtripsMs: durations(row['controlRoundtripsMs']),
    heldConsumer: row['heldConsumer'] === true,
    rpcWhileHeld: row['rpcWhileHeld'] === true,
    siblingWhileHeld: row['siblingWhileHeld'] === true,
    parserCallbacks: row['parserCallbacks'] === true,
    totalElapsedMs: finite(row['totalElapsedMs']),
  })
}

const gate = (value: unknown) => {
  const row = object(value)
  exact(row, ['name', 'action'])
  const name = text(row['name'])
  const action = text(row['action'])
  if (name !== 'consumer-0' || !['held', 'release'].includes(action))
    throw new TypeError('Invalid gate event')
  return { name, action }
}

export const terminalSchema = defineRpc({
  control: procedure(control, none),
  gate: procedure(gate, text),
  progress: procedure(none, text),
  report: procedure(pageReport, none),
})

export const terminalRpcLimits = Object.freeze({
  maxFrameBytes: 96 * 1024,
  maxMetadataBytes: 16 * 1024,
  maxTimeoutMs: 15_000,
})
