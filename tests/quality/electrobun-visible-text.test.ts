import { expect, test } from 'bun:test'
import { verifyVisibleText } from '../../benchmarks/electrobun/visible-text.ts'

const item = (text: string, confidence = 0.9, bounds = [0.1, 0.8, 0.2, 0.1]) => ({
  text,
  confidence,
  bounds,
})
const result = (observations: unknown[]) => ({
  status: 'passed',
  size: [640, 720],
  recognitionMs: 50,
  boundsOrigin: 'normalized bottom-left',
  observations,
})
const region = [0, 0.7, 1, 0.3] as const

test('accepts exactly one confident expected label within the calibrated region', () => {
  expect(verifyVisibleText(result([item('Clicked')]), 'Clicked', 'Initial', region).size).toEqual([
    640, 720,
  ])
  expect(() => verifyVisibleText(result([item('Initial')]), 'Clicked', 'Initial', region)).toThrow()
  expect(() =>
    verifyVisibleText(result([item('Clicked'), item('Initial')]), 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(result([item('Clicked'), item('Clicked')]), 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(result([item('Clicked'), item('Clicked', 0.1)]), 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(result([item('Clicked', 0.1)]), 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(
      result([item('Clicked', 0.9, [0.1, 0.1, 0.2, 0.1])]),
      'Clicked',
      'Initial',
      region
    )
  ).toThrow()
})

test('rejects malformed metadata, boxes, confidence and excessive observations', () => {
  expect(() =>
    verifyVisibleText({ ...result([]), size: [0, 720] }, 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(result([item('Clicked', 1.1)]), 'Clicked', 'Initial', region)
  ).toThrow()
  expect(() =>
    verifyVisibleText(
      result([item('Clicked', 0.9, [0.9, 0.8, 0.2, 0.1])]),
      'Clicked',
      'Initial',
      region
    )
  ).toThrow()
  expect(() =>
    verifyVisibleText(
      result(Array.from({ length: 257 }, () => item('x'))),
      'Clicked',
      'Initial',
      region
    )
  ).toThrow()
})
