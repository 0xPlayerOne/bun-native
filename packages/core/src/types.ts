import type {
  Capability,
  DismissReason,
  ResizeSource,
  Element,
  KeyModifiers,
  Limits,
  PointerButton,
  Style,
} from '@bun-native/protocol'
import type { HostOptions } from '@bun-native/runtime'
import type {
  DisplayChangeEvent,
  NativeDisplaySnapshot,
  NativeClipboardText,
  ServiceCapabilities,
  ServiceRequestOptions,
} from './services.ts'
import type {
  GlobalShortcutEvent,
  GlobalShortcutOptions,
  NativeGlobalShortcut,
} from './shortcuts.ts'
import type { NativeNotification, NotificationEvent, NotificationOptions } from './notifications.ts'
import type { AppMenuItemEvent, MenuOptions, NativeMenuBar } from './app-menu.ts'
import type { FileGrantOptions, NativeFileGrant } from './files.ts'
import type { NativeProcess, ProcessEvent, ProcessOptions } from './processes.ts'
import type {
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult,
} from './dialogs.ts'
import type {
  ConfirmDialogOptions,
  MessageDialogOptions,
  MessageDialogResult,
} from './message-dialogs.ts'
import type { DropTargetEvent, NativeDropTarget } from './drops.ts'

export type { Element, KeyModifiers, PointerButton, Style }
export type ApplicationOptions = HostOptions
export type ElementKind = Element['kind']
/** Element kinds that own ordered children. */
export type ContainerKind = 'box' | 'split' | 'overlay'
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

/**
 * The host asks the application to close a popup window overlay, for example
 * because its parent window stopped being active. Nothing is removed natively
 * until a listener commits a batch.
 */
export interface DismissRequestEvent extends EventContext {
  readonly type: 'dismiss'
  readonly node: NativeNode<'overlay'>
  readonly reason: DismissReason
}

/**
 * Requires `split_resize_v1`. The user moved a split's divider: once after a
 * pointer drag that changed the ratio ends, and once per keyboard step that
 * changed it. `ratio` is the host-owned leading-pane share the window now
 * shows; declaring a different `ratio` later replaces it.
 */
export interface SplitResizeEvent extends EventContext<'split'> {
  readonly type: 'split_resize'
  readonly ratio: number
  readonly source: ResizeSource
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
  dismiss: DismissRequestEvent
  split_resize: SplitResizeEvent
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
  insert(parent: NativeNode<ContainerKind>, child: NativeNode, index: number): void
  append(parent: NativeNode<ContainerKind>, child: NativeNode): void
  /** Deletes the complete subtree; deleting a revoked node is an error. */
  remove(node: NativeNode): void
  /**
   * Requires `focus_v1`. Focus an enabled button or input after this batch's
   * tree changes commit, and scroll it into view. The target must still be
   * focusable in the committed tree and lie inside the active modal overlay.
   */
  focus(node: NativeNode<'button' | 'input'>): void
  /**
   * Requires `scroll_control_v1`. Set a scrolling container's offset from its
   * content start in logical pixels; an omitted axis keeps its offset. The
   * host clamps the offset to the laid-out maximum.
   */
  scrollTo(node: NativeNode<ContainerKind>, offset: ScrollOffset): void
  /**
   * Requires `scroll_control_v1`. Scroll every scrolling ancestor inside the
   * node's own layer so the ancestor's child on the node's route is visible.
   */
  scrollIntoView(node: NativeNode): void
}

export interface ScrollOffset {
  readonly x?: number
  readonly y?: number
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
  /** Requires an immutable launch grant; cancellation never publishes a late snapshot. */
  displaySnapshot(options?: ServiceRequestOptions): Promise<NativeDisplaySnapshot>
  /**
   * Reports when the window moves to another display or the OS reconfigures its
   * display, with the new snapshot. Requires the windowDisplay launch grant and
   * `serviceCapabilities.windowDisplay.changes` (macOS and Windows). Returns an
   * idempotent remover; window close and shutdown remove every listener.
   */
  onDisplayChange(listener: (event: DisplayChangeEvent) => void | Promise<void>): () => void
  /** Fixed native deadline; cancellation after dispatch drains but withholds the result. */
  readClipboardText(options?: ServiceRequestOptions): Promise<NativeClipboardText>
  /** A submitted write can change the OS clipboard even if ownership is subsequently revoked. */
  writeClipboardText(text: string): Promise<void>
  /**
   * OS-wide activation, delivered even while another window or application is
   * focused. Requires the immutable globalShortcuts launch grant. A combination
   * already held by another client fails with `conflict`; nothing is approximated.
   */
  registerGlobalShortcut(
    options: GlobalShortcutOptions,
    listener: (event: GlobalShortcutEvent) => void | Promise<void>
  ): Promise<NativeGlobalShortcut>
  /**
   * Post a plain-text desktop notification owned by this window. Requires the
   * immutable notifications launch grant. Withdrawal, window close and
   * shutdown close it on the server; the listener receives activations and a
   * final dismissal when the server removes it first.
   */
  postNotification(
    options: NotificationOptions,
    listener: (event: NotificationEvent) => void | Promise<void>
  ): Promise<NativeNotification>
  /**
   * Open a scoped grant on a directory the application named in its
   * immutable `filesystemRoots` launch permission. No run-time path, dropped
   * pathname or model text can create one. Closing the window revokes it.
   */
  openFileGrant(root: string, options?: FileGrantOptions): Promise<NativeFileGrant>
  /**
   * Start an owned child process from an executable the application named in
   * its immutable `processes` launch permission, by ID. Arguments and the
   * whole environment are explicit; a working directory comes only from a live
   * file grant of this window. Closing the window stops its process group.
   */
  spawnProcess(
    executable: string,
    options: ProcessOptions,
    listener: (event: ProcessEvent) => void | Promise<void>
  ): Promise<NativeProcess>
  /**
   * Show an OS file-open or folder dialog owned by this window. Requires the
   * immutable fileDialogs launch grant; at most one file dialog per window.
   * The returned paths are data, never a filesystem grant. Aborting the signal,
   * closing the window or shutting down closes the dialog.
   */
  showOpenDialog(
    options: OpenDialogOptions,
    request?: ServiceRequestOptions
  ): Promise<OpenDialogResult>
  /** Show an OS save dialog owned by this window. Nothing is written or created. */
  showSaveDialog(
    options: SaveDialogOptions,
    request?: ServiceRequestOptions
  ): Promise<SaveDialogResult>
  /**
   * Show a message dialog drawn by core as a window-anchored modal overlay
   * (not an OS alert), with focus on its default button and Tab trapped
   * inside it. No launch grant is needed; requires
   * `serviceCapabilities.messageDialogs`. Dialogs of one window are shown one
   * at a time in call order. The result is delivered after the layer is
   * removed. Aborting the signal rejects with `cancelled`; closing the window
   * or shutting down rejects with `invalid_handle`.
   */
  showMessageDialog(
    options: MessageDialogOptions,
    request?: ServiceRequestOptions
  ): Promise<MessageDialogResult>
  /** An OK/Cancel message dialog: true for OK; Cancel and Escape give false. */
  showConfirmDialog(
    options: ConfirmDialogOptions,
    request?: ServiceRequestOptions
  ): Promise<boolean>
  /**
   * Make a committed node an owned drop target for external file drags.
   * Requires the immutable dragDrop launch grant. Dropped items arrive as
   * untrusted display names; only `item.resolve(root)` maps one, through the
   * host, beneath a launch root. Removing the node, closing the target or
   * its window revokes it, and no later event is delivered.
   */
  registerDropTarget(
    node: NativeNode,
    listener: (event: DropTargetEvent) => void | Promise<void>
  ): Promise<NativeDropTarget>
  /** Idempotent. Revokes listeners before requesting native window removal. */
  close(): Promise<void>
}

export interface NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  readonly capabilities: readonly NativeCapability[]
  /** Implemented service features and their effective grants, not an OS sandbox. */
  readonly serviceCapabilities: Readonly<ServiceCapabilities>
  readonly diagnostics: Readonly<{
    windows: number
    nodes: number
    callbacks: number
    queuedTransactions: number
    queuedCallbacks: number
    activeCallbacks: number
    serviceRequests: number
  }>
  openWindow(options: WindowOptions): Promise<NativeWindow>
  /**
   * Installs the application menu bar, replacing (and revoking) the previous
   * one. Requires `serviceCapabilities.appMenu` and the `appMenu` grant.
   */
  setMenuBar(
    menus: readonly MenuOptions[],
    listener: (event: AppMenuItemEvent) => void | Promise<void>
  ): Promise<NativeMenuBar>
  /** Removes the application menu bar and revokes its items. */
  clearMenuBar(): Promise<void>
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
