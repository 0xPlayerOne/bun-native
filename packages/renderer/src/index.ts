import {
  NativeStateError,
  type DropTargetEvent,
  type InputState,
  type NativeDropTarget,
} from '@bun-native/core'
import { asNode, type RendererNode } from './nodes.ts'

export { createRenderRoot } from './root.ts'
export type { RenderContext, RenderOptions, RenderRoot } from './root.ts'
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
export { eventProperties, isEventProperty } from './event-properties.ts'
export type { EventHandlers, EventProperty } from './event-properties.ts'

/**
 * Make a mounted, committed element an owned native drop target. The same
 * core window method serves every adapter; removing the element revokes it.
 */
export function registerDropTarget(
  reference: RendererNode,
  listener: (event: DropTargetEvent) => void | Promise<void>
): Promise<NativeDropTarget> {
  const node = asNode(reference)
  if (node.kind === 'text-node' || !node.owner)
    return Promise.reject(new NativeStateError('invalid_handle', 'Expected a mounted element'))
  return node.owner.registerDropTarget(node, listener)
}

/** Observe current editing state without upgrading a submitted replacement intent. */
export function inputState(reference: RendererNode): InputState {
  const node = asNode(reference)
  if (node.kind !== 'input' || !node.owner)
    throw new NativeStateError('invalid_handle', 'Expected a mounted native input')
  return node.owner.input(node)
}
