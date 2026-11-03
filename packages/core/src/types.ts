import type {
  Capability,
  Element,
  KeyModifiers,
  Limits,
  PointerButton,
  Style,
} from '@bun-native/protocol'
import type { HostOptions } from '@bun-native/runtime'

export type { Element, KeyModifiers, PointerButton, Style }
export type ApplicationOptions = HostOptions
export type ElementKind = Element['kind']
export type NativeCapability = Capability
declare const nodeType: unique symbol

/** Opaque identity. Copying its properties does not create a usable handle. */
export interface NativeNode<K extends ElementKind = ElementKind> {
  readonly kind: K
  readonly [nodeType]: K
}

export interface EventContext<K extends ElementKind = ElementKind> {
  /** The native target. It does not change during propagation. */
  readonly node: NativeNode<K>
  readonly currentTarget: NativeNode
  /** Native committed ancestry captured at input, root first and target last. */
  readonly path: readonly NativeNode[]
  readonly phase: 'capture' | 'target' | 'bubble'
  readonly treeRevision: number
  readonly sequence: number
  /** Revoked when this particular registration is removed or replaced. */
  readonly signal: AbortSignal
  readonly propagationStopped: boolean
  /** Affects subsequent JavaScript listeners, not an already-performed native action. */
  stopPropagation(): void
  stopImmediatePropagation(): void
}

export interface ClickEvent extends EventContext<'button'> {
  readonly type: 'click'
}

export interface InputState {
  readonly value: string
  readonly revision: number
}

export interface InputEvent extends InputState, EventContext<'input'> {
  readonly type: 'input'
}

export interface KeyEvent<
  T extends 'key_down' | 'key_up' = 'key_down' | 'key_up',
> extends EventContext {
  readonly type: T
  readonly key: string
  /** GPUI logical text, when available; not a committed input/IME notification. */
  readonly keyChar?: string
  readonly modifiers: Readonly<KeyModifiers>
}

export interface PointerEvent<
  T extends 'pointer_down' | 'pointer_up' = 'pointer_down' | 'pointer_up',
> extends EventContext {
  readonly type: T
  readonly button: PointerButton
  /** Coordinates in logical pixels relative to the native window. */
  readonly x: number
  readonly y: number
  readonly modifiers: Readonly<KeyModifiers>
}

export interface FocusEvent<T extends 'focus' | 'blur' = 'focus' | 'blur'> extends EventContext {
  readonly type: T
}

export interface NativeEventMap {
  click: ClickEvent
  input: InputEvent
  key_down: KeyEvent<'key_down'>
  key_up: KeyEvent<'key_up'>
  pointer_down: PointerEvent<'pointer_down'>
  pointer_up: PointerEvent<'pointer_up'>
  focus: FocusEvent<'focus'>
  blur: FocusEvent<'blur'>
}

export type NativeEventType = keyof NativeEventMap
export type NativeUIEvent = NativeEventMap[NativeEventType]
export type Listener<T> = (event: T) => void | Promise<void>
export interface ListenerOptions {
  readonly capture?: boolean
}

export interface NativeBatch {
  create<E extends Element>(element: E): NativeNode<E['kind']>
  set(
    node: NativeNode<'input'>,
    element: Extract<Element, { kind: 'input' }>,
    expectedInputRevision: number
  ): void
  set<K extends Exclude<ElementKind, 'input'>>(
    node: NativeNode<K>,
    element: Extract<Element, { kind: NoInfer<K> }>
  ): void
  /** Index is evaluated after detaching the child from its previous parent. */
  insert(parent: NativeNode<'box'>, child: NativeNode, index: number): void
  append(parent: NativeNode<'box'>, child: NativeNode): void
  /** Deletes the complete subtree; deleting a revoked node is an error. */
  remove(node: NativeNode): void
}

export interface WindowOptions {
  title: string
  width?: number
  height?: number
}

export interface NativeWindow {
  readonly root: NativeNode<'box'>
  readonly closed: Promise<void>
  readonly revision: number
  /** The callback is synchronous. Its changes commit atomically after acknowledgement. */
  batch<T>(
    update: (batch: NativeBatch) => T & (T extends PromiseLike<unknown> ? never : unknown)
  ): Promise<T>
  /** One registration per node/type/phase. Replacement revokes its predecessor. */
  on<T extends NativeEventType>(
    node: NativeNode,
    type: T,
    listener: Listener<NativeEventMap[T]>,
    options?: ListenerOptions
  ): () => void
  onClick(node: NativeNode<'button'>, listener: Listener<ClickEvent>): () => void
  onInput(node: NativeNode<'input'>, listener: Listener<InputEvent>): () => void
  input(node: NativeNode<'input'>): InputState
  /** Idempotent. Revokes listeners before requesting native window removal. */
  close(): Promise<void>
}

export interface NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  readonly capabilities: readonly NativeCapability[]
  readonly diagnostics: Readonly<{
    windows: number
    nodes: number
    callbacks: number
    queuedTransactions: number
    queuedCallbacks: number
    activeCallbacks: number
  }>
  openWindow(options: WindowOptions): Promise<NativeWindow>
  /** May be called from a listener. Await closed outside that listener to join dispatch. */
  shutdown(): Promise<void>
}

export class NativeStateError extends Error {
  override readonly name = 'NativeStateError'
  constructor(
    readonly code: 'invalid_handle' | 'invalid_state' | 'stale_revision' | 'limit_exceeded',
    message: string
  ) {
    super(message)
  }
}

export class UnsupportedFeatureError extends Error {
  override readonly name = 'UnsupportedFeatureError'
  constructor(readonly feature: string) {
    super('Unsupported native feature: ' + feature)
  }
}
