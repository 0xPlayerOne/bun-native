import { expect, test } from 'bun:test'
import { createElement, insertNode, setProperty } from '@bun-native/renderer'

test('overlay intrinsics own element children and validate their own properties', () => {
  const overlay = createElement('overlay')
  const panel = createElement('box')
  const nested = createElement('overlay')
  insertNode(overlay, panel)
  insertNode(panel, nested)
  expect(overlay.children).toEqual([panel])
  setProperty(overlay, 'modal', true)
  setProperty(overlay, 'anchor', 'window')
  setProperty(nested, 'anchor', 'parent')
  setProperty(overlay, 'style', { overflow: 'scroll_y', scroll_anchor: 'end' })
  expect(overlay.properties).toMatchObject({ modal: true, anchor: 'window' })
  setProperty(overlay, 'modal', undefined)
  expect(overlay.properties.modal).toBeUndefined()
  for (const [node, name, value] of [
    [overlay, 'modal', 'true'],
    [overlay, 'anchor', 'cursor'],
    [panel, 'modal', true],
    [createElement('button'), 'anchor', 'parent'],
  ] as const)
    expect(() => setProperty(node, name, value)).toThrow()
})
