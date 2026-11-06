import { expect, test } from 'bun:test'
import {
  MAX_OVERLAY_DEPTH,
  parseElement,
  ProtocolError,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import fixtures from '../fixtures/overlays.json'

test('overlay cases target optional capabilities and share the Rust nesting bound', () => {
  for (const capability of fixtures.capabilities)
    expect(REQUIRED_CAPABILITIES.some((required) => required === capability)).toBe(false)
  expect(fixtures.max_overlay_depth).toBe(MAX_OVERLAY_DEPTH)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test('shared overlay contract: ' + entry.name, () => {
    if (!entry.valid) {
      expect(() => parseElement(entry.element)).toThrow(ProtocolError)
      return
    }
    const parsed: unknown = parseElement(entry.element)
    if ('normalized' in entry) expect(parsed).toEqual(entry.normalized)
    else expect((parsed as { style: unknown }).style).toEqual(entry.element.style)
  })
}
