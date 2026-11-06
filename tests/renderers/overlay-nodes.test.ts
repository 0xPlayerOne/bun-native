import { expect, test } from 'bun:test'
import { createElement, insertNode, setProperty } from '@bun-native/renderer'
import { snapshot } from '../../packages/renderer/src/nodes.ts'

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

test('a split keeps its own style in the shared snapshot', () => {
  const root = createElement('box')
  const split = createElement('split')
  setProperty(split, 'ratio', 0.25)
  setProperty(split, 'style', { width: 'fill', height: 200, background: 0x123456 })
  insertNode(root, split)
  insertNode(split, createElement('box'))
  insertNode(split, createElement('box'))
  expect(snapshot(root).get(split)?.element).toEqual({
    kind: 'split',
    ratio: 0.25,
    style: { width: 'fill', height: 200, background: 0x123456 },
  })
})
