import {
  MAX_OVERLAY_DEPTH,
  parseElement,
  type Capability,
  type Element,
  type Limits,
  type Operation,
} from '@bun-native/protocol'
import {
  NativeStateError,
  UnsupportedFeatureError,
  type ContainerKind,
  type ElementKind,
  type NativeBatch,
  type NativeNode,
} from './types.ts'

const identities = new WeakMap<NativeNode, number>()
const encoder = new TextEncoder()
const elementKinds: readonly string[] = ['box', 'text', 'button', 'input', 'overlay']

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

/** Optional element features fail locally instead of reaching a host that lacks them. */
function supported(element: Element, capabilities: readonly Capability[]): Element {
  if (element.kind === 'overlay' && !capabilities.includes('overlays_v1'))
    throw new UnsupportedFeatureError('element:overlay')
  if (
    (element.kind === 'box' || element.kind === 'overlay') &&
    element.style?.scroll_anchor !== undefined &&
    !capabilities.includes('scroll_anchor_v1')
  )
    throw new UnsupportedFeatureError('style:scroll_anchor')
  if (
    element.kind === 'overlay' &&
    element.surface === 'window' &&
    !capabilities.includes('popup_windows_v1')
  )
    throw new UnsupportedFeatureError('overlay:surface_window')
  return element
}

const isContainer = (element: Element) => element.kind === 'box' || element.kind === 'overlay'

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

/** A bounded candidate graph; native preflight remains authoritative. */
export class Transaction implements NativeBatch {
  readonly nodes: Map<number, NodeState>
  readonly operations: Operation[] = []
  private active = true

  constructor(
    current: ReadonlyMap<number, NodeState>,
    private readonly rootId: number,
    private readonly allocateId: () => number,
    private readonly limits: Readonly<Limits>,
    private readonly capabilities: readonly Capability[]
  ) {
    this.nodes = new Map(
      [...current].map(([id, node]) => [id, { ...node, children: [...node.children] }])
    )
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
    const normalized = supported(normalize(element), this.capabilities)
    const node = makeNode(this.allocateId(), normalized)
    this.nodes.set(node.id, node)
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
    const node = own(this.nodes, handle)
    const element = supported(normalize(value), this.capabilities)
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

  insert(parentHandle: NativeNode<ContainerKind>, childHandle: NativeNode, index: number): void {
    this.check()
    const parent = own(this.nodes, parentHandle)
    const child = own(this.nodes, childHandle)
    if (!isContainer(parent.element) || child.id === this.rootId)
      throw new NativeStateError(
        'invalid_state',
        'Only boxes and overlays accept children and the root cannot move'
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
    if (child.parent !== undefined) {
      const previous = this.nodes.get(child.parent)!
      previous.children.splice(previous.children.indexOf(child.id), 1)
    }
    parent.children.splice(index, 0, child.id)
    child.parent = parent.id
    this.operations.push({ type: 'insert', parent_id: parent.id, child_id: child.id, index })
  }

  append(parentHandle: NativeNode<ContainerKind>, childHandle: NativeNode): void {
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
      const parent = this.nodes.get(node.parent)!
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
    // `popup` marks content beneath a popup window surface: keyboard focus
    // stays on the parent window, so it holds no editor or further layer.
    const pending = [{ id: this.rootId, depth: 0, overlays: 0, popup: false }]
    for (const { id, depth, overlays: outer, popup: inPopup } of pending) {
      if (depth > this.limits.max_depth)
        throw new NativeStateError('limit_exceeded', 'Native tree depth limit exceeded')
      const node = this.nodes.get(id)!
      seen += 1
      const element = node.element
      const overlays = outer + (element.kind === 'overlay' ? 1 : 0)
      if (overlays > MAX_OVERLAY_DEPTH)
        throw new NativeStateError('limit_exceeded', 'Overlay nesting limit exceeded')
      if (inPopup && (element.kind === 'input' || element.kind === 'overlay'))
        throw new NativeStateError(
          'invalid_state',
          'Popup window content cannot contain inputs or overlays'
        )
      const popup = inPopup || (element.kind === 'overlay' && element.surface === 'window')
      const texts =
        element.kind === 'input'
          ? [element.value, element.placeholder ?? '']
          : 'text' in element
            ? [element.text]
            : []
      for (const text of texts) {
        const size = encoder.encode(text).byteLength
        if (size > this.limits.max_text_bytes)
          throw new NativeStateError('limit_exceeded', 'Native text limit exceeded')
        bytes += size
      }
      if (bytes > this.limits.max_text_bytes_per_window)
        throw new NativeStateError('limit_exceeded', 'Window text memory limit exceeded')
      pending.push(
        ...node.children.map((child) => ({ id: child, depth: depth + 1, overlays, popup }))
      )
    }
    if (seen !== this.nodes.size)
      throw new NativeStateError(
        'invalid_state',
        'Every created node must be attached before commit'
      )
  }
}
