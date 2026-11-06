import { expect, test } from 'bun:test'
import {
  parseElement,
  parseEvent,
  ProtocolError,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import fixtures from '../fixtures/popup-windows.json'

test('popup window cases target an optional capability', () => {
  expect(REQUIRED_CAPABILITIES.some((required) => required === fixtures.capability)).toBe(false)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test('shared popup window contract: ' + entry.name, () => {
    if (!entry.valid) {
      expect(() => parseElement(entry.element)).toThrow(ProtocolError)
      return
    }
    expect(parseElement(entry.element)).toEqual(entry.normalized as never)
  })
}

test('dismiss events carry a validated route and a closed reason set', () => {
  const event = {
    type: 'dismiss',
    sequence: 1,
    window_id: 1,
    node_id: 3,
    tree_revision: 2,
    path: [1, 2, 3],
    reason: 'window_blur',
  }
  expect(parseEvent(event)).toEqual(event as never)
  expect(() => parseEvent({ ...event, reason: 'pointer_outside' })).toThrow(ProtocolError)
  expect(() => parseEvent({ ...event, path: [1, 2] })).toThrow(ProtocolError)
  expect(() => parseEvent({ ...event, extra: true })).toThrow(ProtocolError)
})
