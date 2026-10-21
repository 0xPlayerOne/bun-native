import { expect, test } from 'bun:test'
import { separateBoundedVolume } from '../scripts/qualify-cef-storage.ts'
test('storage qualifier requires a distinct strictly bounded filesystem', () => {
  expect(() => separateBoundedVolume(1, 2, 64n * 1024n ** 2n)).not.toThrow()
  for (const [a, b, size] of [
    [1, 1, 64n * 1024n ** 2n],
    [1, 2, 1024n],
    [1, 2, 129n * 1024n ** 2n],
    [NaN, 2, 64n * 1024n ** 2n],
  ] as const)
    expect(() => separateBoundedVolume(a, b, size)).toThrow()
})
