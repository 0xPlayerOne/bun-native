import { createRenderer } from 'solid-js/universal'
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
  type RendererNode,
} from '@bun-native/renderer'

export const renderer = createRenderer<RendererNode>({
  // The compiler hands over JSX tags and names as strings; the renderer rejects
  // any it does not know with an UnsupportedFeatureError.
  createElement: (tag) => createElement(tag as ElementTag),
  createTextNode,
  isTextNode: (node) => asNode(node).kind === 'text-node',
  replaceText: (node, value) => replaceText(asNode(node), value),
  setProperty: (node, name, value) => setProperty(asNode(node), name as PropertyName, value),
  // The official universal JSX compiler uses null to delimit a trailing
  // dynamic region. Both absent forms append; every real anchor stays owned.
  insertNode: (parent, node, anchor) =>
    insertNode(asNode(parent), asNode(node), anchor == null ? undefined : asNode(anchor)),
  removeNode: (parent, node) => removeNode(asNode(parent), asNode(node)),
  getParentNode: (node) => asNode(node).parent,
  getFirstChild: (node) => firstChild(asNode(node)),
  getNextSibling: (node) => nextSibling(asNode(node)),
})
