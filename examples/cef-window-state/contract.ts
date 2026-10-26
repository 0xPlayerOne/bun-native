import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

export interface PageVisibility {
  readonly sequence: number
  readonly visibility: 'visible' | 'hidden'
}
export const visibilitySchema = defineRpc({
  visibility: procedure(
    (value: unknown): PageVisibility => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid visibility')
      const row = value as Record<string, unknown>
      if (
        Object.keys(row).sort().join(',') !== 'sequence,visibility' ||
        !Number.isSafeInteger(row['sequence']) ||
        Number(row['sequence']) < 0 ||
        Number(row['sequence']) > 16 ||
        (row['visibility'] !== 'visible' && row['visibility'] !== 'hidden')
      )
        throw new Error('Invalid visibility')
      return { sequence: Number(row['sequence']), visibility: row['visibility'] }
    },
    (value: unknown): null => {
      if (value !== null) throw new Error('Invalid visibility acknowledgment')
      return null
    }
  ),
})

/** Bounded diagnostic only. It never substitutes for an authenticated RPC receipt. */
export function parseVisibilityStage(message: unknown): Record<string, unknown> | null {
  const prefix = 'BUNLY_WINDOW_STAGE:'
  if (typeof message !== 'string' || !message.startsWith(prefix) || message.length > 256)
    return null
  try {
    const value: unknown = JSON.parse(message.slice(prefix.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (
      Object.keys(row).sort().join(',') !== 'sequence,stage,visibility' ||
      !Number.isSafeInteger(row['sequence']) ||
      Number(row['sequence']) < 0 ||
      Number(row['sequence']) >= 16 ||
      !['observed', 'sending', 'acknowledged', 'failed'].includes(String(row['stage'])) ||
      !['hidden', 'visible'].includes(String(row['visibility']))
    )
      return null
    return { sequence: row['sequence'], visibility: row['visibility'], stage: row['stage'] }
  } catch {
    return null
  }
}
