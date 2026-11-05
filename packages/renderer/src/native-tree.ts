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

// Unchanged nodes share one immutable element across commits; memoize its
// serialization instead of restringifying the committed side every commit.
const keys = new WeakMap<Element, string>()
function key(element: Element): string {
  let value = keys.get(element)
  if (value === undefined) keys.set(element, (value = JSON.stringify(element)))
  return value
}

const noChildren: readonly Node[] = Object.freeze([])

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
    // Working state overlays `previous` and records only what this batch
    // changes, instead of copying every committed handle, parent and child list.
    const created = new Map<Node, NativeNode>()
    const parents = new Map<Node, Node>()
    const edited = new Map<Node, Node[]>()
    const handle = (node: Node) => created.get(node) ?? previous.get(node)!.handle
    const parentOf = (node: Node) =>
      parents.has(node) ? parents.get(node) : previous.get(node)?.parent
    const childrenOf = (node: Node): readonly Node[] =>
      edited.get(node) ?? previous.get(node)?.children ?? noChildren
    const editChildren = (node: Node): Node[] => {
      let list = edited.get(node)
      if (!list) edited.set(node, (list = [...childrenOf(node)]))
      return list
    }
    const attach = (parent: Node, child: Node, index: number) => {
      const oldParent = parentOf(child)
      if (oldParent) {
        const oldChildren = editChildren(oldParent)
        oldChildren.splice(oldChildren.indexOf(child), 1)
      }
      editChildren(parent).splice(index, 0, child)
      parents.set(child, parent)
      batch.insert(handle(parent) as NativeNode<'box'>, handle(child), index)
      counts.insert += 1
    }
    // Rescue retained keyed descendants before deleting an obsolete ancestor.
    // Moving them temporarily to this root also frees capacity before creations.
    const rescue = (node: Node): void => {
      // attach mutates the source sibling array, so traversal needs a snapshot.
      const descendants = childrenOf(node).slice()
      for (const child of descendants) {
        if (desired.has(child)) attach(root, child, childrenOf(root).length)
        else rescue(child)
      }
    }
    for (const [node, state] of previous) {
      if (desired.has(node) || (state.parent && !desired.has(state.parent))) continue
      rescue(node)
      batch.remove(state.handle)
      counts.remove += 1
      if (state.parent) {
        const siblings = editChildren(state.parent)
        siblings.splice(siblings.indexOf(node), 1)
      }
    }
    const nodes = new Map<Node, Committed>()
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
        const nativeNode = batch.create(state.element)
        created.set(node, nativeNode)
        edited.set(node, [])
        counts.create += 1
        if (node === root) {
          batch.append(window.root, nativeNode)
          counts.insert += 1
        }
        nodes.set(node, { ...state, handle: nativeNode })
        continue
      }
      // Element identity means the same reused capture with an unchanged handle.
      if (old.element === state.element) {
        nodes.set(node, old)
        continue
      }
      nodes.set(node, { ...state, handle: old.handle })
      if (state.element.kind === 'input') {
        if (updateInput(window, batch, old, { ...state, element: state.element })) counts.set += 1
      } else if (key(old.element) !== key(state.element)) {
        batch.set(old.handle as NativeNode<Exclude<Element['kind'], 'input'>>, state.element)
        counts.set += 1
      }
    }

    for (const [parent, state] of desired) {
      const current = childrenOf(parent)
      if (
        current === state.children ||
        (current.length === state.children.length &&
          current.every((child, index) => child === state.children[index]))
      )
        continue
      const siblings = editChildren(parent)
      const stable = stableChildren(siblings, state.children)
      let anchor: Node | undefined
      for (let index = state.children.length - 1; index >= 0; index -= 1) {
        const child = state.children[index]!
        if (!stable.has(child)) {
          const before = anchor === undefined ? siblings.length : siblings.indexOf(anchor)
          const old = parentOf(child) === parent ? siblings.indexOf(child) : -1
          // Native insert indices are interpreted after detaching the child.
          attach(parent, child, before - (old >= 0 && old < before ? 1 : 0))
        }
        anchor = child
      }
    }
    return nodes
  })
  return { nodes: next, counts }
}
