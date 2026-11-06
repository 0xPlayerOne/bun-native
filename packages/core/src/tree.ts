import {
  DECORATION_FIELDS,
  MAX_OVERLAY_DEPTH,
  MAX_SCROLL_OFFSET,
  parseElement,
  type Capability,
  type Element,
  type Limits,
  type Operation,
  type Style,
} from '@bun-native/protocol'
import {
  NativeStateError,
  UnsupportedFeatureError,
  type ContainerKind,
  type ElementKind,
  type NativeBatch,
  type NativeNode,
  type ScrollOffset,
} from './types.ts'

const identities = new WeakMap<NativeNode, number>()
const encoder = new TextEncoder()
const elementKinds: readonly string[] = ['box', 'text', 'button', 'input', 'split', 'overlay']
const isContainer = (element: Element) =>
  element.kind === 'box' || element.kind === 'split' || element.kind === 'overlay'

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
  if (element.kind === 'split' && !capabilities.includes('split_v1'))
    throw new UnsupportedFeatureError('element:split')
  if (element.kind === 'overlay' && !capabilities.includes('overlays_v1'))
    throw new UnsupportedFeatureError('element:overlay')
  const style: Style = element.style ?? {}
  if (
    !capabilities.includes('style_decoration_v1') &&
    DECORATION_FIELDS.some((field) => style[field] !== undefined)
  )
    throw new UnsupportedFeatureError('style:decoration')
  if (
    (element.kind === 'box' || element.kind === 'overlay') &&
    element.style?.scroll_anchor !== undefined &&
    !capabilities.includes('scroll_anchor_v1')
  )
    throw new UnsupportedFeatureError('style:scroll_anchor')
  if (
    element.kind === 'overlay' &&
    (element.autofocus !== undefined || element.navigation !== undefined) &&
    !capabilities.includes('overlay_keyboard_v1')
  )
    throw new UnsupportedFeatureError(
      element.autofocus === undefined ? 'overlay:navigation' : 'overlay:autofocus'
    )
  return element
}

function requireCapability(
  capabilities: readonly Capability[],
  capability: Capability,
  feature: string
) {
  if (!capabilities.includes(capability)) throw new UnsupportedFeatureError(feature)
}

/** A focus or scroll request checked against the final candidate tree. */
type Request = {
  type: 'focus' | 'scroll_to' | 'scroll_into_view'
  id: number
  x?: number
  y?: number
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

/** A bounded candidate graph; native preflight remains authoritative. */
export class Transaction implements NativeBatch {
  readonly nodes: Map<number, NodeState>
  readonly operations: Operation[] = []
  private readonly requests: Request[] = []
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
        'Only boxes, splits and overlays accept children and the root cannot move'
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

  focus(handle: NativeNode<'button' | 'input'>): void {
    this.check()
    requireCapability(this.capabilities, 'focus_v1', 'operation:focus')
    const node = own(this.nodes, handle)
    this.requests.push({ type: 'focus', id: node.id })
    this.operations.push({ type: 'focus', node_id: node.id })
  }

  scrollTo(handle: NativeNode<ContainerKind>, offset: ScrollOffset): void {
    this.check()
    requireCapability(this.capabilities, 'scroll_control_v1', 'operation:scroll_to')
    const node = own(this.nodes, handle)
    if (offset === null || typeof offset !== 'object')
      throw new TypeError('A scroll offset must be an object')
    const axes: { x?: number; y?: number } = {}
    for (const axis of ['x', 'y'] as const) {
      const value = offset[axis]
      if (value === undefined) continue
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_SCROLL_OFFSET
      )
        throw new RangeError('Scroll offsets must be finite and between 0 and ' + MAX_SCROLL_OFFSET)
      axes[axis] = value
    }
    if (axes.x === undefined && axes.y === undefined)
      throw new TypeError('A scroll offset requires x or y')
    this.requests.push({ type: 'scroll_to', id: node.id, ...axes })
    this.operations.push({ type: 'scroll_to', node_id: node.id, ...axes })
  }

  scrollIntoView(handle: NativeNode): void {
    this.check()
    requireCapability(this.capabilities, 'scroll_control_v1', 'operation:scroll_into_view')
    const node = own(this.nodes, handle)
    this.requests.push({ type: 'scroll_into_view', id: node.id })
    this.operations.push({ type: 'scroll_into_view', node_id: node.id })
  }

  /** The modal overlay highest in paint order: deepest, then later in tree order. */
  private activeModal(): number | undefined {
    let active: { depth: number; id: number } | undefined
    const pending = [{ id: this.rootId, outer: 0 }]
    while (pending.length) {
      const { id, outer } = pending.pop()!
      const node = this.nodes.get(id)!
      let depth = outer
      if (node.element.kind === 'overlay') {
        depth += 1
        if (node.element.modal && (!active || depth >= active.depth)) active = { depth, id }
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        pending.push({ id: node.children[index]!, outer: depth })
    }
    return active?.id
  }

  private validateRequests(): void {
    for (const request of this.requests) {
      const node = this.nodes.get(request.id)
      if (!node)
        throw new NativeStateError('invalid_handle', 'Request target is removed by this batch')
      const element = node.element
      if (request.type === 'focus') {
        if (element.kind !== 'input' && (element.kind !== 'button' || element.disabled))
          throw new NativeStateError(
            'invalid_state',
            'Only an enabled button or an input can take focus'
          )
        const modal = this.activeModal()
        let ancestor: NodeState | undefined = node
        while (modal !== undefined && ancestor && ancestor.id !== modal)
          ancestor = ancestor.parent === undefined ? undefined : this.nodes.get(ancestor.parent)
        if (modal !== undefined && !ancestor)
          throw new NativeStateError(
            'invalid_state',
            'Focus target is outside the active modal overlay'
          )
      } else if (request.type === 'scroll_to') {
        const overflow = isContainer(element) ? element.style?.overflow : undefined
        const horizontal = overflow === 'scroll_x' || overflow === 'scroll'
        const vertical = overflow === 'scroll_y' || overflow === 'scroll'
        if ((request.x !== undefined && !horizontal) || (request.y !== undefined && !vertical))
          throw new NativeStateError(
            'invalid_state',
            'scrollTo requires a container scrolling on each given axis'
          )
      }
    }
  }

  validate(): void {
    let seen = 0
    let bytes = 0
    const pending = [{ id: this.rootId, depth: 0, overlays: 0 }]
    for (const { id, depth, overlays: outer } of pending) {
      if (depth > this.limits.max_depth)
        throw new NativeStateError('limit_exceeded', 'Native tree depth limit exceeded')
      const node = this.nodes.get(id)!
      seen += 1
      const element = node.element
      if (element.kind === 'split' && node.children.length > 2)
        throw new NativeStateError('limit_exceeded', 'A split owns at most two panes')
      const overlays = outer + (element.kind === 'overlay' ? 1 : 0)
      if (overlays > MAX_OVERLAY_DEPTH)
        throw new NativeStateError('limit_exceeded', 'Overlay nesting limit exceeded')
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
      pending.push(...node.children.map((child) => ({ id: child, depth: depth + 1, overlays })))
    }
    if (seen !== this.nodes.size)
      throw new NativeStateError(
        'invalid_state',
        'Every created node must be attached before commit'
      )
    this.validateRequests()
  }
}
