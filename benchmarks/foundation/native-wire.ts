import { assetKinds, nativeMeasurement } from './native-results.ts'
import type { NativeMeasurement } from './native-results.ts'

export const nativeTitlePrefix = 'bunly.foundation:'
export const maxNativeTitleBytes = 4096

/** Fixed-size measurement encoding for the host's existing 4096-byte title event limit. */
export function encodeNativeTitle(input: unknown): string {
  const value = nativeMeasurement(input)
  const microseconds = (values: readonly number[]) =>
    values.map((sample) => Math.round(sample * 1000))
  const title =
    nativeTitlePrefix +
    JSON.stringify({
      kind: 'result',
      schema: 1,
      samples: 32,
      us: [
        value.idle.inputToFrameMs,
        value.idle.frameIntervalsMs,
        value.active.inputToFrameMs,
        value.active.frameIntervalsMs,
        ...assetKinds.map((kind) => value.requestMs[kind]),
      ].map(microseconds),
      background: [0, 32],
      activeElapsedUs: Math.round(value.activeElapsedMs * 1000),
      syntheticInputEvents: 64,
      assetSemantics: 9,
    })
  // Every duration has at most eight decimal digits. With all 384 allowed samples,
  // the complete ASCII title is at most 3629 bytes; retain the explicit guard.
  if (new TextEncoder().encode(title).byteLength > maxNativeTitleBytes)
    throw new Error('Oversized native profiling title')
  return title
}

/** Decode only a complete, bounded measurement; renderer titles carry no authority. */
export function decodeNativeTitle(title: string): NativeMeasurement {
  if (
    title.length > maxNativeTitleBytes ||
    !title.startsWith(nativeTitlePrefix) ||
    new TextEncoder().encode(title).byteLength > maxNativeTitleBytes
  )
    throw new Error('Invalid native profiling title')
  const parsed: unknown = JSON.parse(title.slice(nativeTitlePrefix.length))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Missing native profiling wire object')
  const value = parsed as Record<string, unknown>
  if (
    value['kind'] !== 'result' ||
    value['schema'] !== 1 ||
    value['samples'] !== 32 ||
    value['syntheticInputEvents'] !== 64 ||
    value['assetSemantics'] !== 9
  )
    throw new Error('Incomplete native profiling wire workload')
  const arrays = value['us']
  if (!Array.isArray(arrays) || arrays.length !== 8)
    throw new Error('Invalid native profiling wire arrays')
  const milliseconds = arrays.map((observations: unknown, index: number) => {
    if (
      !Array.isArray(observations) ||
      (index < 4
        ? observations.length !== 32
        : observations.length < 1 || observations.length > 64) ||
      observations.some(
        (sample: unknown) =>
          typeof sample !== 'number' ||
          !Number.isSafeInteger(sample) ||
          sample < 0 ||
          sample > 30000000
      )
    )
      throw new Error('Invalid native profiling wire observations')
    return observations.map((sample: number) => sample / 1000)
  })
  const background = value['background'],
    elapsed = value['activeElapsedUs']
  if (
    !Array.isArray(background) ||
    background.length !== 2 ||
    background[0] !== 0 ||
    background[1] !== 32 ||
    typeof elapsed !== 'number' ||
    !Number.isSafeInteger(elapsed) ||
    elapsed < 0 ||
    elapsed > 15000000
  )
    throw new Error('Invalid native profiling wire phases')
  return nativeMeasurement({
    kind: 'result',
    schema: 1,
    samples: 32,
    idle: {
      inputToFrameMs: milliseconds[0],
      frameIntervalsMs: milliseconds[1],
      backgroundSamples: 0,
    },
    active: {
      inputToFrameMs: milliseconds[2],
      frameIntervalsMs: milliseconds[3],
      backgroundSamples: 32,
    },
    counts: Object.fromEntries(
      assetKinds.map((kind, index) => [kind, milliseconds[index + 4]!.length])
    ),
    requestMs: Object.fromEntries(assetKinds.map((kind, index) => [kind, milliseconds[index + 4]])),
    activeElapsedMs: elapsed / 1000,
    syntheticInputEvents: 64,
    assetSemantics: 9,
  })
}
