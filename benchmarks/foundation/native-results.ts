import { distribution } from './statistics.ts'

export const assetKinds = ['full', 'range', 'head', 'conditional'] as const
type AssetKind = (typeof assetKinds)[number]
interface Responsiveness {
  readonly inputToFrameMs: readonly number[]
  readonly frameIntervalsMs: readonly number[]
  readonly backgroundSamples: number
}
export interface NativeMeasurement {
  readonly kind: 'result'
  readonly schema: 1
  readonly samples: 32
  readonly idle: Responsiveness
  readonly active: Responsiveness
  readonly counts: Readonly<Record<AssetKind, number>>
  readonly requestMs: Readonly<Record<AssetKind, readonly number[]>>
  readonly activeElapsedMs: number
  readonly syntheticInputEvents: 64
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing native profile object')
  return value as Record<string, unknown>
}
function samples(value: unknown, count: number) {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some(
      (item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 30000
    )
  )
    throw new Error('Invalid native profile observations')
}
export function nativeMeasurement(input: unknown): NativeMeasurement {
  const value = object(input)
  if (
    value['kind'] !== 'result' ||
    value['schema'] !== 1 ||
    value['samples'] !== 32 ||
    value['syntheticInputEvents'] !== 64
  )
    throw new Error('Incomplete native profile workload')
  for (const phase of ['idle', 'active']) {
    const response = object(value[phase])
    samples(response['inputToFrameMs'], 32)
    samples(response['frameIntervalsMs'], 32)
    if (response['backgroundSamples'] !== (phase === 'active' ? 32 : 0))
      throw new Error('Asset work did not overlap the measured samples')
  }
  const counts = object(value['counts']),
    requests = object(value['requestMs'])
  for (const kind of assetKinds) {
    const count = counts[kind]
    if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 64)
      throw new Error('Incomplete asset load workload')
    samples(requests[kind], Number(count))
  }
  const elapsed = value['activeElapsedMs']
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 15000)
    throw new Error('Invalid active workload duration')
  return input as NativeMeasurement
}

/** Each trial is the independent observation; do not pool correlated frames into a fake large n. */
export function nativeSummary(
  trials: readonly { startupToReadyMs: number; measurement: NativeMeasurement }[]
) {
  return {
    startupToReadyMs: distribution(trials.map((trial) => trial.startupToReadyMs)),
    perTrialIdleInputMedianMs: distribution(
      trials.map((trial) => distribution(trial.measurement.idle.inputToFrameMs).median)
    ),
    perTrialActiveInputMedianMs: distribution(
      trials.map((trial) => distribution(trial.measurement.active.inputToFrameMs).median)
    ),
    perTrialIdleInputP95Ms: distribution(
      trials.map((trial) => distribution(trial.measurement.idle.inputToFrameMs).p95)
    ),
    perTrialActiveInputP95Ms: distribution(
      trials.map((trial) => distribution(trial.measurement.active.inputToFrameMs).p95)
    ),
    perTrialActiveFrameP95Ms: distribution(
      trials.map((trial) => distribution(trial.measurement.active.frameIntervalsMs).p95)
    ),
    perTrialActiveElapsedMs: distribution(trials.map((trial) => trial.measurement.activeElapsedMs)),
    requests: Object.fromEntries(
      assetKinds.map((kind) => [
        kind,
        {
          perTrialCount: trials.map((trial) => trial.measurement.counts[kind]),
          perTrialMedianMs: distribution(
            trials.map((trial) => distribution(trial.measurement.requestMs[kind]).median)
          ),
        },
      ])
    ),
  }
}
