import { expect, test } from 'bun:test'
import { FrameDecoder, parseCommand, parseElement, PROTOCOL_VERSION } from '@bun-native/protocol'
import fixtures from '../fixtures/bridge-security.json'

test('security cases target the implemented protocol and have unique names', () => {
  expect(PROTOCOL_VERSION).toBe(fixtures.protocol)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test(`security boundary: ${entry.name}`, () => {
    const decode = () => {
      const values = new FrameDecoder().push(new TextEncoder().encode(`${entry.wire}\n`))
      expect(values).toHaveLength(1)
      return parseCommand(values[0])
    }
    if (entry.outcome === 'accept') expect(decode()).toBeDefined()
    else if (entry.outcome === 'reject') expect(decode).toThrow()
    else throw new Error(`Unknown security fixture outcome: ${entry.outcome}`)
  })
}

test('a parsed element is frozen and revalidates by identity; copies are validated in full', () => {
  const element = parseElement({ kind: 'text', text: 'ok', style: { font_size: 12 } })
  expect(Object.isFrozen(element)).toBe(true)
  expect(Object.isFrozen(element.style)).toBe(true)
  expect(parseElement(element)).toBe(element)
  // A trusted element cannot be changed after validation.
  expect(() => {
    ;(element as { text: string }).text = 'a\0b'
  }).toThrow(TypeError)
  expect(() => {
    ;(element.style as { font_size: number }).font_size = 0
  }).toThrow(TypeError)
  const command = parseCommand({
    id: 1,
    type: 'batch',
    window_id: 1,
    base_revision: 0,
    operations: [{ type: 'create', node_id: 2, element }],
  })
  if (command.type !== 'batch') throw new Error('Expected a batch')
  expect(command.operations[0]).toEqual({ type: 'create', node_id: 2, element })
  expect((command.operations[0] as { element: unknown }).element).toBe(element)
  // An unfrozen copy carries no trust and is checked again.
  expect(() => parseElement({ ...element, text: 'a\0b' })).toThrow()
  expect(() => parseElement({ ...element, style: { font_size: 0 } })).toThrow()
  const copy = parseElement({ ...element })
  expect(copy).not.toBe(element)
  expect(copy).toEqual(element)
})
