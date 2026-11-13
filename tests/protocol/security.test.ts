import { expect, test } from 'bun:test'
import {
  FrameDecoder,
  OperationList,
  parseCommand,
  parseElement,
  PROTOCOL_VERSION,
} from '@bun-native/protocol'
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

test('an operation list crosses parseCommand without a second parse; arrays are parsed', () => {
  const text = parseElement({ kind: 'text', text: 'ok' })
  const input = parseElement({ kind: 'input', value: 'v' })
  const list = new OperationList()
  list.create(2, text)
  list.set(2, text)
  list.set(3, input, 4)
  list.insert(1, 2, 0)
  list.delete(2)
  list.focus(3)
  list.scrollTo(1, { y: 10 })
  list.scrollIntoView(3)
  expect(list.length).toBe(8)
  const built = [...list]
  expect(built as unknown[]).toEqual([
    { type: 'create', node_id: 2, element: text },
    { type: 'set', node_id: 2, element: text },
    { type: 'set', node_id: 3, element: input, expected_input_revision: 4 },
    { type: 'insert', parent_id: 1, child_id: 2, index: 0 },
    { type: 'delete', node_id: 2 },
    { type: 'focus', node_id: 3 },
    { type: 'scroll_to', node_id: 1, y: 10 },
    { type: 'scroll_into_view', node_id: 3 },
  ])
  // A built operation cannot change after it was checked.
  for (const operation of list) expect(Object.isFrozen(operation)).toBe(true)
  expect(() => {
    ;(built[0] as { node_id: number }).node_id = 0
  }).toThrow(TypeError)
  const batch = (operations: unknown) => {
    const command = parseCommand({
      id: 1,
      type: 'batch',
      window_id: 1,
      base_revision: 0,
      operations,
    })
    if (command.type !== 'batch') throw new Error('Expected a batch')
    return command.operations
  }
  // The command carries a copy: changing it cannot reach the list.
  const parsed = batch(list) as unknown[]
  parsed.forEach((operation, index) => expect(operation).toBe(built[index]))
  parsed.length = 0
  expect(list.length).toBe(8)
  // Construction checks what parsing checks, and keeps nothing it rejects.
  const fresh = new OperationList()
  expect(() => fresh.create(0, text)).toThrow(/Identifier/)
  expect(() => fresh.create(2, { kind: 'text', text: 'a\0b' })).toThrow(/NUL/)
  expect(() => fresh.set(2, text, 1)).toThrow(/Only input/)
  expect(() => fresh.set(3, input)).toThrow(/input revision/)
  expect(() => fresh.insert(1, 2, -1)).toThrow(/index/)
  expect(() => fresh.scrollTo(1, {})).toThrow(/x or y/)
  expect(() => fresh.scrollTo(1, { x: -1 })).toThrow(/scroll x/)
  expect(fresh.length).toBe(0)
  expect(() => batch(fresh)).toThrow(/between 1 and/)
  // Joined lists keep their order.
  const other = new OperationList()
  other.delete(5)
  const joined = OperationList.join([list, other])
  expect([...joined]).toEqual([...built, { type: 'delete', node_id: 5 }])
  expect(batch(joined)).toHaveLength(9)
  // An array, even of built operations, is parsed in full.
  const copy = batch(built)
  expect(copy[0]).not.toBe(built[0])
  expect(copy).toEqual(built)
  expect(() => batch([{ ...built[0]!, node_id: 0 }])).toThrow(/Identifier/)
  expect(() =>
    batch([{ type: 'set', node_id: 2, element: text, expected_input_revision: undefined }])
  ).toThrow(/Only input/)
  expect(() => batch([{ type: 'scroll_to', node_id: 1, x: undefined }])).toThrow(/scroll x/)
})
