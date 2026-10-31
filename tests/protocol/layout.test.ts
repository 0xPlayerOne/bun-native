import { expect, test } from 'bun:test'
import { parseElement, ProtocolError, REQUIRED_CAPABILITIES } from '@bun-native/protocol'
import fixtures from '../fixtures/layout-style.json'

test('shared native layout cases target a mandatory implemented capability', () => {
  expect(REQUIRED_CAPABILITIES.some((capability) => capability === fixtures.capability)).toBe(true)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test('shared layout contract: ' + entry.name, () => {
    if (entry.valid) {
      const actual: unknown = parseElement(entry.element).style
      expect(actual).toEqual(entry.element.style)
    } else expect(() => parseElement(entry.element)).toThrow(ProtocolError)
  })
}

test('nonfinite layout values cannot cross the boundary from JavaScript', () => {
  for (const field of ['min_width', 'max_width', 'min_height', 'max_height', 'flex_shrink'])
    for (const value of [NaN, Infinity, -Infinity])
      expect(() => parseElement({ kind: 'box', style: { [field]: value } })).toThrow(ProtocolError)
})
