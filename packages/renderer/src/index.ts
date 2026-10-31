import { NativeStateError, type InputState } from '@bun-native/core'
import { asNode, type RendererNode } from './nodes.ts'

export { createRenderRoot } from './root.ts'
export type { RenderContext, RenderRoot } from './root.ts'
export {
  asNode,
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
} from './nodes.ts'
export type { Node, RendererNode } from './nodes.ts'

/** Observe current editing state without upgrading a submitted replacement intent. */
export function inputState(reference: RendererNode): InputState {
  const node = asNode(reference)
  if (node.kind !== 'input' || !node.owner)
    throw new NativeStateError('invalid_handle', 'Expected a mounted native input')
  return node.owner.input(node)
}
