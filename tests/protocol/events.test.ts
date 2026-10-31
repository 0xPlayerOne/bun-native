import { expect, test } from 'bun:test'
import {
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import fixtures from '../fixtures/native-events.json'

test('shared native events require the current interaction capability', () => {
  expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
  expect(REQUIRED_CAPABILITIES.some((capability) => capability === fixtures.capability)).toBe(true)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test('shared native event: ' + entry.name, () => {
    const parse = () => parseEvent(JSON.parse(entry.wire))
    if (entry.valid) expect(parse()).toEqual(JSON.parse(entry.wire))
    else expect(parse).toThrow()
  })
}

test('event paths and modifier records are copied at the process boundary', () => {
  const value = JSON.parse(fixtures.cases.find((entry) => entry.name === 'key-down')!.wire)
  const parsed = parseEvent(value)
  value.path.reverse()
  value.modifiers.shift = true
  expect(parsed).toMatchObject({ path: [1, 2, 3], modifiers: { shift: false } })
})

test('nonfinite pointer coordinates cannot be supplied as JavaScript values', () => {
  const value = JSON.parse(fixtures.cases.find((entry) => entry.name === 'pointer-left')!.wire)
  for (const coordinate of [NaN, Infinity, -Infinity])
    expect(() => parseEvent({ ...value, x: coordinate })).toThrow(ProtocolError)
})
