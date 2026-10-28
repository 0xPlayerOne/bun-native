import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'
import type { ManagedFailureDiagnostics } from './evidence.ts'

export const RESTART_DEADLINE_MS = 15_000
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected object')
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new TypeError('Unexpected restart fields')
}
const text = (value: unknown, maximum = 256): string => {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0'))
    throw new TypeError('Expected bounded text')
  return value
}
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new TypeError('Expected boolean')
  return value
}
const integer = (value: unknown, maximum: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)
    throw new TypeError('Expected bounded integer')
  return Number(value)
}
const checksum = (value: unknown): string => {
  const result = text(value, 64)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('Expected configuration SHA-256')
  return result
}
const none = (value: unknown): null => {
  if (value !== null) throw new TypeError('Expected null')
  return null
}
export interface RestartInitialReceipt {
  readonly instance: string
  readonly formEmpty: boolean
  readonly sessionAbsent: boolean
  readonly loginAbsent: boolean
}
export interface RestartBackendReceipt {
  readonly revision: number
  readonly shared: number
  readonly configurationApplied: boolean
  readonly configurationSha256: string
  readonly loginAbsent: boolean
  readonly document: string
  readonly url: string
  readonly session: string
}
export interface RestartRendererReceipt extends RestartInitialReceipt {
  readonly revision: number
  readonly shared: number
  readonly configurationApplied: boolean
  readonly configurationSha256: string
}
function initialFields(row: Record<string, unknown>): RestartInitialReceipt {
  return {
    instance: text(row['instance']),
    formEmpty: boolean(row['formEmpty']),
    sessionAbsent: boolean(row['sessionAbsent']),
    loginAbsent: boolean(row['loginAbsent']),
  }
}
function initial(value: unknown): RestartInitialReceipt {
  const row = object(value)
  exact(row, ['instance', 'formEmpty', 'sessionAbsent', 'loginAbsent'])
  return initialFields(row)
}
export function restartBackendReceipt(value: unknown): RestartBackendReceipt {
  const row = object(value)
  exact(row, [
    'revision',
    'shared',
    'configurationApplied',
    'configurationSha256',
    'loginAbsent',
    'document',
    'url',
    'session',
  ])
  return {
    revision: integer(row['revision'], 500),
    shared: integer(row['shared'], 1),
    configurationApplied: boolean(row['configurationApplied']),
    configurationSha256: checksum(row['configurationSha256']),
    loginAbsent: boolean(row['loginAbsent']),
    document: text(row['document']),
    url: text(row['url']),
    session: text(row['session']),
  }
}
function renderer(value: unknown): RestartRendererReceipt {
  const row = object(value)
  exact(row, [
    'instance',
    'formEmpty',
    'sessionAbsent',
    'loginAbsent',
    'revision',
    'shared',
    'configurationApplied',
    'configurationSha256',
  ])
  return {
    ...initialFields(row),
    revision: integer(row['revision'], 500),
    shared: integer(row['shared'], 1),
    configurationApplied: boolean(row['configurationApplied']),
    configurationSha256: checksum(row['configurationSha256']),
  }
}
export const restartSchema = defineRpc({
  begin: procedure(initial, restartBackendReceipt),
  finish: procedure(renderer, none),
  fail: procedure(text, none),
})
export const restartRpcLimits = Object.freeze({
  maxFrameBytes: 16 * 1024,
  maxMetadataBytes: 1024,
  maxTimeoutMs: 10_000,
})

export interface ManagedRestartResult {
  readonly event: 'bunly.managed-restart'
  readonly schema: 1
  readonly passed: boolean
  readonly backend: RestartBackendReceipt | null
  readonly renderer: RestartRendererReceipt | null
  readonly identities: {
    readonly window: string
    readonly view: string
    readonly session: string
    readonly document: string
    readonly url: string
  } | null
  readonly final: {
    readonly owner: Record<string, unknown>
    readonly broker: Record<string, unknown>
    readonly desktop: Record<string, unknown>
    readonly development: Record<string, unknown>
    readonly native: Record<string, unknown>
    readonly nativeSnapshotPhase: 'before-last-window-close'
  }
  readonly requests: {
    readonly accepted: number
    readonly settled: number
    readonly pending: number
  }
  readonly failureCode?: string
  readonly diagnostics?: ManagedFailureDiagnostics
}
