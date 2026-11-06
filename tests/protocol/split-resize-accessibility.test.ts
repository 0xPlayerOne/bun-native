import { expect, test } from 'bun:test'
import {
  parseElement,
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import events from '../fixtures/split-resize.json'
import elements from '../fixtures/accessibility.json'

test('split resize and accessibility are optional capabilities, not protocol requirements', () => {
  expect(events.protocol).toBe(PROTOCOL_VERSION)
  for (const capability of [events.capability, ...elements.capabilities])
    expect(REQUIRED_CAPABILITIES.some((required) => required === capability)).toBe(false)
  expect(new Set(events.cases.map((entry) => entry.name)).size).toBe(events.cases.length)
  expect(new Set(elements.cases.map((entry) => entry.name)).size).toBe(elements.cases.length)
})

for (const entry of events.cases) {
  test('shared split resize event: ' + entry.name, () => {
    const parse = () => parseEvent(JSON.parse(entry.wire))
    if (entry.valid) expect(parse()).toEqual(JSON.parse(entry.wire))
    else expect(parse).toThrow(ProtocolError)
  })
}

for (const entry of elements.cases) {
  test('shared accessible label: ' + entry.name, () => {
    const element: unknown = entry.element
    if ('expected' in entry) {
      const expected: unknown = entry.expected
      const actual: unknown = parseElement(element)
      expect(actual).toEqual(expected)
    } else expect(() => parseElement(element)).toThrow(ProtocolError)
  })
}

test('nonfinite split resize ratios cannot be supplied as JavaScript values', () => {
  const value = JSON.parse(events.cases[0]!.wire)
  for (const ratio of [NaN, Infinity, -Infinity])
    expect(() => parseEvent({ ...value, ratio })).toThrow(ProtocolError)
})
