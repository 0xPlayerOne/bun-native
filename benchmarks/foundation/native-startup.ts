import { distribution } from './statistics.ts'

export const nativeStartupStageNames = [
  'sessionMs',
  'windowMs',
  'viewMs',
  'focusMs',
  'backendToReadyMs',
] as const
export type NativeStartupStage = (typeof nativeStartupStageNames)[number]
export type NativeStartupStages = Readonly<Record<NativeStartupStage, number>>

/** Fixed fixture diagnostics, bounded by its existing 15-second completion deadline. */
export function nativeStartupStages(input: unknown): NativeStartupStages {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Missing native startup stages')
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== nativeStartupStageNames.length)
    throw new Error('Unexpected native startup stages')
  const result: Record<string, number> = {}
  for (const name of nativeStartupStageNames) {
    const duration = value[name]
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 15000
    )
      throw new Error('Invalid native startup stage: ' + name)
    result[name] = duration
  }
  return result as NativeStartupStages
}

/** Each completed launch contributes one observation per stage. */
export function nativeStartupSummary(trials: readonly NativeStartupStages[]) {
  return Object.fromEntries(
    nativeStartupStageNames.map((name) => [name, distribution(trials.map((trial) => trial[name]))])
  ) as Record<NativeStartupStage, ReturnType<typeof distribution>>
}
