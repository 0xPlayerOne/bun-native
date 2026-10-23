import type { CommandObservation } from '../lib/observed-command.ts'
import { distribution } from './statistics.ts'

export const nativeShutdownPhaseNames = [
  'process-stop',
  'host-release',
  'asset-service-stop',
  'cef-shutdown',
] as const
export type NativeShutdownPhase = (typeof nativeShutdownPhaseNames)[number]
export type NativeShutdownStages = Readonly<Record<NativeShutdownPhase, number>>
export interface NativeShutdownObservation {
  readonly schema: 1
  readonly complete: boolean
  readonly malformed: boolean
  readonly pendingPhase: NativeShutdownPhase | null
  readonly durationsMs: Readonly<Record<NativeShutdownPhase, number | null>>
  readonly backendExitedNormally: boolean
  readonly hostReportedClean: boolean
  readonly hostReportedFailure: boolean
}

/** Diagnostic events from the trusted fixture, not renderer authentication.
 * Missing durations remain null. All conditions are retained even when the
 * command also fails, without copying child text, paths, IDs or payloads.
 */
export function observeNativeShutdown(
  observation: Pick<CommandObservation, 'stderr'>
): NativeShutdownObservation {
  const durationsMs: Record<NativeShutdownPhase, number | null> = {
    'process-stop': null,
    'host-release': null,
    'asset-service-stop': null,
    'cef-shutdown': null,
  }
  let step = 0
  let malformed = false
  let backendCount = 0
  let hostCount = 0
  let backendExitedNormally = false
  let hostReportedClean = false
  let hostReportedFailure = false
  for (const line of observation.stderr) {
    let event: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      event = value as Record<string, unknown>
    } catch {
      // Ordinary Chromium text stays in the private raw observation.
      continue
    }
    if (event['event'] === 'bunly.host.shutdown-phase') {
      const phase = nativeShutdownPhaseNames[Math.floor(step / 2)]
      const state = step % 2 === 0 ? 'start' : 'complete'
      if (!phase || event['phase'] !== phase || event['state'] !== state || hostCount !== 0) {
        malformed = true
        continue
      }
      if (state === 'complete') {
        const duration = event['durationMs']
        // This is an input bound matching the observer's maximum command
        // duration, not a speed threshold or a native watchdog extension.
        if (!Number.isSafeInteger(duration) || Number(duration) < 0 || Number(duration) > 600000) {
          malformed = true
          continue
        }
        durationsMs[phase] = Number(duration)
      }
      step++
    } else if (event['event'] === 'bunly.backend.exit') {
      backendCount++
      if (
        backendCount !== 1 ||
        step !== 1 ||
        (event['code'] !== null && !Number.isSafeInteger(event['code'])) ||
        typeof event['forced'] !== 'boolean'
      ) {
        malformed = true
      }
      backendExitedNormally = event['code'] === 0 && event['forced'] === false
    } else if (event['event'] === 'bunly.host.shutdown') {
      hostCount++
      if (
        hostCount !== 1 ||
        step !== nativeShutdownPhaseNames.length * 2 ||
        typeof event['clean'] !== 'boolean'
      ) {
        malformed = true
      }
      hostReportedClean = event['clean'] === true
    } else if (event['event'] === 'bunly.host.failure' || event['event'] === 'bunly.host.error') {
      hostReportedFailure = true
    }
  }
  return Object.freeze({
    schema: 1,
    complete:
      !malformed &&
      step === nativeShutdownPhaseNames.length * 2 &&
      backendCount === 1 &&
      hostCount === 1 &&
      backendExitedNormally &&
      hostReportedClean &&
      !hostReportedFailure,
    malformed,
    pendingPhase: step % 2 === 1 ? nativeShutdownPhaseNames[Math.floor(step / 2)]! : null,
    durationsMs: Object.freeze(durationsMs),
    backendExitedNormally,
    hostReportedClean,
    hostReportedFailure,
  })
}

/** Call only after command/descendant acceptance; neither gate replaces the other. */
export function requireNativeShutdown(value: NativeShutdownObservation): NativeShutdownStages {
  if (
    !value.complete ||
    value.malformed ||
    value.hostReportedFailure ||
    !value.backendExitedNormally ||
    !value.hostReportedClean ||
    value.pendingPhase !== null
  ) {
    throw new Error('Incomplete or malformed native shutdown sequence')
  }
  const result = {} as Record<NativeShutdownPhase, number>
  for (const phase of nativeShutdownPhaseNames) {
    const duration = value.durationsMs[phase]
    if (!Number.isSafeInteger(duration) || duration === null || duration < 0 || duration > 600000)
      throw new Error('Incomplete or malformed native shutdown duration')
    result[phase] = duration
  }
  return Object.freeze(result)
}

/** One value per completed launch; partial/failed launches never contribute zero. */
export function nativeShutdownSummary(trials: readonly NativeShutdownStages[]) {
  return Object.fromEntries(
    nativeShutdownPhaseNames.map((phase) => [
      phase,
      distribution(trials.map((trial) => trial[phase])),
    ])
  ) as Record<NativeShutdownPhase, ReturnType<typeof distribution>>
}
