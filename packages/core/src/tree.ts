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
// Normalized elements are replaced, never mutated, so their size is stable.
const textSizes = new WeakMap<Element, readonly number[]>()
const elementKinds: readonly string[] = ['box', 'text', 'button', 'input', 'split', 'overlay']
const isContainer = (element: Element) =>
  element.kind === 'box' || element.kind === 'split' || element.kind === 'overlay'
/** Splits and overlays carry placement rules that the incremental check leaves to the full walk. */
const layered = (element: Element) => element.kind === 'split' || element.kind === 'overlay'

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
  if (
    element.kind === 'overlay' &&
    element.surface === 'window' &&
    !capabilities.includes('popup_windows_v1')
  )
    throw new UnsupportedFeatureError('overlay:surface_window')
  if (
    element.kind === 'input' &&
    (element.disabled === true || element.read_only === true) &&
    !capabilities.includes('input_states_v1')
  )
    throw new UnsupportedFeatureError('input:' + (element.disabled ? 'disabled' : 'read_only'))
  if (
    (element.kind === 'split' || element.kind === 'overlay') &&
    element.accessible_label !== undefined &&
    !capabilities.includes('accessibility_v1')
  )
    throw new UnsupportedFeatureError(element.kind + ':accessible_label')
  if (
    ((element.kind === 'box' && element.accessible_role !== undefined) ||
      (element.kind === 'text' && element.accessible_live !== undefined)) &&
    !capabilities.includes('accessibility_lists_v1')
  )
    throw new UnsupportedFeatureError(
      element.kind === 'box' ? 'box:accessible_role' : 'text:accessible_live'
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

/**
 * One logical transaction may exceed a native batch (see commit-plan.ts), but
 * it stays bounded: a full-window mount needs a create and an insert per node.
 */
function logicalOperationLimit(limits: Readonly<Limits>): number {
  return 2 * limits.max_nodes_per_window + limits.max_operations
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
        : 'text' in element
          ? [element.text]
          : 'accessible_label' in element && element.accessible_label !== undefined
            ? [element.accessible_label]
            : []
    sizes = texts.map((text) => encoder.encode(text).byteLength)
    textSizes.set(element, sizes)
  }
  return sizes
}

function textBytesOf(element: Element | undefined): number {
  let bytes = 0
  if (element) for (const size of textSizesOf(element)) bytes += size
  return bytes
}

/**
 * Text totals of a committed graph, kept current by commits and native edits
 * so a batch checks the window budget without walking the window.
 */
export class CommittedText {
  bytes = 0
  /** Committed nodes above the per-text limit; only a native edit leaves one. */
  readonly oversized = new Set<number>()

  constructor(
    private readonly maxTextBytes: number,
    nodes: Iterable<NodeState> = []
  ) {
    for (const node of nodes) this.replace(node.id, undefined, node.element)
  }

  /** Account node `id` holding `next` (absent once removed) instead of `previous`. */
  replace(id: number, previous: Element | undefined, next: Element | undefined): void {
    this.bytes += textBytesOf(next) - textBytesOf(previous)
    if (next && textSizesOf(next).some((size) => size > this.maxTextBytes)) this.oversized.add(id)
    else this.oversized.delete(id)
  }
}

/**
 * The candidate graph: this transaction's own node copies and removals over
 * the committed map, which it never writes, so opening a batch costs nothing
 * per window node.
 */
class Overlay implements ReadonlyMap<number, NodeState> {
  /** Nodes this transaction created or wrote; each is its own copy. */
  readonly writes = new Map<number, NodeState>()
  /** Committed nodes this transaction removed. */
  readonly deletes = new Set<number>()
  size: number

  constructor(readonly base: ReadonlyMap<number, NodeState>) {
    this.size = base.size
  }

  get(id: number): NodeState | undefined {
    return this.writes.get(id) ?? (this.deletes.has(id) ? undefined : this.base.get(id))
  }

  has(id: number): boolean {
    return this.get(id) !== undefined
  }

  /** Node IDs are never reused, so a removed node is never written again. */
  write(node: NodeState): void {
    if (!this.has(node.id)) this.size += 1
    this.writes.set(node.id, node)
  }

  delete(id: number): void {
    if (!this.has(id)) return
    this.size -= 1
    this.writes.delete(id)
    if (this.base.has(id)) this.deletes.add(id)
  }

  /** Committed order, then created nodes in creation order, as a full copy had. */
  *entries(): MapIterator<[number, NodeState]> {
    for (const id of this.base.keys()) {
      const node = this.get(id)
      if (node) yield [id, node]
    }
    for (const entry of this.writes) if (!this.base.has(entry[0])) yield entry
  }

  *keys(): MapIterator<number> {
    for (const [id] of this.entries()) yield id
  }

  *values(): MapIterator<NodeState> {
    for (const [, node] of this.entries()) yield node
  }

  [Symbol.iterator](): MapIterator<[number, NodeState]> {
    return this.entries()
  }

  forEach(
    callback: (node: NodeState, id: number, map: ReadonlyMap<number, NodeState>) => void
  ): void {
    for (const [id, node] of this.entries()) callback(node, id, this)
  }
}

/**
 * A bounded candidate graph; native preflight remains authoritative. Nodes are
 * shared with the committed graph until this transaction first writes one.
 */
export class Transaction implements NativeBatch {
  readonly nodes: Overlay
  readonly operations: Operation[] = []
  private readonly requests: Request[] = []
  /** Created and moved nodes: the only places a batch can break ownership or depth. */
  private readonly attached: number[] = []
  private active = true

  /** `text` describes `current`, and both stay unchanged until `commit`. */
  constructor(
    current: ReadonlyMap<number, NodeState>,
    private readonly rootId: number,
    private readonly allocateId: () => number,
    private readonly limits: Readonly<Limits>,
    private readonly capabilities: readonly Capability[],
    private readonly text: CommittedText
  ) {
    this.nodes = new Overlay(current)
  }

  /** The candidate's own copy of a node, made on its first write. */
  private writable(node: NodeState): NodeState {
    const written = this.nodes.writes.get(node.id)
    if (written) return written
    const copy = { ...node, children: [...node.children] }
    this.nodes.write(copy)
    return copy
  }

  private check(): void {
    if (!this.active)
      throw new NativeStateError('invalid_state', 'Batch callback has already returned')
    if (this.operations.length >= logicalOperationLimit(this.limits))
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
    this.nodes.write(node)
    this.attached.push(node.id)
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
    // An overlay's surface decides what its subtree may hold.
    if (element.kind === 'overlay') this.attached.push(node.id)
  }

  insert(parentHandle: NativeNode<ContainerKind>, childHandle: NativeNode, index: number): void {
    this.check()
    let parent = own(this.nodes, parentHandle)
    let child = own(this.nodes, childHandle)
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
    child = this.writable(child)
    if (child.parent !== undefined) {
      const previous = this.writable(this.nodes.get(child.parent)!)
      previous.children.splice(previous.children.indexOf(child.id), 1)
    }
    parent = this.writable(parent)
    parent.children.splice(index, 0, child.id)
    child.parent = parent.id
    this.attached.push(child.id)
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
        if ((element.kind !== 'input' && element.kind !== 'button') || element.disabled === true)
          throw new NativeStateError(
            'invalid_state',
            'Only an enabled button or an enabled input can take focus'
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

  /**
   * Give created nodes the identities in `identity` (old to new) before a
   * staged commit (see commit-plan.ts). Their handles were never committed,
   * and only this transaction's own copies can name a created node.
   */
  renumber(identity: ReadonlyMap<number, number>): void {
    const { writes } = this.nodes
    const map = (id: number) => identity.get(id) ?? id
    const written = [...writes.values()]
    for (const id of identity.keys()) writes.delete(id)
    for (const node of written) {
      const next = map(node.id)
      if (next !== node.id) {
        identities.set(node.handle, next)
        node.id = next
      }
      if (node.parent !== undefined) node.parent = map(node.parent)
      node.children = node.children.map(map)
      writes.set(next, node)
    }
  }

  /** The candidate's window text bytes, from the committed total and this batch's writes. */
  private textBytes(): number {
    const { base, writes, deletes } = this.nodes
    let bytes = this.text.bytes
    for (const [id, node] of writes)
      bytes += textBytesOf(node.element) - textBytesOf(base.get(id)?.element)
    for (const id of deletes) bytes -= textBytesOf(base.get(id)?.element)
    return bytes
  }

  /**
   * The committed graph was valid, and create, insert and remove keep parent
   * and child links consistent and reject cycles. A batch can then break depth
   * or attachment only at or below a node it created or moved, and a text
   * limit only through a node it wrote. When none of those can fail, the batch
   * is valid without walking the window; otherwise the whole-graph walk runs
   * to report the first failure in its own order.
   */
  validate(): void {
    const { limits, nodes } = this
    if (this.text.oversized.size || this.textBytes() > limits.max_text_bytes_per_window)
      return this.walk()
    for (const node of nodes.writes.values())
      for (const size of textSizesOf(node.element))
        if (size > limits.max_text_bytes) return this.walk()
    const seen = new Set<number>()
    // Flat (id, depth) pairs.
    const pending: number[] = []
    for (const id of this.attached) {
      let top = nodes.get(id)
      if (!top || seen.has(id)) continue
      let depth = 0
      if (layered(top.element)) return this.walk()
      while (top.parent !== undefined) {
        top = nodes.get(top.parent)!
        if (layered(top.element)) return this.walk()
        depth += 1
      }
      if (top.id !== this.rootId) return this.walk()
      pending.push(id, depth)
      while (pending.length) {
        const level = pending.pop()!
        const next = pending.pop()!
        if (level > limits.max_depth) return this.walk()
        if (seen.has(next)) continue
        seen.add(next)
        const state = nodes.get(next)!
        if (layered(state.element)) return this.walk()
        for (const child of state.children) pending.push(child, level + 1)
      }
    }
    this.validateRequests()
  }

  private walk(): void {
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
      if (element.kind === 'split' && node.children.length > 2)
        throw new NativeStateError('limit_exceeded', 'A split owns at most two panes')
      const overlays = outer + (element.kind === 'overlay' ? 1 : 0)
      if (overlays > MAX_OVERLAY_DEPTH)
        throw new NativeStateError('limit_exceeded', 'Overlay nesting limit exceeded')
      if (inPopup && (element.kind === 'input' || element.kind === 'overlay'))
        throw new NativeStateError(
          'invalid_state',
          'Popup window content cannot contain inputs or overlays'
        )
      const popup = inPopup || (element.kind === 'overlay' && element.surface === 'window')
      for (const size of textSizesOf(element)) {
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
    this.validateRequests()
  }

  /**
   * Apply this validated, acknowledged batch to the committed graph and text
   * totals it was opened over, in time proportional to the batch.
   */
  commit(nodes: Map<number, NodeState>, text: CommittedText): void {
    if (nodes !== this.nodes.base || text !== this.text)
      throw new NativeStateError(
        'invalid_state',
        'Batch commits only to the graph it was opened on'
      )
    for (const id of this.nodes.deletes) {
      text.replace(id, nodes.get(id)?.element, undefined)
      nodes.delete(id)
    }
    for (const [id, candidate] of this.nodes.writes) {
      const current = nodes.get(id)
      // Native input can arrive while an unrelated batch is in flight. Preserve
      // every newer edit instead of replacing it with a cloned candidate value.
      if (
        current &&
        current.inputRevision > candidate.inputRevision &&
        current.element.kind === 'input' &&
        candidate.element.kind === 'input'
      ) {
        candidate.inputRevision = current.inputRevision
        candidate.element = { ...candidate.element, value: current.element.value }
      }
      text.replace(id, current?.element, candidate.element)
      nodes.set(id, candidate)
    }
  }
}
