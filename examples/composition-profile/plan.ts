/** Fixed descriptive workload. Counts and cadence are not runtime deadline overrides. */
export const compositionPlan = [
  { name: 'warmup', durationMs: 2000, operations: 0, cadenceMs: 0 },
  { name: 'idle', durationMs: 4000, operations: 0, cadenceMs: 0 },
  { name: 'resize', durationMs: 4000, operations: 40, cadenceMs: 100 },
  { name: 'overlay', durationMs: 4000, operations: 16, cadenceMs: 250 },
  { name: 'recreate', durationMs: 4000, operations: 4, cadenceMs: 1000 },
  { name: 'recovery', durationMs: 4000, operations: 0, cadenceMs: 0 },
] as const
export type CompositionPhase = (typeof compositionPlan)[number]['name']
export const compositionPhaseMarkers = [
  ...compositionPlan.map((phase) => `composition-${phase.name}`),
  'composition-complete',
] as const
export interface CompositionPhaseReceipt {
  readonly name: CompositionPhase
  readonly startedMs: number
  readonly endedMs: number
  readonly operationMs: readonly number[]
  readonly visible: boolean
  readonly minimized: boolean
  readonly activeAtStart: boolean
}
export const compositionRectangles = {
  left: { x: 16, y: 16, width: 350, height: 500 },
  right: { x: 400, y: 16, width: 350, height: 500 },
  overlay: { x: 230, y: 160, width: 350, height: 230 },
} as const
export function compositionResize(index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 40)
    throw new Error('Invalid composition resize index')
  return {
    ...compositionRectangles.left,
    width: 350 + (index % 5) * 8,
    height: 460 + (index % 5) * 8,
  }
}
