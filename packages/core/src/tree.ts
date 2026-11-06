import { parseElement, type Element, type Limits, type Operation } from '@bun-native/protocol'
import {
  NativeStateError,
  UnsupportedFeatureError,
  type ElementKind,
  type NativeBatch,
  type NativeNode,
} from './types.ts'

const identities = new WeakMap<NativeNode, number>()
const encoder = new TextEncoder()
// Normalized elements are replaced, never mutated, so their size is stable.
const textSizes = new WeakMap<Element, readonly number[]>()
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

export interface NodeState {
  id: number
  handle: NativeNode
  element: Element
  parent: number | undefined
  children: number[]
  inputRevision: number
}

export function makeNode<E extends Element>(
  id: number,
  element: E
): NodeState & { handle: NativeNode<E['kind']> } {
  const handle = Object.freeze({ kind: element.kind }) as NativeNode<E['kind']>
  identities.set(handle, id)
  return {
    id,
    handle,
    element: normalize(element),
    parent: undefined,
    children: [],
    inputRevision: 0,
  }
}

export function own(nodes: ReadonlyMap<number, NodeState>, handle: NativeNode): NodeState {
  const id = identities.get(handle)
  const node = id === undefined ? undefined : nodes.get(id)
  if (!node || node.handle !== handle)
    throw new NativeStateError(
      'invalid_handle',
      'Node is forged, disposed or belongs to another window'
    )
  return node
}

function textSizesOf(element: Element): readonly number[] {
  let sizes = textSizes.get(element)
  if (!sizes) {
    const texts =
      element.kind === 'input'
        ? [element.value, element.placeholder ?? '']
        : element.kind === 'box'
          ? []
          : [element.text]
    sizes = texts.map((text) => encoder.encode(text).byteLength)
    textSizes.set(element, sizes)
  }
  return sizes
}

/**
 * A bounded candidate graph; native preflight remains authoritative. Nodes are
 * shared with the committed graph until this transaction first writes one.
 */
export class Transaction implements NativeBatch {
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

  /** The candidate's own copy of a node, made on its first write. */
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
    if (this.operations.length >= this.limits.max_operations)
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

  set(
    node: NativeNode<'input'>,
    element: Extract<Element, { kind: 'input' }>,
    expectedInputRevision: number
  ): void
  set<K extends Exclude<ElementKind, 'input'>>(
    node: NativeNode<K>,
    element: Extract<Element, { kind: NoInfer<K> }>
  ): void
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
    // Breadth-first, one level at a time, so the depth needs no per-node record.
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
}
