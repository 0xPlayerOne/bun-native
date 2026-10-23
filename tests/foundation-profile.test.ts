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

// Shutdown evidence remains independent of the command exit/descendant gate.
import {
  nativeShutdownPhaseNames,
  nativeShutdownSummary,
  observeNativeShutdown,
  requireNativeShutdown,
} from '../benchmarks/foundation/native-shutdown.ts'

function shutdownFixture(): Record<string, unknown>[] {
  return nativeShutdownPhaseNames.flatMap((phase, index) => [
    { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
    ...(index === 0 ? [{ event: 'bunly.backend.exit', code: 0, forced: false }] : []),
    { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: index * 10 },
    ...(index === nativeShutdownPhaseNames.length - 1
      ? [{ event: 'bunly.host.shutdown', clean: true }]
      : []),
  ])
}
const shutdownObservation = (events: readonly unknown[]) =>
  observeNativeShutdown({
    stderr: events.map((event) => JSON.stringify(event)),
  })

test('native shutdown requires one ordered sequence and retains zero-duration completed stages', () => {
  const events = shutdownFixture()
  const observed = shutdownObservation(events)
  expect(observed.complete).toBe(true)
  expect(observed.malformed).toBe(false)
  expect(observed.pendingPhase).toBeNull()
  expect(requireNativeShutdown(observed)).toEqual({
    'process-stop': 0,
    'host-release': 10,
    'asset-service-stop': 20,
    'cef-shutdown': 30,
  })
  expect(Object.isFrozen(observed)).toBe(true)
  expect(Object.isFrozen(observed.durationsMs)).toBe(true)
  expect(
    observeNativeShutdown({
      stderr: [
        'Chromium diagnostic',
        'null',
        '[1]',
        ...events.map((event) => JSON.stringify(event)),
      ],
    })
  ).toEqual(observed)
})

test('partial shutdown keeps unknown durations null and identifies the pending phase', () => {
  const events = shutdownFixture()
  for (let count = 0; count < events.length; count++) {
    const observed = shutdownObservation(events.slice(0, count))
    expect(observed.complete).toBe(false)
    expect(() => requireNativeShutdown(observed)).toThrow()
  }
  const stopped = shutdownObservation(events.slice(0, -2))
  expect(stopped.malformed).toBe(false)
  expect(stopped.pendingPhase).toBe('cef-shutdown')
  expect(stopped.durationsMs['cef-shutdown']).toBeNull()
  expect(stopped.durationsMs['asset-service-stop']).toBe(20)
  expect(stopped.backendExitedNormally).toBe(true)
  expect(stopped.hostReportedClean).toBe(false)
})

test('missing, duplicated, reordered or invented shutdown phases never qualify', () => {
  const events = shutdownFixture()
  for (let index = 0; index < events.length; index++) {
    const missing = events.filter((_, position) => index !== position)
    const duplicate = [...events.slice(0, index), events[index], ...events.slice(index)]
    for (const sequence of [missing, duplicate])
      expect(() => requireNativeShutdown(shutdownObservation(sequence))).toThrow()
  }
  for (const sequence of [
    [...events].reverse(),
    [...events, { event: 'bunly.host.shutdown-phase', phase: 'unknown', state: 'start' }],
    [{ event: 'bunly.host.shutdown', clean: true }, ...events.slice(0, -1)],
    [events[1], events[0], ...events.slice(2)],
    [...events, { event: 'bunly.host.failure', error: 'private detail' }],
    [...events, { event: 'bunly.host.error', error: 'private detail' }],
  ])
    expect(() => requireNativeShutdown(shutdownObservation(sequence))).toThrow()
})

test('malformed shutdown durations and false success declarations fail closed', () => {
  const events = shutdownFixture()
  for (const durationMs of [-1, 1.5, 600001, NaN, Infinity, '10', null, undefined]) {
    const altered = events.map((event) =>
      event['state'] === 'complete' ? { ...event, durationMs } : event
    )
    expect(() => requireNativeShutdown(shutdownObservation(altered))).toThrow()
  }
  for (const change of [
    { code: 2 },
    { code: null },
    { code: '0' },
    { forced: true },
    { forced: 'false' },
  ]) {
    const altered = events.map((event) =>
      event['event'] === 'bunly.backend.exit' ? { ...event, ...change } : event
    )
    const observed = shutdownObservation(altered)
    expect(observed.backendExitedNormally).toBe(false)
    expect(() => requireNativeShutdown(observed)).toThrow()
  }
  for (const clean of [false, 'true', undefined]) {
    const altered = events.map((event) =>
      event['event'] === 'bunly.host.shutdown' ? { ...event, clean } : event
    )
    expect(() => requireNativeShutdown(shutdownObservation(altered))).toThrow()
  }
})

test('shutdown summaries retain one observation per completed launch without pooling phases', () => {
  const first = requireNativeShutdown(shutdownObservation(shutdownFixture()))
  const second = requireNativeShutdown(
    shutdownObservation(
      shutdownFixture().map((event) =>
        event['state'] === 'complete'
          ? { ...event, durationMs: Number(event['durationMs']) + 5 }
          : event
      )
    )
  )
  const summary = nativeShutdownSummary([first, second])
  for (const phase of nativeShutdownPhaseNames) {
    expect(summary[phase].count).toBe(2)
    expect(summary[phase].samples).toEqual([first[phase], second[phase]])
  }
})

test('shutdown observations omit arbitrary payloads and reject fabricated completeness', () => {
  const secret = '/private/example/token-secret'
  const observed = shutdownObservation(
    shutdownFixture().map((event) => ({ ...event, error: secret, pid: 123 }))
  )
  expect(JSON.stringify(observed)).not.toContain(secret)
  expect(JSON.stringify(observed)).not.toContain('pid')
  expect(() =>
    requireNativeShutdown({
      ...observed,
      durationsMs: { ...observed.durationsMs, 'cef-shutdown': null },
    })
  ).toThrow()
  const signalled = shutdownObservation(
    shutdownFixture().map((event) =>
      event['event'] === 'bunly.backend.exit' ? { ...event, code: null, forced: true } : event
    )
  )
  expect(signalled.malformed).toBe(false)
  expect(signalled.complete).toBe(false)
})
