import { expect, test } from 'bun:test'
import {
  awaitUnobstructedStream,
  awaitVisibleReadiness,
} from '../../benchmarks/electrobun/visible-readiness.ts'

test('readiness retains mismatches, accepts a later exact capture and rejects other failures', async () => {
  const mismatches: string[] = []
  const calls: string[] = []
  const value = await awaitVisibleReadiness(
    'initial',
    10,
    async (name) => {
      calls.push(name)
      if (calls.length === 1)
        throw new Error('Display and owned surface differ in the label region')
      return 'matched'
    },
    mismatches,
    () => 0,
    async () => {}
  )
  expect(value).toBe('matched')
  expect(calls).toEqual(['initial', 'initial-correspondence-02'])
  expect(mismatches).toEqual(['initial'])
  await expect(
    awaitVisibleReadiness(
      'initial',
      10,
      async () => {
        throw new Error('guard failed')
      },
      [],
      () => 0,
      async () => {}
    )
  ).rejects.toThrow('guard failed')
  const expired: string[] = []
  await expect(
    awaitVisibleReadiness(
      'initial',
      0,
      async () => {
        throw new Error('Display and owned surface differ in the label region')
      },
      expired,
      () => 1,
      async () => {}
    )
  ).rejects.toThrow()
  expect(expired).toEqual(['initial'])
  const exhausted: string[] = []
  await expect(
    awaitVisibleReadiness(
      'initial',
      10,
      async () => {
        throw new Error('Display and owned surface differ in the label region')
      },
      exhausted,
      () => 0,
      async () => {}
    )
  ).rejects.toThrow()
  expect(exhausted).toHaveLength(20)
})

test('readiness defaults wait before retrying a transient mismatch', async () => {
  let attempts = 0
  const mismatches: string[] = []
  const value = await awaitVisibleReadiness(
    'initial',
    performance.now() + 5000,
    async () => {
      if (++attempts === 1) throw new Error('Display and owned surface differ in the label region')
      return 'matched'
    },
    mismatches
  )
  expect(value).toBe('matched')
  expect(attempts).toBe(2)
  expect(mismatches).toEqual(['initial'])
})

test('stream readiness retains pre-input obstructions and never accepts malformed guards', async () => {
  const obstruction = {
    status: 'ready',
    visibleRegionVerified: false,
    visibleRegionObstruction: { id: 7 },
  }
  const clear = { status: 'ready', visibleRegionVerified: true }
  const attempts: (typeof obstruction | typeof clear)[] = []
  let calls = 0
  const actual = await awaitUnobstructedStream(
    10,
    async () => (++calls === 1 ? obstruction : clear),
    attempts,
    () => 0,
    async () => {}
  )
  expect(actual).toEqual(clear)
  expect(attempts).toEqual([obstruction, clear])

  const invalid: { status: string; visibleRegionVerified: boolean }[] = []
  await expect(
    awaitUnobstructedStream(
      10,
      async () => ({ status: 'ready', visibleRegionVerified: false }),
      invalid
    )
  ).rejects.toThrow('invalid obstruction evidence')
  expect(invalid).toHaveLength(1)

  const exhausted: (typeof obstruction)[] = []
  await expect(
    awaitUnobstructedStream(
      10,
      async () => obstruction,
      exhausted,
      () => 0,
      async () => {}
    )
  ).rejects.toThrow('Stream label region is obstructed')
  expect(exhausted).toHaveLength(20)
  const expired: (typeof obstruction)[] = []
  await expect(
    awaitUnobstructedStream(
      0,
      async () => obstruction,
      expired,
      () => 1,
      async () => {}
    )
  ).rejects.toThrow('Stream label region is obstructed')
  expect(expired).toHaveLength(1)
  const failed: (typeof obstruction)[] = []
  await expect(
    awaitUnobstructedStream(
      10,
      async () => {
        throw new Error('identity changed')
      },
      failed
    )
  ).rejects.toThrow('identity changed')
  expect(failed).toHaveLength(0)
})
