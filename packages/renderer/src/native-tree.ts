import {
  NativeStateError,
  UnsupportedFeatureError,
  type NativeBatch,
  type Element,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import type { Node, Snapshot } from './nodes.ts'
import { stableChildren } from './order.ts'

export type Counts = { create: number; set: number; insert: number; remove: number }
export type Committed = Snapshot & { handle: NativeNode }

function key(element: Element): string {
  return JSON.stringify(element)
}

function updateInput(
  window: NativeWindow,
  batch: NativeBatch,
  old: Committed,
  state: Snapshot & { element: Extract<Element, { kind: 'input' }> }
): boolean {
  if (old.element.kind !== 'input')
    throw new NativeStateError('invalid_handle', 'Input kind changed')
  if (state.initialValue !== undefined && state.initialValue !== old.initialValue)
    throw new UnsupportedFeatureError('input-value-requires-revision')
  const intent = state.inputIntent
  if (intent && intent !== old.inputIntent) {
    if (intent.observedNode) {
      if (intent.observedNode !== old.handle)
        throw new NativeStateError(
          'invalid_handle',
          'Native input observation belongs to another node'
        )
      // Echo is an observation of a native edit, even if ingestion has advanced
      // again before its callback runs. Never emit it as a replacement command.
    } else {
      batch.set(old.handle as NativeNode<'input'>, state.element, intent.revision)
      return true
    }
  }
  const appearance = (element: Extract<Element, { kind: 'input' }>) =>
    JSON.stringify({ placeholder: element.placeholder ?? '', style: element.style ?? {} })
  if (appearance(old.element) === appearance(state.element)) return false
  // A style-only update preserves the current native value; this never upgrades
  // an older application value intent to a newer revision.
  const current = window.input(old.handle as NativeNode<'input'>)
  batch.set(
    old.handle as NativeNode<'input'>,
    { ...state.element, value: current.value },
    current.revision
  )
  return true
}

/** Framework-independent native diff. Publish its handles only after atomic acknowledgement. */
export async function commitNativeTree(
  window: NativeWindow,
  root: Node,
  previous: ReadonlyMap<Node, Committed>,
  desired: ReadonlyMap<Node, Snapshot>
): Promise<{ nodes: Map<Node, Committed>; counts: Counts }> {
  const counts: Counts = { create: 0, set: 0, insert: 0, remove: 0 }
  const next = await window.batch((batch) => {
    const handles = new Map([...previous].map(([node, state]) => [node, state.handle]))
    const parents = new Map([...previous].map(([node, state]) => [node, state.parent]))
    const children = new Map([...previous].map(([node, state]) => [node, [...state.children]]))
    const attach = (parent: Node, child: Node, index: number) => {
      const oldParent = parents.get(child)
      const oldChildren = oldParent && children.get(oldParent)
      if (oldChildren) oldChildren.splice(oldChildren.indexOf(child), 1)
      const siblings = children.get(parent)!
      siblings.splice(index, 0, child)
      parents.set(child, parent)
      batch.insert(handles.get(parent)! as NativeNode<'box'>, handles.get(child)!, index)
      counts.insert += 1
    }
    // Rescue retained keyed descendants before deleting an obsolete ancestor.
    // Moving them temporarily to this root also frees capacity before creations.
    const rescue = (node: Node): void => {
      // attach mutates the source sibling array, so traversal needs a snapshot.
      const descendants = children.get(node)?.slice() ?? []
      for (const child of descendants) {
        if (desired.has(child)) attach(root, child, children.get(root)!.length)
        else rescue(child)
      }
    }
    for (const [node, state] of previous) {
      if (desired.has(node) || (state.parent && !desired.has(state.parent))) continue
      rescue(node)
      batch.remove(state.handle)
      counts.remove += 1
      const siblings = state.parent && children.get(state.parent)
      if (siblings) siblings.splice(siblings.indexOf(node), 1)
    }
    for (const [node, state] of desired) {
      const old = previous.get(node)
      if (!old) {
        if (state.inputIntent?.observedNode)
          throw new NativeStateError(
            'invalid_handle',
            'Native input observation belongs to another node'
          )
        if (state.inputIntent && state.inputIntent.revision !== 0)
          throw new NativeStateError(
            'stale_revision',
            'New input value intent requires revision zero'
          )
        const handle = batch.create(state.element)
        handles.set(node, handle)
        children.set(node, [])
        counts.create += 1
        if (node === root) {
          batch.append(window.root, handle)
          counts.insert += 1
        }
      } else if (state.element.kind === 'input') {
        if (updateInput(window, batch, old, { ...state, element: state.element })) counts.set += 1
      } else if (key(old.element) !== key(state.element)) {
        batch.set(old.handle as NativeNode<Exclude<Element['kind'], 'input'>>, state.element)
        counts.set += 1
      }
    }

    for (const [parent, state] of desired) {
      const siblings = children.get(parent)!
      if (
        siblings.length === state.children.length &&
        siblings.every((child, index) => child === state.children[index])
      )
        continue
      const stable = stableChildren(siblings, state.children)
      let anchor: Node | undefined
      for (let index = state.children.length - 1; index >= 0; index -= 1) {
        const child = state.children[index]!
        if (!stable.has(child)) {
          const before = anchor === undefined ? siblings.length : siblings.indexOf(anchor)
          const old = parents.get(child) === parent ? siblings.indexOf(child) : -1
          // Native insert indices are interpreted after detaching the child.
          attach(parent, child, before - (old >= 0 && old < before ? 1 : 0))
        }
        anchor = child
      }
    }
    return new Map(
      [...desired].map(([node, state]) => [node, { ...state, handle: handles.get(node)! }])
    )
  })
  return { nodes: next, counts }
}
