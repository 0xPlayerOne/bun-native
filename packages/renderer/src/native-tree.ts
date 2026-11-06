import {
  NativeStateError,
  UnsupportedFeatureError,
  type NativeBatch,
  type Element,
  type ContainerKind,
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
    JSON.stringify({
      placeholder: element.placeholder ?? '',
      disabled: element.disabled === true,
      read_only: element.read_only === true,
      style: element.style ?? {},
    })
  if (appearance(old.element) === appearance(state.element)) return false
  // An appearance/state-only update preserves the current native value; this never upgrades
  // an older application value intent to a newer revision.
  const current = window.input(old.handle as NativeNode<'input'>)
  batch.set(
    old.handle as NativeNode<'input'>,
    { ...state.element, value: current.value },
    current.revision
  )
  return true
}

export type Commit = {
  /** Committed records for every changed node, to publish over the previous ones. */
  updates: Map<Node, Committed>
  /** Previously committed nodes that left the tree, including removed descendants. */
  removed: Node[]
  counts: Counts
}

/**
 * Framework-independent native diff from the changed captures alone. Publish
 * its records only after atomic acknowledgement; `previous` is read, never
 * mutated, so a rejected batch leaves committed state untouched.
 */
export async function commitNativeTree(
  window: NativeWindow,
  root: Node,
  previous: ReadonlyMap<Node, Committed>,
  changes: ReadonlyMap<Node, Snapshot>
): Promise<Commit> {
  const counts: Counts = { create: 0, set: 0, insert: 0, remove: 0 }
  const [updates, removed] = await window.batch((batch) => {
    const removed: Node[] = []
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
    // `from` is the child's known index among its current working siblings.
    const attach = (parent: Node, child: Node, index: number, from?: number) => {
      const oldParent = parentOf(child)
      if (oldParent) {
        const oldChildren = editChildren(oldParent)
        oldChildren.splice(from ?? oldChildren.indexOf(child), 1)
      }
      editChildren(parent).splice(index, 0, child)
      parents.set(child, parent)
      batch.insert(handle(parent) as NativeNode<ContainerKind>, handle(child), index)
      counts.insert += 1
    }
    // Rescue retained keyed descendants before deleting an obsolete ancestor.
    // Moving them temporarily to this root also frees capacity before creations.
    // A retained descendant was reinserted, so its whole subtree was recaptured.
    // Root children already removed natively but not yet dropped from its list.
    let unlisted = 0
    const rescue = (node: Node): void => {
      // attach mutates the source sibling array, so traversal needs a snapshot.
      const descendants = childrenOf(node).slice()
      for (const child of descendants) {
        if (changes.has(child)) attach(root, child, childrenOf(root).length - unlisted)
        else rescue(child)
      }
    }
    const forget = (node: Node): void => {
      removed.push(node)
      for (const child of previous.get(node)!.children) if (!changes.has(child)) forget(child)
    }
    // Only a recaptured parent can have lost a committed child. A lost child
    // still in the tree was reinserted elsewhere and is therefore recaptured.
    // Lost children leave their working list in one pass per parent, so
    // clearing a keyed region costs O(children) rather than O(children²).
    for (const [parent, state] of changes) {
      const old = previous.get(parent)
      if (!old?.children.length) continue
      const retained = new Set(state.children)
      const lost = new Set<Node>()
      for (const node of old.children) {
        if (changes.has(node) || retained.has(node)) continue
        rescue(node)
        batch.remove(previous.get(node)!.handle)
        counts.remove += 1
        lost.add(node)
        if (parent === root) unlisted += 1
        forget(node)
      }
      if (lost.size)
        edited.set(
          parent,
          childrenOf(parent).filter((node) => !lost.has(node))
        )
      if (parent === root) unlisted = 0
    }
    const updates = new Map<Node, Committed>()
    for (const [node, state] of changes) {
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
        updates.set(node, { ...state, handle: nativeNode })
        continue
      }
      updates.set(node, { ...state, handle: old.handle })
      if (state.element.kind === 'input') {
        if (updateInput(window, batch, old, { ...state, element: state.element })) counts.set += 1
      } else if (key(old.element) !== key(state.element)) {
        batch.set(old.handle as NativeNode<Exclude<Element['kind'], 'input'>>, state.element)
        counts.set += 1
      }
    }

    // A clean node's children are unchanged, so only recaptured lists can differ.
    for (const [parent, state] of changes) {
      const current = childrenOf(parent)
      if (
        current === state.children ||
        (current.length === state.children.length &&
          current.every((child, index) => child === state.children[index]))
      )
        continue
      const siblings = editChildren(parent)
      const stable = stableChildren(siblings, state.children)
      // `before` tracks the anchor's working index from the end; it only moves
      // left, so locating stable anchors costs O(children) for the whole list.
      let before = siblings.length
      for (let index = state.children.length - 1; index >= 0; index -= 1) {
        const child = state.children[index]!
        if (stable.has(child)) {
          do if (--before < 0) throw new Error('Stable native child is not in its parent')
          while (siblings[before] !== child)
          continue
        }
        const old = parentOf(child) === parent ? siblings.indexOf(child) : -1
        // Native insert indices are interpreted after detaching the child.
        const at = before - (old >= 0 && old < before ? 1 : 0)
        attach(parent, child, at, old >= 0 ? old : undefined)
        before = at
      }
    }
    return [updates, removed] as const
  })
  return { updates, removed, counts }
}
