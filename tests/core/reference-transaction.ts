// The whole-window transaction that `packages/core/src/tree.ts` replaced, kept
// verbatim as the oracle for its randomized equivalence test: a full candidate
// Map copy per batch and a breadth-first validation of every node.
import { parseElement, type Element, type Limits, type Operation } from '@bun-native/protocol'
import { makeNode, own, type NodeState } from '../../packages/core/src/tree.ts'
import {
  NativeStateError,
  UnsupportedFeatureError,
  type NativeNode,
} from '../../packages/core/src/types.ts'

const encoder = new TextEncoder()
const elementKinds: readonly string[] = ['box', 'text', 'button', 'input']

function normalize(element: Element): Element {
  if (
    element !== null &&
    typeof element === 'object' &&
    typeof element.kind === 'string' &&
    !elementKinds.includes(element.kind)
  )
    throw new UnsupportedFeatureError('element:' + element.kind)
  return parseElement(element)
}

function textSizesOf(element: Element): readonly number[] {
  const texts =
    element.kind === 'input'
      ? [element.value, element.placeholder ?? '']
      : element.kind === 'box'
        ? []
        : [element.text]
  return texts.map((text) => encoder.encode(text).byteLength)
}

export class ReferenceTransaction {
  readonly nodes: Map<number, NodeState>
  readonly operations: Operation[] = []
  private readonly copied = new Set<number>()
  private active = true

  constructor(
    current: ReadonlyMap<number, NodeState>,
    private readonly rootId: number,
    private readonly allocateId: () => number,
    private readonly limits: Readonly<Limits>
  ) {
    this.nodes = new Map(current)
  }

  private writable(node: NodeState): NodeState {
    if (this.copied.has(node.id)) return this.nodes.get(node.id)!
    const copy = { ...node, children: [...node.children] }
    this.nodes.set(node.id, copy)
    this.copied.add(node.id)
    return copy
  }

  private check(): void {
    if (!this.active)
      throw new NativeStateError('invalid_state', 'Batch callback has already returned')
    // The logical bound of #488: a transaction may span several native batches.
    if (this.operations.length >= 2 * this.limits.max_nodes_per_window + this.limits.max_operations)
      throw new NativeStateError('limit_exceeded', 'Batch operation limit exceeded')
  }

  finish(): void {
    this.active = false
  }

  create<E extends Element>(element: E): NativeNode<E['kind']> {
    this.check()
    if (this.nodes.size >= this.limits.max_nodes_per_window)
      throw new NativeStateError('limit_exceeded', 'Window node limit exceeded')
    const normalized = normalize(element)
    const node = makeNode(this.allocateId(), normalized)
    this.nodes.set(node.id, node)
    this.copied.add(node.id)
    this.operations.push({ type: 'create', node_id: node.id, element: node.element })
    return node.handle as NativeNode<E['kind']>
  }

  set(handle: NativeNode, value: Element, expectedInputRevision?: number): void {
    this.check()
    const node = this.writable(own(this.nodes, handle))
    const element = normalize(value)
    if (element.kind !== node.element.kind)
      throw new NativeStateError(
        'invalid_state',
        'Element kind cannot change; create a replacement node'
      )
    if (element.kind === 'input') {
      if (
        !Number.isSafeInteger(expectedInputRevision) ||
        expectedInputRevision !== node.inputRevision
      )
        throw new NativeStateError(
          'stale_revision',
          'Input update requires its current observed revision'
        )
      if (node.inputRevision === Number.MAX_SAFE_INTEGER)
        throw new NativeStateError('limit_exceeded', 'Input revision exhausted')
      this.operations.push({
        type: 'set',
        node_id: node.id,
        element,
        expected_input_revision: node.inputRevision,
      })
      node.inputRevision += 1
    } else {
      if (expectedInputRevision !== undefined)
        throw new NativeStateError('invalid_state', 'Only an input accepts an edit revision')
      this.operations.push({ type: 'set', node_id: node.id, element })
    }
    node.element = element
  }

  insert(parentHandle: NativeNode<'box'>, childHandle: NativeNode, index: number): void {
    this.check()
    let parent = own(this.nodes, parentHandle)
    let child = own(this.nodes, childHandle)
    if (parent.element.kind !== 'box' || child.id === this.rootId)
      throw new NativeStateError(
        'invalid_state',
        'Only boxes accept children and the root cannot move'
      )
    let ancestor: NodeState | undefined = parent
    while (ancestor) {
      if (ancestor.id === child.id)
        throw new NativeStateError('invalid_state', 'Native tree cannot contain a cycle')
      ancestor = ancestor.parent === undefined ? undefined : this.nodes.get(ancestor.parent)
    }
    const length = parent.children.length - (child.parent === parent.id ? 1 : 0)
    if (!Number.isSafeInteger(index) || index < 0 || index > length)
      throw new NativeStateError('invalid_state', 'Child insertion index is out of range')
    child = this.writable(child)
    if (child.parent !== undefined) {
      const previous = this.writable(this.nodes.get(child.parent)!)
      previous.children.splice(previous.children.indexOf(child.id), 1)
    }
    parent = this.writable(parent)
    parent.children.splice(index, 0, child.id)
    child.parent = parent.id
    this.operations.push({ type: 'insert', parent_id: parent.id, child_id: child.id, index })
  }

  append(parentHandle: NativeNode<'box'>, childHandle: NativeNode): void {
    const parent = own(this.nodes, parentHandle)
    const child = own(this.nodes, childHandle)
    this.insert(
      parentHandle,
      childHandle,
      parent.children.length - (child.parent === parent.id ? 1 : 0)
    )
  }

  remove(handle: NativeNode): void {
    this.check()
    const node = own(this.nodes, handle)
    if (node.id === this.rootId)
      throw new NativeStateError('invalid_state', 'Close the window to dispose its root')
    if (node.parent !== undefined) {
      const parent = this.writable(this.nodes.get(node.parent)!)
      parent.children.splice(parent.children.indexOf(node.id), 1)
    }
    const pending = [node.id]
    for (const id of pending) {
      const child = this.nodes.get(id)!
      pending.push(...child.children)
      this.nodes.delete(id)
    }
    this.operations.push({ type: 'delete', node_id: node.id })
  }

  validate(): void {
    let seen = 0
    let bytes = 0
    let level = [this.rootId]
    for (let depth = 0; level.length; depth += 1) {
      if (depth > this.limits.max_depth)
        throw new NativeStateError('limit_exceeded', 'Native tree depth limit exceeded')
      const next: number[] = []
      for (const id of level) {
        const node = this.nodes.get(id)!
        seen += 1
        for (const size of textSizesOf(node.element)) {
          if (size > this.limits.max_text_bytes)
            throw new NativeStateError('limit_exceeded', 'Native text limit exceeded')
          bytes += size
        }
        if (bytes > this.limits.max_text_bytes_per_window)
          throw new NativeStateError('limit_exceeded', 'Window text memory limit exceeded')
        for (const child of node.children) next.push(child)
      }
      level = next
    }
    if (seen !== this.nodes.size)
      throw new NativeStateError(
        'invalid_state',
        'Every created node must be attached before commit'
      )
  }

  /** The old window commit: merge newer native edits, then adopt the copy. */
  commitInto(current: ReadonlyMap<number, NodeState>): Map<number, NodeState> {
    for (const [id, candidate] of this.nodes) {
      const committed = current.get(id)
      if (
        committed &&
        committed.inputRevision > candidate.inputRevision &&
        committed.element.kind === 'input' &&
        candidate.element.kind === 'input'
      ) {
        candidate.inputRevision = committed.inputRevision
        candidate.element = { ...candidate.element, value: committed.element.value }
      }
    }
    return this.nodes
  }
}
