import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  distribution,
  LatencyHistogram,
  ownedHost,
  processSample,
  psCpuSeconds,
  sessionConfig,
  SessionRecorder,
  waitUntil,
  writeStringCensus,
} from '../native/workspace-session.ts'

const names = [
  'BUN_NATIVE_SOAK_SECONDS',
  'BUN_NATIVE_SOAK_SAMPLE_SECONDS',
  'BUN_NATIVE_SOAK_PACE_MS',
  'BUN_NATIVE_SOAK_OS_INPUT',
  'BUN_NATIVE_SOAK_HEAP_CENSUS',
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
    census: false,
  })
  // The headless peer has no native host to observe for a session.
  expect(() => sessionConfig(false)).toThrow('real native host')
  process.env['BUN_NATIVE_SOAK_PACE_MS'] = '250'
  process.env['BUN_NATIVE_SOAK_SAMPLE_SECONDS'] = '10'
  process.env['BUN_NATIVE_SOAK_HEAP_CENSUS'] = '1'
  expect(sessionConfig(true)).toMatchObject({ sampleSeconds: 10, paceMs: 250, census: true })
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

test('OS input needs a private Linux X11 display', () => {
  for (const name of names) delete process.env[name]
  const display = process.env['DISPLAY']
  try {
    process.env['BUN_NATIVE_SOAK_SECONDS'] = '60'
    process.env['BUN_NATIVE_SOAK_OS_INPUT'] = '1'
    delete process.env['DISPLAY']
    if (process.platform === 'linux')
      expect(() => sessionConfig(true)).toThrow('private Linux X11 display')
    process.env['DISPLAY'] = ':99'
    if (process.platform === 'linux') expect(sessionConfig(true)?.osInput).toBe(true)
  } finally {
    if (display === undefined) delete process.env['DISPLAY']
    else process.env['DISPLAY'] = display
  }
})

test.if(process.platform === 'linux')(
  "the owned host is found among this process's children",
  () => {
    const child = Bun.spawn(['sleep', '30'])
    try {
      const sleep = Bun.which('sleep')!
      const deadline = Date.now() + 5_000
      let found: number | undefined
      while (found === undefined && Date.now() < deadline) found = ownedHost(sleep)
      expect(found).toBe(child.pid)
      expect(ownedHost(process.execPath)).toBeUndefined()

      const sample = processSample(child.pid)!
      expect(sample.rssKiB).toBeGreaterThan(0)
      expect(sample.hwmKiB).toBeGreaterThanOrEqual(sample.rssKiB)
      expect(sample.threads).toBeGreaterThanOrEqual(1)
      expect(sample.fds).toBeGreaterThanOrEqual(1)
      expect(sample.cpuTicks).toBeGreaterThanOrEqual(0)
    } finally {
      child.kill()
    }
    expect(processSample(undefined)).toBeNull()
    expect(processSample(2 ** 30)).toBeNull()
  }
)

test('the recorder writes interval samples and rounds outside the heap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-session-'))
  try {
    const recorder = new SessionRecorder(directory)
    recorder.ack(1)
    recorder.ack(3)
    recorder.input(20)
    recorder.round(1500)
    const first = recorder.record({ round: 1 })
    expect(first).toMatchObject({
      round: 1,
      ackMs: { count: 2, p50: 3, max: 3 },
      inputToStateMs: { count: 1, p50: 20 },
    })
    expect(first['loadAverage']).toHaveLength(3)
    // Each interval starts empty; the whole-session histograms keep counting.
    expect(recorder.record({ round: 2 })).toMatchObject({ ackMs: { count: 0 } })
    recorder.round(1400)
    expect(recorder.readSamples().map((row) => row['round'])).toEqual([1, 2])
    expect(recorder.readRounds()).toEqual([1500, 1400])
    expect(recorder.ackTotal.summary()).toMatchObject({ count: 2 })
    expect(recorder.inputTotal.summary()).toMatchObject({ count: 1 })
    expect(new SessionRecorder(undefined).record({}).ackMs).toEqual({ count: 0 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('waitUntil polls until the predicate holds and names what timed out', async () => {
  let calls = 0
  await waitUntil(() => ++calls > 3, 'three polls')
  expect(calls).toBe(4)
  await expect(waitUntil(() => false, 'nothing', 10)).rejects.toThrow(
    'Timed out waiting for nothing'
  )
})

test('the string census counts live strings by their text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-census-'))
  // Number strings are flat (not ropes), the kind the census attributes;
  // held live across the snapshot so each must be counted.
  const held = Array.from({ length: 3 }, (_, index) => String(918_273_645_000 + index))
  try {
    writeStringCensus(directory, 7)
    const counts = JSON.parse(readFileSync(join(directory, 'strings-7.json'), 'utf8')) as Record<
      string,
      number
    >
    for (const text of held) expect(counts[text]).toBeGreaterThanOrEqual(1)
    expect(Object.values(counts).every((count) => Number.isInteger(count) && count > 0)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
