import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'

export const panes = ['left', 'right', 'overlay'] as const
export type Pane = (typeof panes)[number]
export interface CompositionPage {
  readonly pane: Pane
  readonly sequence: number
  readonly instance: string
  readonly width: number
  readonly height: number
  readonly visibility: 'visible' | 'hidden'
  readonly focused: boolean
  readonly form: string
  readonly session: string
  readonly devicePixelRatio: number
}
export function compositionMarker(pane: Pane): string {
  return `bunly-composition-${pane}`
}
export function parseCompositionPage(value: unknown): CompositionPage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid composition page')
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join(',') !==
      'devicePixelRatio,focused,form,height,instance,pane,sequence,session,visibility,width' ||
    !panes.includes(row['pane'] as Pane) ||
    !Number.isSafeInteger(row['sequence']) ||
    Number(row['sequence']) < 0 ||
    Number(row['sequence']) >= 128 ||
    !Number.isSafeInteger(row['width']) ||
    Number(row['width']) < 0 ||
    Number(row['width']) > 32768 ||
    !Number.isSafeInteger(row['height']) ||
    Number(row['height']) < 0 ||
    Number(row['height']) > 32768 ||
    typeof row['instance'] !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(row['instance']) ||
    (row['visibility'] !== 'visible' && row['visibility'] !== 'hidden') ||
    typeof row['focused'] !== 'boolean' ||
    typeof row['form'] !== 'string' ||
    row['form'].length > 64 ||
    typeof row['session'] !== 'string' ||
    row['session'].length > 64 ||
    typeof row['devicePixelRatio'] !== 'number' ||
    !Number.isFinite(row['devicePixelRatio']) ||
    row['devicePixelRatio'] <= 0 ||
    row['devicePixelRatio'] > 16
  )
    throw new Error('Invalid composition page')
  return Object.freeze({ ...row }) as unknown as CompositionPage
}
export const compositionSchema = defineRpc({
  observe: procedure(parseCompositionPage, (value: unknown): { stop: boolean } => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'stop' ||
      typeof (value as { stop?: unknown }).stop !== 'boolean'
    )
      throw new Error('Invalid composition acknowledgement')
    return { stop: (value as { stop: boolean }).stop }
  }),
})
