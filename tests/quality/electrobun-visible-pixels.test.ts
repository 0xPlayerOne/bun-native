import { expect, test } from 'bun:test'
import { compareVisiblePixels } from '../../benchmarks/electrobun/visible-pixels.ts'

const image = (values: number[]) => ({
  width: 3,
  height: 2,
  rgb: (x: number, y: number) => values[y * 3 + x]!,
})

test('counts meaningful changes only within the calibrated region', () => {
  const before = image([0, 0, 0, 0, 0, 0])
  const after = image([0xffffff, 0x110000, 0x100000, 0, 0, 0])
  expect(compareVisiblePixels(before, after, [1, 0, 2, 2])).toEqual({
    changedPixels: 1,
    totalPixels: 4,
    maxChannelChange: 17,
  })
  expect(compareVisiblePixels(before, before, [0, 0, 3, 2]).changedPixels).toBe(0)
})

test('rejects mismatched captures, invalid rectangles and malformed pixels', () => {
  const before = image([0, 0, 0, 0, 0, 0])
  expect(() => compareVisiblePixels(before, { ...before, width: 4 }, [0, 0, 1, 1])).toThrow()
  expect(() => compareVisiblePixels(before, before, [2, 1, 2, 1])).toThrow()
  expect(() => compareVisiblePixels(before, before, [0, 0, 1, 1], -1)).toThrow()
  expect(() => compareVisiblePixels(before, image([NaN]), [0, 0, 1, 1])).toThrow()
})
