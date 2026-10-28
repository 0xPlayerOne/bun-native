import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

export interface DesktopPageReceipt {
  readonly instance: string
  readonly width: number
  readonly height: number
  readonly devicePixelRatio: number
}
export interface DesktopVisibility {
  readonly sequence: number
  readonly visibility: 'visible' | 'hidden'
}

export const desktopControlsSchema = defineRpc({
  ready: procedure(
    (input: unknown): DesktopPageReceipt => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid desktop page receipt')
      const row = input as Record<string, unknown>
      if (
        Object.keys(row).sort().join(',') !== 'devicePixelRatio,height,instance,width' ||
        typeof row['instance'] !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(row['instance']) ||
        !Number.isSafeInteger(row['width']) ||
        Number(row['width']) < 1 ||
        Number(row['width']) > 32768 ||
        !Number.isSafeInteger(row['height']) ||
        Number(row['height']) < 1 ||
        Number(row['height']) > 32768 ||
        typeof row['devicePixelRatio'] !== 'number' ||
        !Number.isFinite(row['devicePixelRatio']) ||
        row['devicePixelRatio'] <= 0 ||
        row['devicePixelRatio'] > 16
      )
        throw new Error('Invalid desktop page receipt')
      return {
        instance: row['instance'],
        width: Number(row['width']),
        height: Number(row['height']),
        devicePixelRatio: row['devicePixelRatio'],
      }
    },
    (input: unknown): null => {
      if (input !== null) throw new Error('Invalid desktop page acknowledgment')
      return null
    }
  ),
  visibility: procedure(
    (input: unknown): DesktopVisibility => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid desktop visibility')
      const row = input as Record<string, unknown>
      if (
        Object.keys(row).sort().join(',') !== 'sequence,visibility' ||
        !Number.isSafeInteger(row['sequence']) ||
        Number(row['sequence']) < 0 ||
        Number(row['sequence']) >= 5 ||
        !['hidden', 'visible'].includes(String(row['visibility']))
      )
        throw new Error('Invalid desktop visibility')
      return {
        sequence: Number(row['sequence']),
        visibility: row['visibility'] as 'visible' | 'hidden',
      }
    },
    (input: unknown): null => {
      if (input !== null) throw new Error('Invalid desktop visibility acknowledgment')
      return null
    }
  ),
})
