import { expect, test } from 'bun:test'
import { awaitVisibleReadiness } from '../../benchmarks/electrobun/visible-readiness.ts'

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
