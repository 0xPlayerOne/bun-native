import { createRenderer } from 'solid-js/universal'
import {
  asNode,
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
  type RendererNode,
} from '@bun-native/renderer'

export const renderer = createRenderer<RendererNode>({
  createElement,
  createTextNode,
  isTextNode: (node) => asNode(node).kind === 'text-node',
  replaceText: (node, value) => replaceText(asNode(node), value),
  setProperty: (node, name, value) => setProperty(asNode(node), name, value),
  // The official universal JSX compiler uses null to delimit a trailing
  // dynamic region. Both absent forms append; every real anchor stays owned.
  insertNode: (parent, node, anchor) =>
    insertNode(asNode(parent), asNode(node), anchor == null ? undefined : asNode(anchor)),
  removeNode: (parent, node) => removeNode(asNode(parent), asNode(node)),
  getParentNode: (node) => asNode(node).parent,
  getFirstChild: (node) => asNode(node).children[0],
  getNextSibling: (value) => {
    const node = asNode(value)
    return node.parent?.children[node.parent.children.indexOf(node) + 1]
  },
})
