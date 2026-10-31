import { expect, test } from 'bun:test'
import {
  asNode,
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
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
  expect(() => createElement('div')).toThrow('native-element:div')
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
    [text, 'onClick', () => {}],
    [text, 'onInput', () => {}],
    [text, 'className', undefined],
  ] as const
  for (const [node, name, value] of invalid) expect(() => setProperty(node, name, value)).toThrow()
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
  for (const name of ['style', 'text', 'disabled', 'onClick']) setProperty(button, name, undefined)
  for (const name of ['placeholder', 'onInput']) setProperty(input, name, undefined)
  expect(button.properties).toEqual({})
  expect(input.properties).toEqual({})
  expect(() => replaceText(button, 'invalid')).toThrow('requires a text node')
  const literal = createTextNode('before')
  replaceText(literal, 'after')
  replaceText(literal, 'after')
  expect(literal.data).toBe('after')
})
