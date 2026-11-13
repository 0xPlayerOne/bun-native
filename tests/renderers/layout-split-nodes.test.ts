import { expect, test } from 'bun:test'
import { createElement, insertNode, setProperty } from '@bun-native/renderer'
import { snapshot } from '../../packages/renderer/src/nodes.ts'

test('split intrinsics carry ratio and min_size only when set', () => {
  const split = createElement('split')
  expect(snapshot(split).get(split)?.element).toEqual({ kind: 'split' })
  setProperty(split, 'ratio', 0.3)
  setProperty(split, 'min_size', 48)
  setProperty(split, 'style', { direction: 'column', overflow: 'hidden' })
  expect(snapshot(split).get(split)?.element).toEqual({
    kind: 'split',
    ratio: 0.3,
    min_size: 48,
    style: { direction: 'column', overflow: 'hidden' },
  })
  setProperty(split, 'ratio', undefined)
  setProperty(split, 'min_size', undefined)
  setProperty(split, 'style', undefined)
  expect(snapshot(split).get(split)?.element).toEqual({ kind: 'split' })
  for (const [node, name, value] of [
    [split, 'ratio', '0.5'],
    [split, 'min_size', null],
    [createElement('box'), 'ratio', 0.5],
    [createElement('overlay'), 'min_size', 0],
  ] as const)
    expect(() => setProperty(node, name, value)).toThrow(TypeError)
})

test('a split refuses scrolling styles when captured, unlike its pane boxes', () => {
  for (const style of [{ overflow: 'scroll_y' }, { scroll_anchor: 'end' }]) {
    const split = createElement('split')
    setProperty(split, 'style', style)
    expect(() => snapshot(split)).toThrow(TypeError)
  }
  const split = createElement('split')
  const pane = createElement('box')
  setProperty(pane, 'style', { overflow: 'scroll_y', scroll_anchor: 'end' })
  insertNode(split, pane)
  expect(snapshot(split).get(pane)?.element).toEqual({
    kind: 'box',
    style: { overflow: 'scroll_y', scroll_anchor: 'end' },
  })
})

test('overlay surface properties validate and reach the popup element', () => {
  const overlay = createElement('overlay')
  setProperty(overlay, 'anchor', 'parent')
  setProperty(overlay, 'surface', 'window')
  setProperty(overlay, 'style', { width: 120, height: 80 })
  expect(snapshot(overlay).get(overlay)?.element).toEqual({
    kind: 'overlay',
    anchor: 'parent',
    surface: 'window',
    style: { width: 120, height: 80 },
  })
  setProperty(overlay, 'surface', undefined)
  expect(snapshot(overlay).get(overlay)?.element).not.toHaveProperty('surface')
  for (const [node, name, value] of [
    [overlay, 'surface', 'popup'],
    [createElement('box'), 'surface', 'window'],
  ] as const)
    expect(() => setProperty(node, name, value)).toThrow(TypeError)
})

test('captures share the stored style copy; only scrolling members force a leaf rebuild', () => {
  const box = createElement('box')
  const label = createElement('text')
  const scroll = createElement('text')
  insertNode(box, label)
  insertNode(box, scroll)
  const style = { padding: 4, background: 0x102030 }
  setProperty(box, 'style', style)
  setProperty(label, 'style', style)
  // An explicit undefined member is omitted, as it is from the wire.
  setProperty(scroll, 'style', { color: 0x202020, overflow: undefined })
  const first = snapshot(box)
  // The caller's object was copied when set, so a later mutation reaches no capture.
  style.padding = 99
  expect(first.get(box)?.element).toEqual({
    kind: 'box',
    style: { padding: 4, background: 0x102030 },
  })
  expect(first.get(label)?.element).toEqual({
    kind: 'text',
    text: '',
    style: { padding: 4, background: 0x102030 },
  })
  expect(first.get(scroll)?.element.style).toStrictEqual({ color: 0x202020 })
  // A leaf without scrolling members and a box share the one stored copy across captures.
  const labelStyle = first.get(label)!.element.style
  expect(labelStyle).toBe(label.properties.style)
  setProperty(label, 'text', 'Changed')
  expect(snapshot(box).get(label)?.element.style).toBe(labelStyle)
})
