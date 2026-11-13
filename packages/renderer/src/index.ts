import {
  NativeStateError,
  type ContainerKind,
  type DropTargetEvent,
  type InputState,
  type NativeDropTarget,
  type NativeNode,
  type ScrollOffset,
} from '@bun-native/core'
import { asNode, type RendererNode } from './nodes.ts'

export { createRenderRoot } from './root.ts'
export type { RenderAdapter, RenderContext, RenderOptions, RenderRoot } from './root.ts'
export {
  asNode,
  createElement,
  createTextNode,
  firstChild,
  insertNode,
  nextSibling,
  removeNode,
  replaceText,
  setProperty,
} from './nodes.ts'
export type { ElementTag, Node, PropertyName, RendererNode } from './nodes.ts'
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

function mounted(reference: RendererNode) {
  const node = asNode(reference)
  if (!node.owner || node.kind === 'text-node')
    throw new NativeStateError('invalid_handle', 'Expected a mounted native element')
  return { node, owner: node.owner }
}

/**
 * Focus a mounted button or input after staged changes commit, scrolling it
 * into view. Requires the host's `focus_v1` capability.
 */
export function focusNode(reference: RendererNode): Promise<void> {
  const { node, owner } = mounted(reference)
  if (node.kind !== 'button' && node.kind !== 'input')
    throw new NativeStateError('invalid_state', 'Only buttons and inputs can take focus')
  return owner.request(node, (batch, handle) =>
    batch.focus(handle as NativeNode<'button' | 'input'>)
  )
}

/** Set a mounted scrolling box or overlay's offset. Requires `scroll_control_v1`. */
export function scrollNodeTo(reference: RendererNode, offset: ScrollOffset): Promise<void> {
  const { node, owner } = mounted(reference)
  if (node.kind !== 'box' && node.kind !== 'overlay')
    throw new NativeStateError('invalid_state', 'Only boxes and overlays scroll')
  return owner.request(node, (batch, handle) =>
    batch.scrollTo(handle as NativeNode<ContainerKind>, offset)
  )
}

/** Reveal a mounted element in its scrolling ancestors. Requires `scroll_control_v1`. */
export function scrollNodeIntoView(reference: RendererNode): Promise<void> {
  const { node, owner } = mounted(reference)
  return owner.request(node, (batch, handle) => batch.scrollIntoView(handle))
}
