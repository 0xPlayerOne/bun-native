import { expect, test } from 'bun:test'
import {
  DECORATION_FIELDS,
  parseElement,
  ProtocolError,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import fixtures from '../fixtures/layout-style-v2.json'

test('split and decoration cases are optional capabilities, not protocol requirements', () => {
  for (const capability of fixtures.capabilities)
    expect(REQUIRED_CAPABILITIES.some((required) => required === capability)).toBe(false)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
  expect(fixtures.cases.some((entry) => 'expected' in entry)).toBe(true)
})

for (const entry of fixtures.cases) {
  test('shared split/decoration contract: ' + entry.name, () => {
    const element: unknown = entry.element
    if ('expected' in entry) {
      const expected: unknown = entry.expected
      const actual: unknown = parseElement(element)
      expect(actual).toEqual(expected)
    } else expect(() => parseElement(element)).toThrow(ProtocolError)
  })
}

test('nonfinite decoration and split values cannot cross the boundary from JavaScript', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const field of DECORATION_FIELDS)
      expect(() => parseElement({ kind: 'box', style: { [field]: value } })).toThrow(ProtocolError)
    for (const field of ['ratio', 'min_size'])
      expect(() => parseElement({ kind: 'split', [field]: value })).toThrow(ProtocolError)
  }
})
