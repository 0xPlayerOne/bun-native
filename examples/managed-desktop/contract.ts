import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

export const TOTAL_REPLACEMENTS = 500
export const LOGIN_MARKER = 'managed-synthetic-login'
export const FORM_MARKER = 'unsaved café-🐙 work'
export const SESSION_MARKER = 'managed-session-storage'
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected object')
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new TypeError('Unexpected fields')
}
const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new TypeError('Expected bounded text')
  return value
}
const integer = (value: unknown, max = 1_000_000): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new TypeError('Expected bounded integer')
  return Number(value)
}
const none = (value: unknown): null => {
  if (value !== null) throw new TypeError('Expected null')
  return null
}
export type ManagedAction =
  | 'advance'
  | 'syntax'
  | 'import'
  | 'initialization'
  | 'closed-resource'
  | 'runtime-handler'
  | 'frontend'
  | 'restart'
const command = (value: unknown): { action: ManagedAction; revision: number } => {
  const row = object(value)
  exact(row, ['action', 'revision'])
  const action = text(row['action'])
  if (
    ![
      'advance',
      'syntax',
      'import',
      'initialization',
      'closed-resource',
      'runtime-handler',
      'frontend',
      'restart',
    ].includes(action)
  )
    throw new TypeError('Unknown action')
  return { action: action as ManagedAction, revision: integer(row['revision'], TOTAL_REPLACEMENTS) }
}
export interface RendererReceipt {
  readonly revision: number
  readonly shared: number
  readonly frontend: number
  readonly form: string
  readonly session: string
  readonly login: string
  readonly instance: string
  readonly terminalSequence: number
  readonly terminalAck: number
}
const receipt = (value: unknown): RendererReceipt => {
  const row = object(value)
  exact(row, [
    'revision',
    'shared',
    'frontend',
    'form',
    'session',
    'login',
    'instance',
    'terminalSequence',
    'terminalAck',
  ])
  return {
    revision: integer(row['revision'], TOTAL_REPLACEMENTS),
    shared: integer(row['shared'], 1),
    frontend: integer(row['frontend'], 2),
    form: text(row['form']),
    session: text(row['session']),
    login: text(row['login']),
    instance: text(row['instance']),
    terminalSequence: integer(row['terminalSequence'], 20_000),
    terminalAck: integer(row['terminalAck'], TOTAL_REPLACEMENTS),
  }
}
export interface TerminalReceipt {
  readonly bytes: number
  readonly hash: string
  readonly records: number
  readonly lastSequence: number
  readonly acks: number
}
const terminalReceipt = (value: unknown): TerminalReceipt => {
  const row = object(value)
  exact(row, ['bytes', 'hash', 'records', 'lastSequence', 'acks'])
  const hash = text(row['hash'], 8)
  if (!/^[a-f0-9]{8}$/.test(hash)) throw new TypeError('Expected fixture byte hash')
  return {
    bytes: integer(row['bytes'], 4 * 1024 * 1024),
    hash,
    records: integer(row['records'], 20_000),
    lastSequence: integer(row['lastSequence'], 20_000),
    acks: integer(row['acks'], TOTAL_REPLACEMENTS + 1),
  }
}
export const managedSchema = defineRpc({
  begin: procedure(none, (value) => text(value, 16_384)),
  step: procedure(command, (value) => text(value, 16_384)),
  readback: procedure(none, (value) => text(value, 16_384)),
  verify: procedure(receipt, none),
  pending: procedure(none, text),
  endTerminal: procedure(none, none),
  finish: procedure(terminalReceipt, none),
  fail: procedure(text, none),
})
export const managedRpcLimits = Object.freeze({
  maxFrameBytes: 32 * 1024,
  maxMetadataBytes: 1024,
  maxTimeoutMs: 15_000,
})
/** Non-cryptographic streaming byte check, paired with exact record sequence checks. */
export function updateByteHash(hash: number, bytes: Uint8Array): number {
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash
}
export const byteHashText = (hash: number): string => hash.toString(16).padStart(8, '0')
