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
