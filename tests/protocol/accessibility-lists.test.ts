import { expect, test } from 'bun:test'
import { parseElement, ProtocolError, REQUIRED_CAPABILITIES } from '@bun-native/protocol'
import fixtures from '../fixtures/accessibility-lists.json'
import { createElement, setProperty, snapshot } from '../../packages/renderer/src/nodes.ts'

test('accessibility_lists_v1 is an optional capability with unique shared cases', () => {
  expect(REQUIRED_CAPABILITIES.some((required) => required === fixtures.capability)).toBe(false)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test('shared list accessibility: ' + entry.name, () => {
    const element: unknown = entry.element
    if ('expected' in entry) {
      const expected: unknown = entry.expected
      const actual: unknown = parseElement(element)
      expect(actual).toEqual(expected)
      const again: unknown = parseElement(expected)
      expect(again).toEqual(expected)
    } else expect(() => parseElement(element)).toThrow(ProtocolError)
  })
}

test('list members reach boxes and live reaches text through the renderer', () => {
  const list = createElement('box')
  setProperty(list, 'accessibleRole', 'list')
  setProperty(list, 'accessibleLabel', 'Messages')
  setProperty(list, 'accessibleSetSize', 10_150)
  expect(snapshot(list).get(list)?.element).toEqual({
    kind: 'box',
    accessible_role: 'list',
    accessible_label: 'Messages',
    accessible_set_size: 10_150,
  })
  const item = createElement('box')
  setProperty(item, 'accessibleRole', 'list_item')
  setProperty(item, 'accessiblePosition', 3)
  setProperty(item, 'accessibleSelected', false)
  expect(snapshot(item).get(item)?.element).toEqual({
    kind: 'box',
    accessible_role: 'list_item',
    accessible_position: 3,
    accessible_selected: false,
  })
  setProperty(item, 'accessibleRole', undefined)
  setProperty(item, 'accessiblePosition', undefined)
  setProperty(item, 'accessibleSelected', undefined)
  expect(snapshot(item).get(item)?.element).toEqual({ kind: 'box' })
  const text = createElement('text')
  setProperty(text, 'text', 'Token')
  setProperty(text, 'accessibleLive', 'polite')
  expect(snapshot(text).get(text)?.element).toEqual({
    kind: 'text',
    text: 'Token',
    accessible_live: 'polite',
  })
  for (const [kind, name, value] of [
    ['text', 'accessibleRole', 'list'],
    ['box', 'accessibleRole', 'table'],
    ['button', 'accessibleSetSize', 1],
    ['box', 'accessibleSetSize', 1.5],
    ['box', 'accessiblePosition', '1'],
    ['box', 'accessibleSelected', 1],
    ['box', 'accessibleLive', 'polite'],
    ['text', 'accessibleLive', 'off'],
  ] as const)
    expect(() => setProperty(createElement(kind), name, value)).toThrow(TypeError)
})
