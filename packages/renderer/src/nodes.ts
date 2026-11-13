import {
  NativeStateError,
  UnsupportedFeatureError,
  type DropTargetEvent,
  type Element,
  type InputState,
  type NativeBatch,
  type NativeDropTarget,
  type NativeNode,
  type Style,
} from '@bun-native/core'
import { captureInput, type InputIntent } from './input-intent.ts'
import {
  isEventProperty,
  listeners,
  type EventListener,
  type EventListeners,
} from './event-properties.ts'

declare const identity: unique symbol

/** An adapter-owned JSX reference, not a DOM node or a native handle. */
export interface RendererNode {
  readonly [identity]: true
}

export interface Owner {
  readonly token: object
  /**
   * A handler property keeps its native registration while it stays defined:
   * the registration calls the property's current value. Otherwise replacing
   * a handler revokes the old registration once the replacement commits.
   */
  readonly stableHandlers: boolean
  changed(): void
  detached(node: Node): void
  input(node: Node): InputState
  /** Commit staged changes, then send one request batch for the committed handle. */
  request(node: Node, send: (batch: NativeBatch, handle: NativeNode) => void): Promise<void>
  registerDropTarget(
    node: Node,
    listener: (event: DropTargetEvent) => void | Promise<void>
  ): Promise<NativeDropTarget>
}

type Properties = EventListeners & {
  style?: Style
  text?: string
  value?: string | InputIntent
  placeholder?: string
  disabled?: boolean
  ratio?: number
  min_size?: number
  anchor?: 'window' | 'parent'
  modal?: boolean
  autofocus?: boolean
  navigation?: 'tab' | 'menu'
  surface?: 'layer' | 'window'
  readOnly?: boolean
  accessibleLabel?: string
  accessibleRole?: 'list' | 'list_item'
  accessibleSetSize?: number
  accessiblePosition?: number
  accessibleSelected?: boolean
  accessibleLive?: 'polite' | 'assertive'
}

/** Every native element tag the renderer accepts. */
export type ElementTag = Element['kind']

/** Every property name `setProperty` accepts: element props and event handlers. */
export type PropertyName = keyof Properties

const isContainer = (kind: Node['kind']) => kind === 'box' || kind === 'split' || kind === 'overlay'

const nodes = new WeakSet<object>()

export class Node implements RendererNode {
  declare readonly [identity]: true
  /**
   * Staged children, where a detached child leaves an `undefined` hole until
   * the list is next read: removing a child from a wide list then neither
   * searches nor shifts it. Positions in this list are the `index` hints.
   */
  readonly staged: (Node | undefined)[] = []
  /** Holes in `staged`, the first and last of them. */
  holes = 0
  firstHole = 0
  lastHole = 0
  /** Read-only to adapters: setProperty validates, stores and invalidates captures. */
  readonly properties: Readonly<Properties> = {}
  parent: Node | undefined
  owner: Owner | undefined
  scope: object | undefined
  data = ''
  /** Last immutable capture; cleared by every mutation that can change it. */
  captured: Snapshot | undefined
  /**
   * This node or a staged descendant lacks a current capture. Every dirty node
   * in a tree has dirty ancestors, so snapshot() walks only dirty paths.
   */
  dirty = false
  /**
   * Dirty children registered when they became dirty, so a parent whose own
   * capture is current visits only them. A recaptured parent scans all of its
   * children instead, which covers a child that arrived already dirty.
   */
  dirtyChildren: Set<Node> | undefined
  /** Position hint in the parent's children; trusted only once verified. */
  index = 0
  /** Children before this position have current `index` hints. */
  indexed = 0

  constructor(readonly kind: Element['kind'] | 'text-node') {
    nodes.add(this)
  }

  /** The staged children in order; adapters may truncate this list directly. */
  get children(): Node[] {
    if (this.holes) compact(this)
    return this.staged as Node[]
  }
}

export function asNode(value: RendererNode): Node {
  if (!value || typeof value !== 'object' || !nodes.has(value))
    throw new NativeStateError('invalid_handle', 'Expected an owned staged native node')
  return value as Node
}

export function createElement(tag: ElementTag): Node {
  if (
    tag !== 'box' &&
    tag !== 'text' &&
    tag !== 'button' &&
    tag !== 'input' &&
    tag !== 'split' &&
    tag !== 'overlay'
  )
    throw new UnsupportedFeatureError('native-element:' + tag)
  return new Node(tag)
}

export function createTextNode(value: string): Node {
  const node = new Node('text-node')
  node.data = String(value)
  return node
}

/** Discard a cached capture after changing this node's own snapshot inputs. */
export function invalidate(node: Node | undefined): void {
  if (!node) return
  node.captured = undefined
  // An already dirty ancestor's own ancestors are dirty too.
  for (let path: Node | undefined = node; path && !path.dirty; path = path.parent) {
    path.dirty = true
    if (path.parent) (path.parent.dirtyChildren ??= new Set()).add(path)
  }
}

/** Gap of unverified siblings worth re-indexing to extend the valid prefix. */
const reindexLimit = 64

/**
 * A child's position in its parent's `staged` list. Hints are verified before
 * use, so a list an adapter truncated directly stays correct. A removal leaves
 * every hint valid and an insertion only shortens the valid prefix to its
 * position, so regions edited in order are found without a search.
 */
function childIndex(parent: Node, child: Node): number {
  const list = parent.staged
  const hint = child.index
  if (list[hint] === child) return hint
  const last = list.length - 1
  if (list[last] === child) return (child.index = last)
  const start = Math.min(parent.indexed, list.length)
  let found = list.indexOf(child, start)
  if (found < 0) found = list.indexOf(child)
  else if (found - start <= reindexLimit) {
    for (let index = start; index < found; index += 1) {
      const sibling = list[index]
      if (sibling) sibling.index = index
    }
    parent.indexed = found + 1
  }
  if (found >= 0) child.index = found
  return found
}

function contiguousHoles(parent: Node): boolean {
  return parent.lastHole - parent.firstHole + 1 === parent.holes
}

/** Drop the holes in one pass, or one native splice when they are adjacent. */
function compact(parent: Node): void {
  const list = parent.staged
  const first = parent.firstHole
  const adjacent = contiguousHoles(parent)
  if (adjacent) list.splice(first, parent.holes)
  else {
    let write = first
    for (let read = first; read < list.length; read += 1) {
      const child = list[read]
      if (!child) continue
      child.index = write
      list[write++] = child
    }
    list.length = write
  }
  // Hints from the first hole on moved, unless the pass above rewrote them.
  if (parent.indexed >= first) parent.indexed = adjacent ? first : list.length
  parent.holes = 0
}

function detachChild(parent: Node, child: Node): void {
  parent.dirtyChildren?.delete(child)
  const list = parent.staged
  const index = childIndex(parent, child)
  if (index < 0) return
  // Shifting the remaining siblings would cost O(children) per removal.
  // Never shift(): JavaScriptCore then keeps the list in a much slower mode.
  if (index === list.length - 1) {
    list.pop()
    if (index < parent.indexed) parent.indexed = index
    return
  }
  list[index] = undefined
  if (!parent.holes) parent.firstHole = parent.lastHole = index
  else if (index < parent.firstHole) parent.firstHole = index
  else if (index > parent.lastHole) parent.lastHole = index
  parent.holes += 1
  // Bound the holes of a list that is edited but never read, such as one
  // outside a render root; compacting at half keeps removals amortized O(1).
  if (parent.holes * 2 > list.length) compact(parent)
}

function attachChild(parent: Node, child: Node, index: number): void {
  const list = parent.staged
  if (index === list.length) list.push(child)
  else list.splice(index, 0, child)
  if (parent.holes) {
    if (index <= parent.firstHole) parent.firstHole += 1
    if (index <= parent.lastHole) parent.lastHole += 1
  }
  if (index < parent.indexed) parent.indexed = index
  child.index = index
  if (parent.indexed === index) parent.indexed = index + 1
}

/** The first staged child, without compacting a run of leading holes. */
export function firstChild(node: Node): Node | undefined {
  if (node.holes && node.firstHole === 0 && contiguousHoles(node))
    return node.staged[node.lastHole + 1]
  return node.children[0]
}

/** The staged sibling after `node`, for adapters that walk sibling chains. */
export function nextSibling(node: Node): Node | undefined {
  const parent = node.parent
  if (!parent) return undefined
  const list = parent.staged
  let index = childIndex(parent, node) + 1
  if (parent.holes && index === parent.firstHole && contiguousHoles(parent))
    index = parent.lastHole + 1
  const start = index
  while (index < list.length && !list[index]) index += 1
  const sibling = list[index]
  if (index - start > reindexLimit) compact(parent)
  return sibling
}

export function visit(node: Node, fn: (node: Node) => void): void {
  fn(node)
  for (const child of node.children) visit(child, fn)
}

function checkScope(node: Node, token: object): void {
  if (node.scope && node.scope !== token)
    throw new NativeStateError('invalid_handle', 'Renderer nodes cannot move between render roots')
  for (const child of node.children) checkScope(child, token)
}

/**
 * Invalidate a subtree whose parent was just invalidated and hand it to
 * `owner`, giving each node the owner's scope. Each node's parent already lacks
 * a capture, so `snapshot()` scans all of its children and no node registers
 * with its parent's `dirtyChildren`, which only a current capture reads.
 */
function adopt(node: Node, owner: Owner | undefined): void {
  node.captured = undefined
  node.dirty = true
  node.owner = owner
  if (owner) node.scope = owner.token
  for (const child of node.children) adopt(child, owner)
}

export function insertNode(parent: Node, node: Node, anchor?: Node): void {
  if (parent.kind === 'input' || parent.kind === 'text-node')
    throw new NativeStateError('invalid_state', 'This native element cannot have children')
  if (!isContainer(parent.kind) && node.kind !== 'text-node')
    throw new NativeStateError('invalid_state', 'Text and button children must be text')
  if (anchor && anchor.parent !== parent)
    throw new NativeStateError('invalid_handle', 'Insertion anchor belongs to another parent')
  if (anchor === node) return
  for (let ancestor: Node | undefined = parent; ancestor; ancestor = ancestor.parent)
    if (ancestor === node) throw new NativeStateError('invalid_state', 'Native tree cycle')
  const owner = parent.owner
  // Every node an owner holds was given its scope with it (see adopt), so a
  // subtree already owned by this root needs no check.
  if (owner && node.owner !== owner) checkScope(node, owner.token)
  const previousOwner = node.owner
  // An owner only holds nodes attached under its root (removal and disposal
  // clear it), so this subtree moves without ever leaving the live tree.
  const moved = owner !== undefined && previousOwner === owner && node.parent !== undefined
  if (previousOwner && previousOwner !== owner) previousOwner.detached(node)
  if (node.parent) detachChild(node.parent, node)
  invalidate(node.parent)
  invalidate(parent)
  node.parent = parent
  attachChild(parent, node, anchor ? childIndex(parent, anchor) : parent.staged.length)
  // Adapters may clear detached nodes directly, so a reinserted subtree is
  // always captured again from its current state. A moved subtree's captures
  // and dirty paths stay current below it: its root's capture names the old
  // parent, so snapshot() recaptures that node alone, and the diff moves it
  // natively while every descendant keeps its committed record.
  if (!moved) adopt(node, owner)
  previousOwner?.changed()
  owner?.changed()
}

export function removeNode(parent: Node, node: Node): void {
  if (node.parent !== parent)
    throw new NativeStateError('invalid_handle', 'Removal target belongs to another parent')
  const owner = parent.owner
  owner?.detached(node)
  detachChild(parent, node)
  invalidate(parent)
  node.parent = undefined
  // A detached capture would otherwise retain listeners an adapter releases.
  adopt(node, undefined)
  owner?.changed()
}

export function replaceText(node: Node, value: string): void {
  if (node.kind !== 'text-node')
    throw new NativeStateError('invalid_state', 'Text replacement requires a text node')
  if (node.data === value) return
  node.data = value
  invalidate(node)
  // Text and button elements join their text-node children.
  invalidate(node.parent)
  node.owner?.changed()
}

export function setProperty(node: Node, name: PropertyName, value: unknown): void {
  const props = node.properties as Properties
  if (isEventProperty(name)) {
    if (node.kind === 'text-node')
      throw new TypeError('Text literals cannot own native event handlers')
    const replaced = props[name] !== undefined
    if (value === undefined) delete props[name]
    else if (typeof value === 'function') props[name] = value as EventListener
    else throw new TypeError(`Native ${name} must be a function`)
    // Only a defined/undefined change reaches a stable registration.
    if (replaced && value !== undefined && node.owner?.stableHandlers) return
    invalidate(node)
    node.owner?.changed()
    return
  }
  switch (name) {
    case 'style':
      if (value === undefined) delete props.style
      else if (value && typeof value === 'object' && !Array.isArray(value))
        props.style = { ...value }
      else throw new TypeError('Native style must be an object')
      break
    case 'text':
      if (node.kind !== 'text' && node.kind !== 'button')
        throw new TypeError('Only text and button elements accept text')
      if (value === undefined) delete props.text
      else if (typeof value === 'string') props.text = value
      else throw new TypeError('Native text must be a string')
      break
    case 'value': {
      if (node.kind !== 'input') throw new TypeError('Only inputs accept value')
      const captured = captureInput(value)
      if (captured === undefined) delete props.value
      else props.value = captured
      break
    }
    case 'placeholder':
      if (node.kind !== 'input') throw new TypeError('Only inputs accept placeholder')
      if (value === undefined) delete props.placeholder
      else if (typeof value === 'string') props.placeholder = value
      else throw new TypeError('Native input placeholder must be a string')
      break
    case 'disabled':
      if (node.kind !== 'button' && node.kind !== 'input')
        throw new TypeError('Only buttons and inputs accept disabled')
      if (value === undefined) delete props.disabled
      else if (typeof value === 'boolean') props.disabled = value
      else throw new TypeError('Native disabled must be boolean')
      break
    case 'ratio':
    case 'min_size':
      if (node.kind !== 'split') throw new TypeError('Only splits accept ' + name)
      if (value === undefined) delete props[name]
      else if (typeof value === 'number') props[name] = value
      else throw new TypeError(`Native split ${name} must be a number`)
      break
    case 'anchor':
      if (node.kind !== 'overlay') throw new TypeError('Only overlays accept anchor')
      if (value === undefined) delete props.anchor
      else if (value === 'window' || value === 'parent') props.anchor = value
      else throw new TypeError('Native overlay anchor must be window or parent')
      break
    case 'modal':
      if (node.kind !== 'overlay') throw new TypeError('Only overlays accept modal')
      if (value === undefined) delete props.modal
      else if (typeof value === 'boolean') props.modal = value
      else throw new TypeError('Native modal must be boolean')
      break
    case 'autofocus':
      if (node.kind !== 'overlay') throw new TypeError('Only overlays accept autofocus')
      if (value === undefined) delete props.autofocus
      else if (typeof value === 'boolean') props.autofocus = value
      else throw new TypeError('Native autofocus must be boolean')
      break
    case 'navigation':
      if (node.kind !== 'overlay') throw new TypeError('Only overlays accept navigation')
      if (value === undefined) delete props.navigation
      else if (value === 'tab' || value === 'menu') props.navigation = value
      else throw new TypeError('Native overlay navigation must be tab or menu')
      break
    case 'surface':
      if (node.kind !== 'overlay') throw new TypeError('Only overlays accept surface')
      if (value === undefined) delete props.surface
      else if (value === 'layer' || value === 'window') props.surface = value
      else throw new TypeError('Native overlay surface must be layer or window')
      break
    case 'accessibleLabel':
      if (node.kind !== 'split' && node.kind !== 'overlay' && node.kind !== 'box')
        throw new TypeError('Only boxes, splits and overlays accept accessibleLabel')
      if (value === undefined) delete props.accessibleLabel
      else if (typeof value === 'string') props.accessibleLabel = value
      else throw new TypeError('Native accessibleLabel must be a string')
      break
    case 'accessibleRole':
      if (node.kind !== 'box') throw new TypeError('Only boxes accept accessibleRole')
      if (value === undefined) delete props.accessibleRole
      else if (value === 'list' || value === 'list_item') props.accessibleRole = value
      else throw new TypeError('Native accessibleRole must be list or list_item')
      break
    case 'accessibleSetSize':
    case 'accessiblePosition':
      if (node.kind !== 'box') throw new TypeError('Only boxes accept ' + name)
      if (value === undefined) delete props[name]
      else if (typeof value === 'number' && Number.isSafeInteger(value)) props[name] = value
      else throw new TypeError(`Native ${name} must be an integer`)
      break
    case 'accessibleSelected':
      if (node.kind !== 'box') throw new TypeError('Only boxes accept accessibleSelected')
      if (value === undefined) delete props.accessibleSelected
      else if (typeof value === 'boolean') props.accessibleSelected = value
      else throw new TypeError('Native accessibleSelected must be boolean')
      break
    case 'accessibleLive':
      if (node.kind !== 'text') throw new TypeError('Only text accepts accessibleLive')
      if (value === undefined) delete props.accessibleLive
      else if (value === 'polite' || value === 'assertive') props.accessibleLive = value
      else throw new TypeError('Native accessibleLive must be polite or assertive')
      break
    case 'readOnly':
      if (node.kind !== 'input') throw new TypeError('Only inputs accept readOnly')
      if (value === undefined) delete props.readOnly
      else if (typeof value === 'boolean') props.readOnly = value
      else throw new TypeError('Native readOnly must be boolean')
      break
    default:
      throw new UnsupportedFeatureError('native-property:' + name)
  }
  invalidate(node)
  node.owner?.changed()
}

/** Immutable once captured: unchanged nodes share it across commits. */
export type Snapshot = Readonly<{
  element: Element
  children: readonly Node[]
  parent: Node | undefined
  events: Readonly<EventListeners>
  initialValue: string | undefined
  inputIntent: InputIntent | undefined
}>

type LeafStyle = NonNullable<Extract<Element, { kind: 'text' }>['style']>

function leafStyle(style: Style): LeafStyle {
  // The stored style is the renderer's own copy and is replaced, never
  // mutated, so a style without scrolling members is shared as it is.
  if (!('overflow' in style) && !('scroll_anchor' in style)) return style as LeafStyle
  const { overflow, scroll_anchor, ...rest } = style
  if (
    scroll_anchor !== undefined ||
    (overflow !== undefined && overflow !== 'visible' && overflow !== 'hidden')
  )
    throw new TypeError('Only native boxes and overlays support scrolling')
  return { ...rest, ...(overflow === undefined ? {} : { overflow }) }
}

/**
 * Capture values before awaiting the core queue; later effects form another batch.
 *
 * Returns only nodes captured anew: every other staged node keeps the immutable
 * capture its acknowledged committed record already holds. The walk descends
 * only dirty paths, so a clean subtree costs nothing. A node can leave its
 * committed position only through a mutation that invalidates its old parent
 * and leaves its own capture naming another parent (or none), so the diff
 * finds removals and moves from the old and new child lists of recaptured
 * nodes alone.
 */
export function snapshot(root: Node): Map<Node, Snapshot> {
  const result = new Map<Node, Snapshot>()
  const current = (node: Node, parent: Node | undefined): boolean =>
    !node.dirty && node.captured !== undefined && node.captured.parent === parent
  const capture = (node: Node, parent: Node | undefined): void => {
    node.dirty = false
    const dirty = node.dirtyChildren
    node.dirtyChildren = undefined
    let captured = node.captured
    if (!captured || captured.parent !== parent) {
      captured = build(node, parent)
      node.captured = captured
      result.set(node, captured)
    } else if (dirty && dirty.size * 8 < captured.children.length) {
      // A current capture's children are this node's children, and each one
      // that became dirty registered itself, so only those are visited, in
      // child order: the diff emits native operations in snapshot order.
      for (const child of inChildOrder(node, dirty)) if (!current(child, node)) capture(child, node)
      return
    }
    for (const child of captured.children) if (!current(child, node)) capture(child, node)
  }
  if (!current(root, undefined)) capture(root, undefined)
  return result
}

/** Registered children still under `parent`, in staged child order. */
function inChildOrder(parent: Node, children: ReadonlySet<Node>): Node[] {
  const positioned: [number, Node][] = []
  for (const child of children)
    if (child.parent === parent) positioned.push([childIndex(parent, child), child])
  if (positioned.length > 1) positioned.sort((left, right) => left[0] - right[0])
  return positioned.map((entry) => entry[1])
}

/**
 * The staged children as an immutable list, sharing the previous capture's
 * list when they are unchanged (a moved node), so the diff skips it by identity.
 */
function childList(node: Node): readonly Node[] {
  const children = node.children
  const previous = node.captured?.children
  if (
    previous?.length === children.length &&
    previous.every((child, index) => child === children[index])
  )
    return previous
  return [...children]
}

function build(node: Node, parent: Node | undefined): Snapshot {
  const props = node.properties
  const style = props.style && !isContainer(node.kind) ? { style: leafStyle(props.style) } : {}
  let element: Element
  if (node.kind === 'box')
    // Core validation rejects members that do not fit the role.
    element = {
      kind: 'box',
      ...(props.accessibleRole === undefined ? {} : { accessible_role: props.accessibleRole }),
      ...(props.accessibleLabel === undefined ? {} : { accessible_label: props.accessibleLabel }),
      ...(props.accessibleSetSize === undefined
        ? {}
        : { accessible_set_size: props.accessibleSetSize }),
      ...(props.accessiblePosition === undefined
        ? {}
        : { accessible_position: props.accessiblePosition }),
      ...(props.accessibleSelected === undefined
        ? {}
        : { accessible_selected: props.accessibleSelected }),
      ...(props.style ? { style: props.style } : {}),
    } as Element
  else if (node.kind === 'split')
    // Core validation rejects gap and alignment on a split.
    element = {
      kind: 'split',
      ...(props.ratio === undefined ? {} : { ratio: props.ratio }),
      ...(props.min_size === undefined ? {} : { min_size: props.min_size }),
      ...(props.accessibleLabel === undefined ? {} : { accessible_label: props.accessibleLabel }),
      ...(props.style ? { style: leafStyle(props.style) } : {}),
    }
  else if (node.kind === 'overlay')
    // Core validation rejects a modal parent-anchored overlay and an
    // unsized or window-anchored popup surface.
    element = {
      kind: 'overlay',
      ...(props.anchor === undefined ? {} : { anchor: props.anchor }),
      ...(props.modal === undefined ? {} : { modal: props.modal }),
      ...(props.autofocus === undefined ? {} : { autofocus: props.autofocus }),
      ...(props.navigation === undefined ? {} : { navigation: props.navigation }),
      ...(props.surface === undefined ? {} : { surface: props.surface }),
      ...(props.accessibleLabel === undefined ? {} : { accessible_label: props.accessibleLabel }),
      ...(props.style ? { style: props.style } : {}),
    } as Element
  else if (node.kind === 'input')
    element = {
      kind: 'input',
      value: typeof props.value === 'string' ? props.value : (props.value?.value ?? ''),
      ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
      ...(props.disabled ? { disabled: true } : {}),
      ...(props.readOnly ? { read_only: true } : {}),
      ...style,
    }
  else {
    if (props.text !== undefined && node.children.length)
      throw new TypeError('Choose text properties or text children, not both')
    // Joined text-node children are part of this capture, not native nodes.
    for (const child of node.children) child.dirty = false
    const text =
      node.kind === 'text-node'
        ? node.data
        : (props.text ?? node.children.map((child) => child.data).join(''))
    element =
      node.kind === 'button'
        ? {
            kind: 'button',
            text,
            ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
            ...style,
          }
        : {
            kind: 'text',
            text,
            ...(props.accessibleLive === undefined
              ? {}
              : { accessible_live: props.accessibleLive }),
            ...style,
          }
  }
  return {
    element,
    children: isContainer(node.kind) ? childList(node) : [],
    parent,
    events: listeners(props),
    initialValue: typeof props.value === 'string' ? props.value : undefined,
    inputIntent: typeof props.value === 'object' ? props.value : undefined,
  }
}
