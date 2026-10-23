import { expect, test } from 'bun:test'
import { distribution, profileOptions } from '../benchmarks/foundation/statistics.ts'
import { nativeMeasurement } from '../benchmarks/foundation/native-results.ts'
import type { NativeMeasurement } from '../benchmarks/foundation/native-results.ts'
import {
  decodeNativeTitle,
  encodeNativeTitle,
  maxNativeTitleBytes,
  nativeTitlePrefix,
} from '../benchmarks/foundation/native-wire.ts'
import {
  nativeStartupStageNames,
  nativeStartupStages,
  nativeStartupSummary,
} from '../benchmarks/foundation/native-startup.ts'

test('profile summaries retain raw observations and reproducible uncertainty', () => {
  const input = [9, 1, 5, 3, 7]
  const actual = distribution(input)
  expect(actual.samples).toEqual(input)
  expect(actual).toEqual(distribution(input))
  expect(actual.median).toBe(5)
  expect(actual.mean).toBe(5)
  expect(actual.min).toBe(1)
  expect(actual.max).toBe(9)
  expect(actual.p90).toBeCloseTo(8.2)
  expect(actual.meanBootstrap95![0]).toBeLessThanOrEqual(5)
  expect(actual.meanBootstrap95![1]).toBeGreaterThanOrEqual(5)
  expect(distribution([4, 4, 4]).meanBootstrap95).toEqual([4, 4])
})

test('profiling rejects invalid samples and unbounded or ambiguous repetitions', () => {
  for (const input of [[], [NaN], [Infinity], [-1], Array<number>(10001).fill(1)])
    expect(() => distribution(input)).toThrow()
  for (const args of [
    ['--samples', '1000000'],
    ['--samples', '4'],
    ['--warmups', '11'],
    ['--samples', '5', '--samples', '9'],
    ['--output'],
    ['--samples', '1e2'],
    ['--unknown', '5'],
  ])
    expect(() => profileOptions(args, 'profile.json')).toThrow()
  expect(profileOptions([], 'profile.json')).toEqual({
    output: 'profile.json',
    samples: 9,
    warmups: 1,
  })
})

test('native profiling rejects incomplete, malformed, or unbounded renderer measurements', () => {
  const input: NativeMeasurement = {
    kind: 'result',
    schema: 1,
    samples: 32,
    idle: {
      inputToFrameMs: Array<number>(32).fill(16),
      frameIntervalsMs: Array<number>(32).fill(16),
      backgroundSamples: 0,
    },
    active: {
      inputToFrameMs: Array<number>(32).fill(18),
      frameIntervalsMs: Array<number>(32).fill(18),
      backgroundSamples: 32,
    },
    counts: { full: 1, range: 1, head: 1, conditional: 1 },
    requestMs: { full: [10], range: [8], head: [7], conditional: [7] },
    activeElapsedMs: 600,
    syntheticInputEvents: 64,
    assetSemantics: 9,
  }
  expect(nativeMeasurement(input)).toEqual(input)
  for (const candidate of [
    null,
    {},
    { ...input, samples: 0 },
    { ...input, syntheticInputEvents: 0 },
    { ...input, assetSemantics: 8 },
    { ...input, counts: { ...input.counts, conditional: 0 } },
    { ...input, counts: { ...input.counts, full: 65 } },
    { ...input, active: { ...input.active, inputToFrameMs: [18] } },
    { ...input, activeElapsedMs: Infinity },
    { ...input, active: { ...input.active, backgroundSamples: 0 } },
    { ...input, requestMs: { ...input.requestMs, head: [-1] } },
  ])
    expect(() => nativeMeasurement(candidate)).toThrow()
})

test('native title encoding preserves every sample within the existing host byte bound', () => {
  const maximum = nativeMeasurement({
    kind: 'result',
    schema: 1,
    samples: 32,
    idle: {
      inputToFrameMs: Array<number>(32).fill(30000),
      frameIntervalsMs: Array<number>(32).fill(30000),
      backgroundSamples: 0,
    },
    active: {
      inputToFrameMs: Array<number>(32).fill(30000),
      frameIntervalsMs: Array<number>(32).fill(30000),
      backgroundSamples: 32,
    },
    counts: { full: 64, range: 64, head: 64, conditional: 64 },
    requestMs: {
      full: Array<number>(64).fill(30000),
      range: Array<number>(64).fill(30000),
      head: Array<number>(64).fill(30000),
      conditional: Array<number>(64).fill(30000),
    },
    activeElapsedMs: 15000,
    syntheticInputEvents: 64,
    assetSemantics: 9,
  })
  const title = encodeNativeTitle(maximum)
  expect(new TextEncoder().encode(title).byteLength).toBe(3629)
  expect(new TextEncoder().encode(title).byteLength).toBeLessThanOrEqual(maxNativeTitleBytes)
  expect(decodeNativeTitle(title)).toEqual(maximum)
  const fractional = {
    ...maximum,
    idle: {
      ...maximum.idle,
      inputToFrameMs: Array.from({ length: 32 }, (_, index) => index / 1000),
    },
    active: { ...maximum.active, frameIntervalsMs: Array<number>(32).fill(16.667) },
    counts: { ...maximum.counts, full: 5 },
    requestMs: { ...maximum.requestMs, full: [0, 0.001, 1.234, 16.667, 30000] },
    activeElapsedMs: 600.001,
  }
  expect(decodeNativeTitle(encodeNativeTitle(fractional))).toEqual(fractional)
})

test('native title decoding rejects oversized, incomplete, and invalid bounded observations', () => {
  const wire = {
    kind: 'result',
    schema: 1,
    samples: 32,
    us: [
      ...Array.from({ length: 4 }, () => Array<number>(32).fill(16667)),
      ...Array.from({ length: 4 }, () => [1000]),
    ],
    background: [0, 32],
    activeElapsedUs: 600001,
    syntheticInputEvents: 64,
    assetSemantics: 9,
  }
  const title = (value: unknown) => nativeTitlePrefix + JSON.stringify(value)
  expect(decodeNativeTitle(title(wire)).activeElapsedMs).toBe(600.001)
  const invalid = [
    null,
    [],
    {},
    { ...wire, schema: 2 },
    { ...wire, samples: 31 },
    { ...wire, syntheticInputEvents: 63 },
    { ...wire, assetSemantics: 8 },
    { ...wire, us: wire.us.slice(1) },
    { ...wire, us: [...wire.us, [1]] },
    { ...wire, us: [[1], ...wire.us.slice(1)] },
    { ...wire, us: [...wire.us.slice(0, 7), []] },
    { ...wire, us: [...wire.us.slice(0, 7), Array<number>(65).fill(1)] },
    ...[-1, 0.5, 30000001, Infinity, NaN].map((sample) => ({
      ...wire,
      us: [...wire.us.slice(0, 7), [sample]],
    })),
    { ...wire, background: [0, 31] },
    { ...wire, background: [0, 32, 32] },
    { ...wire, activeElapsedUs: 15000001 },
    { ...wire, activeElapsedUs: 0.5 },
  ]
  for (const value of invalid) expect(() => decodeNativeTitle(title(value))).toThrow()
  expect(() => decodeNativeTitle('other:' + JSON.stringify(wire))).toThrow()
  expect(() => decodeNativeTitle(title(wire).replace('16667', '1e400'))).toThrow()
  expect(() => decodeNativeTitle(title({ ...wire, padding: '🙂'.repeat(1024) }))).toThrow()
})

test('native startup stages require the complete fixed bounded numeric schema', () => {
  const valid = {
    sessionMs: 0,
    windowMs: 2.25,
    viewMs: 20.5,
    focusMs: 0.125,
    backendToReadyMs: 42.875,
  }
  expect(nativeStartupStages(valid)).toEqual(valid)
  for (const input of [
    null,
    [],
    {},
    { ...valid, extra: 1 },
    { ...valid, sessionMs: undefined },
    ...[-1, Infinity, NaN, 15000.001, '1'].map((value) => ({ ...valid, backendToReadyMs: value })),
  ])
    expect(() => nativeStartupStages(input)).toThrow()
  const missing: Partial<typeof valid> = { ...valid }
  delete missing.focusMs
  expect(() => nativeStartupStages(missing)).toThrow()
})

test('native startup summaries retain one observation per stage per completed launch', () => {
  const first = nativeStartupStages({
    sessionMs: 1,
    windowMs: 2,
    viewMs: 3,
    focusMs: 4,
    backendToReadyMs: 10,
  })
  const second = nativeStartupStages({
    sessionMs: 2,
    windowMs: 4,
    viewMs: 6,
    focusMs: 8,
    backendToReadyMs: 20,
  })
  const summary = nativeStartupSummary([first, second])
  for (const name of nativeStartupStageNames) {
    expect(summary[name].count).toBe(2)
    expect(summary[name].samples).toEqual([first[name], second[name]])
    expect(summary[name].mean).toBe((first[name] + second[name]) / 2)
  }
})
