import { afterEach, expect, test } from 'bun:test'
import {
  distribution,
  LatencyHistogram,
  psCpuSeconds,
  sessionConfig,
} from '../native/workspace-session.ts'

const names = [
  'BUN_NATIVE_SOAK_SECONDS',
  'BUN_NATIVE_SOAK_SAMPLE_SECONDS',
  'BUN_NATIVE_SOAK_PACE_MS',
  'BUN_NATIVE_SOAK_OS_INPUT',
] as const
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

test('the soaks keep their fixed plan unless a session budget is set', () => {
  for (const name of names) delete process.env[name]
  expect(sessionConfig(true)).toBeUndefined()
  expect(sessionConfig(false)).toBeUndefined()
  process.env['BUN_NATIVE_SOAK_SECONDS'] = '1800'
  expect(sessionConfig(true)).toEqual({
    seconds: 1800,
    sampleSeconds: 30,
    paceMs: 0,
    osInput: false,
  })
  // The headless peer has no native host to observe for a session.
  expect(() => sessionConfig(false)).toThrow('real native host')
  process.env['BUN_NATIVE_SOAK_PACE_MS'] = '250'
  process.env['BUN_NATIVE_SOAK_SAMPLE_SECONDS'] = '10'
  expect(sessionConfig(true)).toMatchObject({ sampleSeconds: 10, paceMs: 250 })
})

test('session settings outside their bounds are rejected', () => {
  for (const [name, value] of [
    ['BUN_NATIVE_SOAK_SECONDS', '5'],
    ['BUN_NATIVE_SOAK_SECONDS', '1.5'],
    ['BUN_NATIVE_SOAK_SECONDS', 'long'],
    ['BUN_NATIVE_SOAK_SAMPLE_SECONDS', '0'],
    ['BUN_NATIVE_SOAK_PACE_MS', '-1'],
  ] as const) {
    for (const other of names) delete process.env[other]
    process.env['BUN_NATIVE_SOAK_SECONDS'] = '60'
    process.env[name] = value
    expect(() => sessionConfig(true)).toThrow(name)
  }
})

test('interval distributions use nearest-rank tails', () => {
  expect(distribution([])).toEqual({ count: 0 })
  const values = Array.from({ length: 100 }, (_, index) => 100 - index)
  expect(distribution(values)).toEqual({ count: 100, p50: 51, p95: 96, p99: 100, max: 100 })
})

test('macOS ps CPU time is read in every printed form', () => {
  expect(psCpuSeconds('0:01.23')).toBeCloseTo(1.23)
  expect(psCpuSeconds('12:34.50')).toBeCloseTo(754.5)
  expect(psCpuSeconds('1:02:03.00')).toBe(3723)
  expect(psCpuSeconds('2-01:00:00.00')).toBe(176_400)
  for (const invalid of ['', '12', '1:x', '1:2:3:4:5'])
    expect(() => psCpuSeconds(invalid)).toThrow('Unexpected ps CPU time')
})

test('the whole-session latency histogram keeps fixed memory and bucket-edge tails', () => {
  const histogram = new LatencyHistogram()
  expect(histogram.summary()).toEqual({ count: 0 })
  for (let index = 1; index <= 100; index++) histogram.add(index / 10)
  histogram.add(2500)
  expect(histogram.summary()).toEqual({
    count: 101,
    p50: 5.1,
    p95: 9.61,
    p99: 10.01,
    max: 2500,
    slowerThan1sCount: 1,
  })
})
