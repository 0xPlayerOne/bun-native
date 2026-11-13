import { ProtocolError } from './framing.ts'

export const MAX_TEXT_BYTES = 16_384
export const MAX_TITLE_BYTES = 256
const encoder = new TextEncoder()

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError('Message must be an object')
  return value as Record<string, unknown>
}

/** A message's accepted property names, hoisted to module scope so validation allocates nothing. */
export function fields(...names: readonly string[]): ReadonlySet<string> {
  return new Set(names)
}

/** Reject own enumerable properties outside `allowed`; inherited keys are ignored. */
export function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new ProtocolError('Unknown message property: ' + key)
}

export function number(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new ProtocolError(field + ' must be finite and between ' + min + ' and ' + max)
  return value
}

export function integer(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  const result = number(value, field, min, max)
  if (!Number.isSafeInteger(result)) throw new ProtocolError(field + ' must be a safe integer')
  return result
}

export function id(value: unknown): number {
  return integer(value, 'Identifier', 1)
}

/**
 * UTF-8 length bound without encoding when the UTF-16 length decides it: each
 * code unit encodes to one to three bytes (a surrogate pair to four).
 */
function withinBytes(value: string, limit: number): boolean {
  if (value.length > limit) return false
  if (value.length * 3 <= limit) return true
  return encoder.encode(value).byteLength <= limit
}

export function string(value: unknown, field: string, limit = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || !withinBytes(value, limit))
    throw new ProtocolError(field + ' must be a string within ' + limit + ' UTF-8 bytes')
  if (!value.isWellFormed()) throw new ProtocolError(field + ' contains an unpaired surrogate')
  if (value.includes('\0')) throw new ProtocolError(field + ' contains a NUL character')
  return value
}
