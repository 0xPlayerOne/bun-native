import { expect, test } from 'bun:test'
import {
  asNode,
  createElement,
  createTextNode,
  firstChild,
  insertNode,
  nextSibling,
  removeNode,
  replaceText,
  setProperty,
  type ElementTag,
  type PropertyName,
} from '@bun-native/renderer'

test('staged child operations reject invalid ownership and cycles without changing the tree', () => {
  const root = createElement('box')
  const parent = createElement('box')
  const child = createElement('text')
  const other = createElement('box')
  const anchor = createElement('text')
  insertNode(root, parent)
  insertNode(parent, child)
  insertNode(other, anchor)
  expect(() => insertNode(parent, root)).toThrow('Native tree cycle')
  expect(() => insertNode(parent, child, anchor)).toThrow('another parent')
  expect(() => removeNode(other, child)).toThrow('another parent')
  expect(() => insertNode(createElement('input'), child)).toThrow('cannot have children')
  expect(() => insertNode(createTextNode('literal'), child)).toThrow('cannot have children')
  expect(() => insertNode(createElement('text'), child)).toThrow('children must be text')
  expect(() => insertNode(createElement('button'), parent)).toThrow('children must be text')
  insertNode(parent, child, child)
  expect(root.children).toEqual([parent])
  expect(parent.children).toEqual([child])
  expect(child.parent).toBe(parent)
  expect(other.children).toEqual([anchor])
  expect(() => asNode({} as never)).toThrow('owned staged native node')
  expect(() => asNode(null as never)).toThrow('owned staged native node')
  expect(asNode(child)).toBe(child)
  expect(() => createElement('div' as ElementTag)).toThrow('native-element:div')
})

test('native properties validate JavaScript values and element kind before replacing staged state', () => {
  const button = createElement('button')
  const input = createElement('input')
  const text = createElement('text')
  const invalid = [
    [button, 'style', null],
    [button, 'style', []],
    [button, 'style', 'color: red'],
    [button, 'text', 4],
    [button, 'disabled', 'false'],
    [button, 'onClick', true],
    [input, 'onInput', {}],
    [input, 'placeholder', 2],
    [input, 'text', 'invalid'],
    [text, 'value', 'invalid'],
    [text, 'placeholder', 'invalid'],
    [text, 'disabled', false],
    [createTextNode('literal'), 'onClick', () => {}],
    [createTextNode('literal'), 'onInput', () => {}],
    [text, 'className', undefined],
  ] as const
  for (const [node, name, value] of invalid)
    expect(() => setProperty(node, name as PropertyName, value)).toThrow()
  expect(button.properties).toEqual({})
  expect(input.properties).toEqual({})
  expect(text.properties).toEqual({})
  const style = { padding: 4 }
  setProperty(button, 'style', style)
  style.padding = 20
  expect(button.properties.style).toEqual({ padding: 4 })
  setProperty(button, 'text', 'Accept')
  setProperty(button, 'disabled', true)
  setProperty(button, 'onClick', () => {})
  setProperty(input, 'placeholder', 'Type')
  setProperty(input, 'onInput', () => {})
  for (const name of ['style', 'text', 'disabled', 'onClick'] as const)
    setProperty(button, name, undefined)
  for (const name of ['placeholder', 'onInput'] as const) setProperty(input, name, undefined)
  expect(button.properties).toEqual({})
  expect(input.properties).toEqual({})
  expect(() => replaceText(button, 'invalid')).toThrow('requires a text node')
  const literal = createTextNode('before')
  replaceText(literal, 'after')
  replaceText(literal, 'after')
  expect(literal.data).toBe('after')
})

test('sibling positions stay exact across removals, moves and direct truncation', () => {
  const parent = asNode(createElement('box'))
  const children = Array.from({ length: 200 }, () => asNode(createElement('box')))
  for (const child of children) insertNode(parent, child)
  const expected = [...children]
  const check = () => {
    expect(parent.children).toEqual(expected)
    expected.forEach((child, index) => expect(nextSibling(child)).toBe(expected[index + 1]))
  }
  // Front, alternating, middle and tail removals leave stale position hints.
  for (const position of [0, 0, 1, 3, 5, 90, 90, 90, -1]) {
    const index = position < 0 ? expected.length + position : position
    removeNode(parent, expected[index]!)
    expected.splice(index, 1)
    check()
  }
  // Anchored insertions and moves within the same parent shift later siblings.
  for (const [from, to] of [
    [150, 2],
    [3, 120],
    [0, 60],
    [100, 99],
  ] as const) {
    const node = expected[from]!
    const anchor = expected[to]!
    insertNode(parent, node, anchor)
    expected.splice(from, 1)
    expected.splice(expected.indexOf(anchor), 0, node)
    check()
  }
  // Adapters may clear a detached list directly, then reuse its children.
  const other = asNode(createElement('box'))
  const moved = expected.splice(0, 50)
  for (const node of moved) insertNode(other, node)
  other.children.length = 0
  for (const node of moved.toReversed()) {
    node.parent = undefined
    insertNode(parent, node, expected[0])
    expected.unshift(node)
    check()
  }
})

test('random sibling edits between reads match a reference list', () => {
  for (const seed of [5, 31, 2024]) {
    let state = seed
    const next = (limit: number) => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % limit
    }
    const parents = [asNode(createElement('box')), asNode(createElement('box'))]
    const expected: ReturnType<typeof asNode>[][] = [[], []]
    const pool = Array.from({ length: 400 }, () => asNode(createElement('box')))
    const detached = [...pool]
    // Reads go through the adapter helpers only until a checkpoint, so
    // removals accumulate as deferred holes between them.
    for (let step = 0; step < 3000; step += 1) {
      const side = next(2)
      const parent = parents[side]!
      const list = expected[side]!
      const choice = next(10)
      if (choice < 4 && detached.length) {
        const node = detached.splice(next(detached.length), 1)[0]!
        const at = next(list.length + 1)
        insertNode(parent, node, list[at])
        list.splice(at, 0, node)
      } else if (choice < 7 && list.length) {
        const at = next(4) ? next(list.length) : next(2) ? 0 : list.length - 1
        removeNode(parent, list[at]!)
        detached.push(...list.splice(at, 1))
      } else if (choice < 9 && list.length) {
        // Move within or across parents before an anchor in the target.
        const node = list.splice(next(list.length), 1)[0]!
        const target = next(2)
        const into = expected[target]!
        const at = next(into.length + 1)
        insertNode(parents[target]!, node, into[at])
        into.splice(at, 0, node)
      } else if (list.length) {
        const at = next(list.length)
        expect(nextSibling(list[at]!)).toBe(list[at + 1])
        expect(firstChild(parent)).toBe(list[0])
      }
      if (step % 250 === 249)
        parents.forEach((node, index) => expect(node.children).toEqual(expected[index]!))
    }
  }
})
