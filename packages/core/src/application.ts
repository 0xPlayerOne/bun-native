import {
  parseRootId,
  ProtocolError,
  type ApplicationEvent,
  type Capability,
  type FileDialogOptions,
  type HostEvent,
  type Limits,
  type Operation,
  type WindowEvent,
} from '@bun-native/protocol'
import {
  NativeCommandError,
  NativeHost,
  type HostOptions,
  type WindowCommand,
} from '@bun-native/runtime'
import { planStagedCommit, sendStagedCommit } from './commit-plan.ts'
import { dispatchPlan, EventBindings, prunePlan, type DispatchPlan } from './events.ts'
import { DisplaySubscription } from './display.ts'
import {
  checkServiceCancellation,
  NativeServiceError,
  publicDisplaySnapshot,
  serviceCapabilities,
  serviceSignal,
  type DisplayChangeEvent,
  type NativeDisplaySnapshot,
  type NativeClipboardText,
  type ServiceCapabilities,
  type ServiceRequestOptions,
} from './services.ts'
import {
  shortcutRequest,
  ShortcutRegistration,
  type GlobalShortcutEvent,
  type GlobalShortcutOptions,
  type NativeGlobalShortcut,
} from './shortcuts.ts'
import {
  notificationRequest,
  NotificationRegistration,
  type NativeNotification,
  type NotificationEvent,
  type NotificationOptions,
} from './notifications.ts'
import {
  menuBarRequest,
  MenuBarRegistration,
  type AppMenuItemEvent,
  type MenuEntryOptions,
  type MenuOptions,
  type NativeMenuBar,
} from './app-menu.ts'
import {
  contextMenuRequest,
  ContextMenuRequest,
  itemIds,
  type ContextMenuPosition,
} from './context-menus.ts'
import {
  DropTargetRegistration,
  type DropTargetEvent,
  type NativeDropTarget,
  type NativeDroppedItem,
} from './drops.ts'
import {
  fileGrantRequest,
  FileGrantRegistration,
  type FileCall,
  type FileGrantOptions,
  type NativeFileGrant,
} from './files.ts'
import {
  processRequest,
  ProcessRegistration,
  type NativeProcess,
  type ProcessCall,
  type ProcessEvent,
  type ProcessOptions,
} from './processes.ts'
import {
  FileDialogRequest,
  openDialogRequest,
  saveDialogRequest,
  type OpenDialogOptions,
  type OpenDialogResult,
  type SaveDialogOptions,
  type SaveDialogResult,
} from './dialogs.ts'
import {
  confirmDialogSpec,
  messageDialogSpec,
  MessageDialogs,
  type ConfirmDialogOptions,
  type NativeMessageDialogBackend,
  type MessageDialogOptions,
  type MessageDialogResult,
} from './message-dialogs.ts'
import { CommittedText, makeNode, own, Transaction, type NodeState } from './tree.ts'
import {
  NativeStateError,
  UnsupportedFeatureError,
  type ClickEvent,
  type InputEvent,
  type Listener,
  type ListenerOptions,
  type NativeEventMap,
  type NativeEventType,
  type NativeApplication,
  type NativeBatch,
  type NativeNode,
  type NativeWindow,
  type WindowOptions,
} from './types.ts'

const MAX_QUEUED_TRANSACTIONS = 128
const MAX_QUEUED_CALLBACKS = 128
/**
 * One queued application callback. `run` delivers it; `retain` decides, when
 * its window cancels callbacks, whether it stays queued. Without a window it
 * belongs to the application (the menu bar).
 */
interface Callback {
  readonly windowId?: number | undefined
  retain(): boolean
  run(): Promise<void>
}

/** A service registration whose listener receives its own events. */
interface Delivery<T> {
  readonly live: boolean
  readonly listener: Listener<T> | undefined
  readonly controller: AbortController
}

function listenerCallback<T>(
  windowId: number | undefined,
  registration: Delivery<T>,
  event: T
): Callback {
  return { windowId, retain: () => registration.live, run: () => deliver(registration, event) }
}

/** Monotonic identities of one kind: never reused, never wrapped. */
class Identities {
  next = 1
  constructor(private readonly kind: string) {}

  allocate(): number {
    if (!Number.isSafeInteger(this.next))
      throw new NativeStateError('limit_exceeded', this.kind + ' identity space exhausted')
    return this.next++
  }

  /** Whether `id` names an identity this space has already handed out. */
  has(id: number): boolean {
    return id < this.next
  }
}

class Application implements NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  // NativeHost.launch has negotiated every mandatory protocol feature.
  readonly capabilities: readonly Capability[]
  readonly serviceCapabilities: Readonly<ServiceCapabilities>
  readonly windows = new Map<number, Window>()
  readonly shortcuts = new Map<number, ShortcutRegistration>()
  readonly notifications = new Map<number, NotificationRegistration>()
  readonly fileGrants = new Map<number, FileGrantRegistration>()
  readonly processes = new Map<number, ProcessRegistration>()
  readonly dialogs = new Map<number, FileDialogRequest>()
  readonly contextMenus = new Map<number, ContextMenuRequest>()
  readonly dropTargets = new Map<number, DropTargetRegistration>()
  /** Every identity space this session allocates from. */
  readonly ids = {
    window: new Identities('Native window'),
    node: new Identities('Native node'),
    shortcut: new Identities('Global shortcut'),
    notification: new Identities('Notification'),
    fileGrant: new Identities('File grant'),
    process: new Identities('Process'),
    dialog: new Identities('File dialog'),
    contextMenu: new Identities('Context menu'),
    messageDialog: new Identities('Message dialog'),
    dropTarget: new Identities('Drop target'),
    menuBar: new Identities('Menu bar'),
  }
  private lastDrop = 0
  /** The installed (or installing) menu bar; replaced bars are revoked. */
  private menuBar: MenuBarRegistration | undefined
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
  private readonly services = new Set<Promise<void>>()
  private callbacks: Callback[] = []
  private dispatching: Promise<void> | undefined
  private activeCallbacks = 0
  /** Callbacks taken for dispatch; progress while ingestion is paused. */
  private dispatched = 0
  private stopping: Promise<void> | undefined
  private failure: Error | undefined
  private phase: 'running' | 'stopping' | 'closed' = 'running'

  constructor(readonly host: NativeHost) {
    this.limits = host.limits
    this.capabilities = host.capabilities
    this.serviceCapabilities = serviceCapabilities(host.servicePolicy, host.capabilities)
    this.closed = this.consume()
    // Keep background failures observable through closed/shutdown without an
    // unhandled rejection while the application is still installing listeners.
    void this.closed.catch(() => {})
  }

  get diagnostics() {
    let nodes = 0
    let callbacks = 0
    for (const window of this.windows.values()) {
      nodes += window.nodes.size
      callbacks += window.listeners.size + window.displayChanges.size
    }
    return Object.freeze({
      windows: this.windows.size,
      nodes,
      callbacks,
      queuedTransactions: this.queued,
      queuedCallbacks: this.callbacks.length,
      activeCallbacks: this.activeCallbacks,
      serviceRequests: this.services.size,
    })
  }

  cancelCallbacks(windowId: number): void {
    if (!this.callbacks.length) return
    this.callbacks = this.callbacks.filter(
      (callback) => callback.windowId !== windowId || callback.retain()
    )
  }

  queueCallback(callback: Callback): void {
    if (this.phase !== 'running') return
    if (this.callbacks.length >= MAX_QUEUED_CALLBACKS)
      throw new ProtocolError('Application callback queue limit exceeded')
    this.callbacks.push(callback)
    this.startDispatch()
  }

  /**
   * A burst can outpace dispatch while every listener is finishing. Over the
   * cap, ingestion pauses for macrotask turns while callbacks complete, and
   * fails only a turn in which none did: a stalled listener.
   */
  private async drainCallbacks(): Promise<void> {
    while (this.callbacks.length >= MAX_QUEUED_CALLBACKS) {
      const dispatched = this.dispatched
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (this.dispatched === dispatched)
        throw new ProtocolError('Application callback queue limit exceeded')
    }
  }

  /** Record the first failure and end the application with it. */
  async fail(cause: unknown): Promise<void> {
    this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
    await this.shutdown().catch(() => {})
  }

  private startDispatch(): void {
    if (!this.callbacks.length) return
    if (this.dispatching) return
    this.dispatching = this.dispatchCallbacks()
      .catch((cause) => this.fail(cause))
      .finally(() => {
        this.dispatching = undefined
        this.startDispatch()
      })
  }

  private async dispatchCallbacks(): Promise<void> {
    while (this.callbacks.length) {
      const callback = this.callbacks.shift()!
      this.dispatched += 1
      if (callback.windowId !== undefined && !this.windows.has(callback.windowId)) continue
      this.activeCallbacks = 1
      try {
        await callback.run()
      } finally {
        this.activeCallbacks = 0
      }
    }
  }

  enqueue<T>(operation: () => Promise<T>, closingWindow = false): Promise<T> {
    if (this.phase !== 'running')
      return Promise.reject(
        this.failure ?? new NativeStateError('invalid_state', 'Application is shutting down')
      )
    // At most one close per live window may use the reserved cleanup capacity.
    if (!closingWindow && this.queued >= MAX_QUEUED_TRANSACTIONS)
      return Promise.reject(
        new NativeStateError('limit_exceeded', 'Application transaction queue is full')
      )
    this.queued += 1
    const result = this.tail
      .then(() => {
        if (this.phase !== 'running')
          throw (
            this.failure ??
            new NativeStateError('invalid_state', 'Transaction cancelled during shutdown')
          )
        return operation()
      })
      .finally(() => {
        this.queued -= 1
      })
    this.tail = result.then(
      () => {},
      () => {}
    )
    return result
  }

  openWindow(options: WindowOptions): Promise<NativeWindow> {
    // Copy options at submission so later consumer mutation cannot change work.
    const requested = { ...options }
    return this.enqueue(async () => {
      if (this.windows.size >= this.limits.max_windows)
        throw new NativeStateError('limit_exceeded', 'Application window limit exceeded')
      const window = new Window(this, this.ids.window.allocate(), this.ids.node.allocate())
      this.windows.set(window.id, window)
      try {
        await this.host.send({
          type: 'open',
          window_id: window.id,
          root_id: window.rootId,
          title: requested.title,
          width: requested.width ?? 560,
          height: requested.height ?? 380,
        })
        window.assertActive()
        return window
      } catch (error) {
        window.revoke()
        throw error
      }
    })
  }

  // Clipboard transfers must not hold the shared tree commit queue. This
  // bounded set joins their results on shutdown while the transport continues
  // to route independent native acknowledgements and input.
  service<T>(operation: () => Promise<T>): Promise<T> {
    if (this.phase !== 'running')
      return Promise.reject(new NativeStateError('invalid_state', 'Application is shutting down'))
    if (this.services.size >= this.limits.max_service_requests)
      return Promise.reject(
        new NativeStateError('limit_exceeded', 'Native service request limit exceeded')
      )
    const result = Promise.resolve().then(() => {
      if (this.phase !== 'running')
        throw new NativeStateError('invalid_state', 'Service request cancelled during shutdown')
      return operation()
    })
    const settled = result
      .then(
        () => {},
        () => {}
      )
      .finally(() => this.services.delete(settled))
    this.services.add(settled)
    return result
  }

  /** Joins an operation at shutdown without consuming a new-request slot. */
  track(operation: Promise<void>): Promise<void> {
    const settled = operation
      .then(
        () => {},
        () => {}
      )
      .finally(() => this.services.delete(settled))
    this.services.add(settled)
    return operation
  }

  get running(): boolean {
    return this.phase === 'running'
  }

  async shutdown(): Promise<void> {
    if (!this.stopping) {
      this.phase = 'stopping'
      this.menuBar?.revoke()
      for (const window of this.windows.values()) window.revoke()
      this.stopping = (async () => {
        await this.tail
        await this.host.shutdown()
        await Promise.all(this.services)
      })()
    }
    await this.stopping
    if (this.failure) throw this.failure
  }

  async setMenuBar(
    menus: readonly MenuOptions[],
    listener: (event: AppMenuItemEvent) => void | Promise<void>
  ): Promise<NativeMenuBar> {
    const request = menuBarRequest(menus)
    if (typeof listener !== 'function')
      throw new TypeError('A menu bar listener must be a function')
    this.checkMenuBar()
    const registration = new MenuBarRegistration(this.ids.menuBar.allocate(), listener, (item) =>
      item === this.menuBar ? this.clearMenuBar() : Promise.resolve()
    )
    // Revoked at submission: no selection of the old bar is delivered after this call.
    this.menuBar?.revoke()
    this.menuBar = registration
    await this.sendMenuBar(registration.id, request)
    if (!registration.live)
      throw new NativeServiceError(
        'app_menu',
        'cancelled',
        'Menu bar was replaced or revoked while it was set'
      )
    return registration.handle
  }

  async clearMenuBar(): Promise<void> {
    this.checkMenuBar()
    const id = this.ids.menuBar.allocate()
    this.menuBar?.revoke()
    this.menuBar = undefined
    await this.sendMenuBar(id, [])
  }

  private checkMenuBar(): void {
    if (this.phase !== 'running')
      throw new NativeStateError('invalid_state', 'Application is shutting down')
    const capability = this.serviceCapabilities.appMenu
    if (capability.availability !== 'available')
      throw new NativeServiceError(
        'app_menu',
        'service_unavailable',
        'This native backend has no application menu bar'
      )
    if (capability.permission !== 'allow')
      throw new NativeServiceError(
        'app_menu',
        'permission_denied',
        'the application menu was not granted at native process launch'
      )
  }

  private async sendMenuBar(id: number, menus: ReturnType<typeof menuBarRequest>): Promise<void> {
    try {
      await this.service(() => this.host.send({ type: 'set_app_menu', menu_id: id, menus }))
    } catch (error) {
      if (this.menuBar?.id === id) {
        this.menuBar.revoke()
        this.menuBar = undefined
      }
      throw serviceError('app_menu', MENU_ERRORS, error)
    }
  }

  private receiveMenuItem(event: ApplicationEvent): void {
    if (!this.capabilities.includes('app_menu_v1'))
      throw new ProtocolError('Native menu selection arrived without app_menu_v1')
    if (!this.ids.menuBar.has(event.menu_id))
      throw new ProtocolError('Native event names an unallocated menu bar')
    const registration = this.menuBar
    // A replaced or cleared bar's selection is stale and never delivered.
    if (!registration?.live || registration.id !== event.menu_id) return
    this.queueCallback(
      listenerCallback(
        undefined,
        registration,
        Object.freeze({
          type: 'app_menu_item' as const,
          sequence: event.sequence,
          itemId: event.item_id,
          menuBar: registration.handle,
          signal: registration.controller.signal,
        })
      )
    )
  }

  /** The service identity a native event names, checked before routing. */
  private ownedIdentity(event: HostEvent): [Identities, number, string] | undefined {
    switch (event.type) {
      case 'global_shortcut':
        return [this.ids.shortcut, event.shortcut_id, 'global shortcut']
      case 'notification_activated':
      case 'notification_dismissed':
        return [this.ids.notification, event.notification_id, 'notification']
      case 'process_output':
      case 'process_exited':
        return [this.ids.process, event.process_id, 'process']
      case 'file_dialog_completed':
        return [this.ids.dialog, event.dialog_id, 'file dialog']
      case 'message_dialog_completed':
        return [this.ids.messageDialog, event.dialog_id, 'message dialog']
      case 'context_menu_completed':
        return [this.ids.contextMenu, event.menu_id, 'context menu']
      case 'drop_target_drag':
      case 'drop_received':
      case 'drop_rejected':
        return [this.ids.dropTarget, event.target_id, 'drop target']
      default:
        return undefined
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.host) {
        if (this.callbacks.length >= MAX_QUEUED_CALLBACKS) await this.drainCallbacks()
        if (event.type === 'app_menu_item') {
          this.receiveMenuItem(event)
          continue
        }
        const owned = this.ownedIdentity(event)
        if (owned && !owned[0].has(owned[1]))
          throw new ProtocolError('Native event names an unallocated ' + owned[2])
        if (event.type === 'drop_received') {
          if (event.drop_id <= this.lastDrop)
            throw new ProtocolError('Native drop identities must increase')
          this.lastDrop = event.drop_id
        }
        const window = this.windows.get(event.window_id)
        if (!window) {
          if (!this.ids.window.has(event.window_id))
            throw new ProtocolError('Native event names an unallocated window')
          continue // Revoked window: late events must not retain or invoke callbacks.
        }
        window.receive(event, this.ids.node.next)
      }
    } catch (cause) {
      this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
      this.phase = 'stopping'
      await this.host.shutdown().catch(() => {})
    } finally {
      this.menuBar?.revoke()
      for (const window of this.windows.values()) window.revoke()
      await this.dispatching
      await Promise.all(this.services)
      this.phase = 'closed'
    }
    if (this.failure) throw this.failure
  }
}

async function deliver<T>(registration: Delivery<T>, event: T): Promise<void> {
  const listener = registration.listener
  if (!listener || !registration.live) return
  await dispatchOwned(listener, event, registration.controller.signal)
}

async function dispatchNotification(
  registration: NotificationRegistration,
  event: NotificationEvent
): Promise<void> {
  const listener = registration.listener
  if (!listener) return
  try {
    await dispatchOwned(listener, event, registration.controller.signal)
  } finally {
    // The dismissal is the last delivery for its registration.
    if (event.type === 'notification_dismissed') registration.revoke()
  }
}

async function dispatchOwned<T>(
  listener: (event: T) => void | Promise<void>,
  event: T,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  let cancel!: () => void
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve
  })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    // Revocation releases an uncooperative listener without blocking ingestion.
    await Promise.race([listener(event), cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** A host-owned file dialog or context menu awaiting its result. */
interface PendingRequest {
  readonly id: number
  readonly windowId: number
  readonly live: boolean
  readonly result: Promise<unknown>
  fail(error: Error): void
}

/** A native command error with one of `codes` as `service`'s public error; any other error unchanged. */
function serviceError(
  service: NativeServiceError['service'],
  codes: ReadonlySet<string>,
  error: unknown
): unknown {
  return error instanceof NativeCommandError && codes.has(error.code)
    ? new NativeServiceError(service, error.code as NativeServiceError['code'], error.message)
    : error
}

// Native error codes each service reports as its own NativeServiceError.
const SERVICE = ['permission_denied', 'service_unavailable'] as const
const REQUEST = [...SERVICE, 'cancelled', 'native_failure', 'limit_exceeded'] as const
const DISPLAY_ERRORS: ReadonlySet<string> = new Set(SERVICE)
const MENU_ERRORS: ReadonlySet<string> = new Set(REQUEST)
const DIALOG_ERRORS: ReadonlySet<string> = new Set([...REQUEST, 'operation_timed_out'])
const NOTIFICATION_ERRORS = DIALOG_ERRORS
const SHORTCUT_ERRORS: ReadonlySet<string> = new Set([...DIALOG_ERRORS, 'conflict'])
const CLIPBOARD_ERRORS: ReadonlySet<string> = new Set([...DIALOG_ERRORS, 'payload_too_large'])
const PATH_ERRORS = [...REQUEST, 'not_found', 'path_denied'] as const
const DROP_ERRORS: ReadonlySet<string> = new Set([...PATH_ERRORS, 'conflict'])
const ACCESS_ERRORS = [...PATH_ERRORS, 'wrong_kind', 'access_denied'] as const
const PROCESS_ERRORS: ReadonlySet<string> = new Set([...ACCESS_ERRORS, 'invalid_state'])
const FILE_ERRORS: ReadonlySet<string> = new Set([...ACCESS_ERRORS, 'already_exists', 'not_empty'])

class Window implements NativeWindow {
  readonly root: NativeNode<'box'>
  readonly closed: Promise<void>
  readonly listeners: EventBindings
  // Replaced, never cleared, on close: an open batch still reads its own base.
  nodes = new Map<number, NodeState>()
  text: CommittedText
  revision = 0
  private active = true
  private resolveClosed!: () => void
  private closing: Promise<void> | undefined
  readonly displayChanges = new Set<DisplaySubscription>()
  private readonly messages = new MessageDialogs(this, () => this.nativeMessageDialogs())

  constructor(
    private readonly application: Application,
    readonly id: number,
    readonly rootId: number
  ) {
    const node = makeNode(rootId, { kind: 'box' })
    this.root = node.handle
    this.nodes.set(rootId, node)
    this.text = new CommittedText(application.limits.max_text_bytes, [node])
    this.listeners = new EventBindings(() => this.application.cancelCallbacks(this.id))
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
  }

  assertActive(): void {
    if (!this.active) throw new NativeStateError('invalid_handle', 'Window is closed')
  }

  batch<T>(update: (batch: NativeBatch) => T): Promise<T> {
    return this.application.enqueue(async () => {
      this.assertActive()
      const transaction = new Transaction(
        this.nodes,
        this.rootId,
        () => this.application.ids.node.allocate(),
        this.application.limits,
        this.application.capabilities,
        this.text
      )
      let value: T
      try {
        value = update(transaction)
        if (
          value !== null &&
          (typeof value === 'object' || typeof value === 'function') &&
          typeof (value as { then?: unknown }).then === 'function'
        ) {
          // Reject the async contract while consuming a later rejection from
          // the already-started callback. Its escaped transaction is revoked.
          void Promise.resolve(value).catch(() => {})
          throw new NativeStateError('invalid_state', 'Batch callbacks must be synchronous')
        }
        transaction.validate()
      } finally {
        transaction.finish()
      }
      if (!transaction.operations.length) return value
      const send = (operations: readonly Operation[]) =>
        this.application.host.send({
          type: 'batch',
          window_id: this.id,
          base_revision: this.revision,
          operations,
        })
      // Publish in the reply's own continuation, before any later native event.
      const publish = (revision: number) => {
        this.assertActive()
        transaction.commit(this.nodes, this.text)
        this.revision = revision
        this.listeners.forget(transaction.nodes.deletes)
        // The host revokes a target whose node a committed tree removed.
        for (const registration of this.application.dropTargets.values())
          if (registration.windowId === this.id && !this.nodes.has(registration.nodeId)) {
            registration.revoke()
            this.application.dropTargets.delete(registration.id)
          }
      }
      if (transaction.operations.length <= this.application.limits.max_operations) {
        publish((await send(transaction.operations)).tree_revision)
        return value
      }
      const plan = planStagedCommit(
        this.nodes,
        transaction,
        this.rootId,
        () => this.application.ids.node.allocate(),
        this.application.limits
      )
      await sendStagedCommit(plan, send, (reply, final) => {
        if (final) publish(reply.tree_revision)
        else {
          this.assertActive()
          // Staging changed only nodes this window has not committed.
          this.revision = reply.tree_revision
        }
      })
      return value
    })
  }

  on<T extends NativeEventType>(
    handle: NativeNode,
    type: T,
    listener: Listener<NativeEventMap[T]>,
    options?: ListenerOptions
  ): () => void {
    this.assertActive()
    const node = own(this.nodes, handle)
    if (type === 'split_resize' && !this.application.capabilities.includes('split_resize_v1'))
      throw new UnsupportedFeatureError('event:split_resize')
    return this.listeners.register(node.id, node.handle, type, listener, options)
  }

  onClick(handle: NativeNode<'button'>, listener: Listener<ClickEvent>): () => void {
    this.assertActive()
    const node = own(this.nodes, handle)
    if (node.element.kind !== 'button')
      throw new NativeStateError('invalid_state', 'Click listeners require a button and a function')
    return this.listeners.register(node.id, node.handle, 'click', listener)
  }

  onInput(handle: NativeNode<'input'>, listener: Listener<InputEvent>): () => void {
    this.assertActive()
    const node = own(this.nodes, handle)
    if (node.element.kind !== 'input')
      throw new NativeStateError('invalid_state', 'Input listeners require an input and a function')
    return this.listeners.register(node.id, node.handle, 'input', listener)
  }

  input(handle: NativeNode<'input'>) {
    this.assertActive()
    const node = own(this.nodes, handle)
    if (node.element.kind !== 'input')
      throw new NativeStateError('invalid_state', 'Only an input has an edit state')
    return Object.freeze({ value: node.element.value, revision: node.inputRevision })
  }

  async displaySnapshot(options: ServiceRequestOptions = {}): Promise<NativeDisplaySnapshot> {
    const signal = serviceSignal(options)
    this.assertActive()
    checkServiceCancellation(signal, 'window_display')
    return this.application.enqueue(async () => {
      this.assertActive()
      checkServiceCancellation(signal, 'window_display')
      try {
        const response = await this.application.host.send({
          type: 'display_snapshot',
          window_id: this.id,
        })
        const snapshot = publicDisplaySnapshot(response.snapshot, this.application.capabilities)
        // Cancellation and owner revocation suppress data after a submitted
        // read, while the transport still drains and validates its response.
        this.assertActive()
        checkServiceCancellation(signal, 'window_display')
        return snapshot
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        checkServiceCancellation(signal, 'window_display')
        throw serviceError('window_display', DISPLAY_ERRORS, error)
      }
    })
  }

  onDisplayChange(listener: (event: DisplayChangeEvent) => void | Promise<void>): () => void {
    this.assertActive()
    if (typeof listener !== 'function')
      throw new TypeError('Display change listener must be a function')
    if (this.application.serviceCapabilities.windowDisplay.changes !== 'available')
      throw new NativeServiceError(
        'window_display',
        'service_unavailable',
        'This native backend does not report display changes'
      )
    if (this.application.serviceCapabilities.windowDisplay.permission !== 'allow')
      throw new NativeServiceError(
        'window_display',
        'permission_denied',
        'window display access was not granted at native process launch'
      )
    const subscription = new DisplaySubscription(listener)
    this.displayChanges.add(subscription)
    return () => {
      subscription.revoke()
      if (this.displayChanges.delete(subscription)) this.application.cancelCallbacks(this.id)
    }
  }

  private receiveDisplayChange(event: Extract<WindowEvent, { type: 'display_changed' }>): void {
    if (!this.application.capabilities.includes('display_changes_v1'))
      throw new ProtocolError('Native display change arrived without display_changes_v1')
    // Validate even when nobody listens: a malformed frame is a host fault.
    const snapshot = publicDisplaySnapshot(event.snapshot, this.application.capabilities)
    if (!this.active) return
    for (const subscription of this.displayChanges) {
      const change: DisplayChangeEvent = Object.freeze({
        type: 'display_change',
        sequence: event.sequence,
        snapshot,
        signal: subscription.controller.signal,
      })
      this.application.queueCallback({
        windowId: this.id,
        retain: () => subscription.live,
        run: async () => {
          const listener = subscription.current
          if (listener) await dispatchOwned(listener, change, subscription.controller.signal)
        },
      })
    }
  }

  private revokeDisplayChanges(): void {
    for (const subscription of this.displayChanges) subscription.revoke()
    this.displayChanges.clear()
  }

  async readClipboardText(options: ServiceRequestOptions = {}): Promise<NativeClipboardText> {
    const signal = serviceSignal(options)
    return this.clipboard('clipboard_read', signal, async () => {
      const response = await this.application.host.send({
        type: 'clipboard_read',
        window_id: this.id,
      })
      return Object.freeze(response.result)
    })
  }

  writeClipboardText(text: string): Promise<void> {
    // Transport validation occurs before native I/O, including JS callers.
    return this.clipboard('clipboard_write', undefined, async () => {
      await this.application.host.send({ type: 'clipboard_write', window_id: this.id, text })
    })
  }

  private async clipboard<T>(
    service: 'clipboard_read' | 'clipboard_write',
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertActive()
    checkServiceCancellation(signal, service)
    return this.application.service(async () => {
      this.assertActive()
      checkServiceCancellation(signal, service)
      try {
        const result = await operation()
        this.assertActive()
        checkServiceCancellation(signal, service)
        return result
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        checkServiceCancellation(signal, service)
        throw serviceError(service, CLIPBOARD_ERRORS, error)
      }
    })
  }

  async registerGlobalShortcut(
    options: GlobalShortcutOptions,
    listener: (event: GlobalShortcutEvent) => void | Promise<void>
  ): Promise<NativeGlobalShortcut> {
    const { key, modifiers } = shortcutRequest(options)
    if (typeof listener !== 'function')
      throw new TypeError('A global shortcut listener must be a function')
    this.assertActive()
    return this.register(
      'global_shortcuts',
      SHORTCUT_ERRORS,
      this.application.shortcuts,
      () =>
        new ShortcutRegistration(
          this.application.ids.shortcut.allocate(),
          this.id,
          key,
          modifiers,
          listener,
          (item) => this.releaseShortcut(item)
        ),
      async (registration) => {
        await this.application.host.send({
          type: 'register_global_shortcut',
          window_id: this.id,
          shortcut_id: registration.id,
          key,
          modifiers,
        })
      },
      (registration) => registration.live,
      'Global shortcut was revoked during registration'
    )
  }

  private releaseShortcut(registration: ShortcutRegistration): Promise<void> {
    // Local revocation first: no activation is delivered after this call.
    registration.revoke()
    this.application.shortcuts.delete(registration.id)
    return this.releaseNative({
      type: 'unregister_global_shortcut',
      window_id: this.id,
      shortcut_id: registration.id,
    })
  }

  async postNotification(
    options: NotificationOptions,
    listener: (event: NotificationEvent) => void | Promise<void>
  ): Promise<NativeNotification> {
    const { title, body } = notificationRequest(options)
    if (typeof listener !== 'function')
      throw new TypeError('A notification listener must be a function')
    this.assertActive()
    return this.register(
      'notifications',
      NOTIFICATION_ERRORS,
      this.application.notifications,
      () =>
        new NotificationRegistration(
          this.application.ids.notification.allocate(),
          this.id,
          title,
          body,
          listener,
          (item) => this.withdrawNotification(item)
        ),
      async (registration) => {
        const posted = await this.application.host.send({
          type: 'post_notification',
          window_id: this.id,
          notification_id: registration.id,
          title,
          body,
        })
        registration.activatable = posted.activatable
      },
      (registration) => registration.deliverable,
      'Notification was revoked while it was posted'
    )
  }

  async openFileGrant(root: string, options: FileGrantOptions = {}): Promise<NativeFileGrant> {
    const request = fileGrantRequest(root, options)
    this.assertActive()
    return this.register(
      'filesystem_grants',
      FILE_ERRORS,
      this.application.fileGrants,
      () =>
        new FileGrantRegistration(
          this.application.ids.fileGrant.allocate(),
          this.id,
          request.root,
          request.access,
          (item, call) => this.fileCall(item, call),
          (item) => this.closeFileGrant(item)
        ),
      async (registration) => {
        await this.application.host.send({
          type: 'open_file_grant',
          window_id: this.id,
          grant_id: registration.id,
          root: request.root,
          access: request.access,
        })
      },
      (registration) => registration.live,
      'File grant was revoked while it opened'
    )
  }

  private fileCall(registration: FileGrantRegistration, call: FileCall): Promise<unknown> {
    const revoked = () =>
      new NativeServiceError(
        'filesystem_grants',
        'cancelled',
        'File grant is closed; no result is delivered'
      )
    if (!registration.live) return Promise.reject(revoked())
    this.assertActive()
    return this.application.service(async () => {
      this.assertActive()
      if (!registration.live) throw revoked()
      try {
        const response = await this.application.host.send({
          type: 'file_request',
          window_id: this.id,
          grant_id: registration.id,
          path: call.path,
          operation: call.operation,
        })
        // Revocation withholds a result the worker already produced.
        if (!registration.live) throw revoked()
        this.assertActive()
        return call.finish(response.result)
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        if (!registration.live) throw revoked()
        this.assertActive()
        throw this.serviceFailure('filesystem_grants', FILE_ERRORS, error)
      }
    })
  }

  private closeFileGrant(registration: FileGrantRegistration): Promise<void> {
    registration.revoke()
    this.application.fileGrants.delete(registration.id)
    return this.releaseNative({
      type: 'close_file_grant',
      window_id: this.id,
      grant_id: registration.id,
    })
  }

  async spawnProcess(
    executable: string,
    options: ProcessOptions,
    listener: (event: ProcessEvent) => void | Promise<void>
  ): Promise<NativeProcess> {
    const request = processRequest(executable, options)
    if (typeof listener !== 'function') throw new TypeError('A process listener must be a function')
    this.assertActive()
    let cwd: { grant_id: number; path: string } | undefined
    if (request.cwd) {
      const grant = [...this.application.fileGrants.values()].find(
        (registration) => registration.handle === request.cwd!.grant
      )
      if (!grant || grant.windowId !== this.id)
        throw new TypeError('Process cwd must name a live file grant owned by this window')
      cwd = { grant_id: grant.id, path: request.cwd.path }
    }
    return this.register(
      'processes',
      PROCESS_ERRORS,
      this.application.processes,
      () =>
        new ProcessRegistration(
          this.application.ids.process.allocate(),
          this.id,
          request.launch.executable,
          request.launch.terminal !== undefined,
          listener,
          (item, call) => this.processCall(item, call),
          (item) => this.releaseProcess(item)
        ),
      async (registration) => {
        await this.application.host.send({
          type: 'spawn_process',
          window_id: this.id,
          process_id: registration.id,
          launch: cwd ? { ...request.launch, cwd } : request.launch,
        })
      },
      (registration) => registration.live,
      'Process was released while it started'
    )
  }

  private processCall(registration: ProcessRegistration, call: ProcessCall): Promise<void> {
    const revoked = () => new NativeServiceError('processes', 'cancelled', 'Process is released')
    if (!registration.live) return Promise.reject(revoked())
    this.assertActive()
    return this.application.service(async () => {
      this.assertActive()
      if (!registration.live) throw revoked()
      try {
        await this.application.host.send({
          ...call,
          window_id: this.id,
          process_id: registration.id,
        })
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        if (!registration.live) throw revoked()
        this.assertActive()
        throw this.serviceFailure('processes', PROCESS_ERRORS, error)
      }
    })
  }

  private releaseProcess(registration: ProcessRegistration): Promise<void> {
    registration.revoke()
    this.application.processes.delete(registration.id)
    return this.releaseNative({
      type: 'release_process',
      window_id: this.id,
      process_id: registration.id,
    })
  }

  receiveProcess(event: Extract<WindowEvent, { type: 'process_output' | 'process_exited' }>): void {
    if (!this.active) return
    const registration = this.application.processes.get(event.process_id)
    if (!registration?.live) return // Released: the host may already have queued output.
    if (registration.windowId !== this.id)
      throw new ProtocolError('Native event names a process outside its owner')
    if (registration.ended) throw new ProtocolError('Native process event follows its exit')
    const common = {
      sequence: event.sequence,
      process: registration.handle,
      signal: registration.controller.signal,
    }
    if (event.type === 'process_output') {
      if (event.chunk !== registration.chunk + 1)
        throw new ProtocolError('Native process output chunk is out of order')
      if ((event.stream === 'terminal') !== registration.handle.terminal)
        throw new ProtocolError('Native process output names the wrong stream kind')
      registration.chunk = event.chunk
      const output: ProcessEvent = Object.freeze({
        type: 'process_output',
        stream: event.stream,
        bytes: Uint8Array.fromBase64(event.data),
        ...common,
      })
      const chunk = event.chunk
      this.application.queueCallback({
        windowId: this.id,
        retain: () => registration.live,
        run: () => this.dispatchProcess(registration, output, chunk),
      })
      return
    }
    registration.end()
    registration.exit = Object.freeze({ ...event.exit })
    const exited: ProcessEvent = Object.freeze({
      type: 'process_exited',
      exit: registration.exit,
      ...common,
    })
    this.application.queueCallback({
      windowId: this.id,
      retain: () => registration.live,
      run: () => this.dispatchProcess(registration, exited, 0),
    })
  }

  async dispatchProcess(
    registration: ProcessRegistration,
    event: ProcessEvent,
    chunk: number
  ): Promise<void> {
    const listener = registration.listener
    if (!listener || !registration.live) return
    await dispatchOwned(listener, event, registration.controller.signal)
    // The settled callback returns one delivery credit to the host.
    if (event.type !== 'process_output' || !registration.live) return
    if (!this.active || !this.application.running) return
    // A lost delivery credit stalls the stream, so a failed acknowledgement ends
    // the application with that error instead of an unhandled rejection.
    void this.application.track(
      this.application.host
        .send({
          type: 'acknowledge_process_output',
          window_id: this.id,
          process_id: registration.id,
          chunk,
        })
        .then(
          () => {},
          (error: unknown) => {
            // Release or window close can race the acknowledgement.
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            // Shutdown or a lost transport already owns the outcome, reported
            // through the application's closed promise; recording it here first
            // would hide the original cause. A rejection while the host still
            // runs (the runtime's own command limit) would otherwise lose the
            // credit silently.
            if (!this.application.running || !this.application.host.running) return
            // Not awaited: shutdown waits for this tracked operation.
            void this.application.fail(error)
          }
        )
    )
  }

  async registerDropTarget(
    handle: NativeNode,
    listener: (event: DropTargetEvent) => void | Promise<void>
  ): Promise<NativeDropTarget> {
    if (typeof listener !== 'function')
      throw new TypeError('A drop target listener must be a function')
    this.assertActive()
    const node = own(this.nodes, handle)
    return this.register(
      'drag_drop',
      DROP_ERRORS,
      this.application.dropTargets,
      () => {
        if (this.nodes.get(node.id)?.handle !== node.handle)
          throw new NativeStateError('invalid_handle', 'Drop target node was removed')
        return new DropTargetRegistration(
          this.application.ids.dropTarget.allocate(),
          this.id,
          node.id,
          node.handle,
          listener,
          (item) => this.releaseDropTarget(item)
        )
      },
      async (registration) => {
        try {
          await this.application.host.send({
            type: 'register_drop_target',
            window_id: this.id,
            target_id: registration.id,
            node_id: node.id,
          })
        } catch (error) {
          if (error instanceof NativeCommandError && error.code === 'invalid_handle' && this.active)
            throw new NativeStateError('invalid_handle', 'Drop target node is not committed')
          throw error
        }
      },
      (registration) => registration.live,
      'Drop target was revoked during registration'
    )
  }

  private dropError(error: unknown): unknown {
    return serviceError('drag_drop', DROP_ERRORS, error)
  }

  private releaseDropTarget(registration: DropTargetRegistration): Promise<void> {
    // Local revocation first: no drag or drop is delivered after this call.
    registration.revoke()
    this.application.dropTargets.delete(registration.id)
    return this.releaseNative({
      type: 'unregister_drop_target',
      window_id: this.id,
      target_id: registration.id,
    })
  }

  private resolveDroppedItem(
    registration: DropTargetRegistration,
    dropId: number,
    item: number,
    requested: string
  ): Promise<Readonly<{ root: string; path: string }>> {
    const stale = () =>
      new NativeServiceError(
        'drag_drop',
        'cancelled',
        'The drop was replaced or its target revoked; no result is delivered'
      )
    let root: string
    try {
      root = parseRootId(requested)
    } catch (error) {
      return Promise.reject(new TypeError((error as Error).message))
    }
    const live = () => registration.live && registration.latestDrop === dropId
    if (!live()) return Promise.reject(stale())
    this.assertActive()
    return this.application.service(async () => {
      this.assertActive()
      if (!live()) throw stale()
      try {
        const response = await this.application.host.send({
          type: 'resolve_dropped_item',
          window_id: this.id,
          target_id: registration.id,
          drop_id: dropId,
          item,
          root,
        })
        // Revocation withholds a result the host already produced.
        this.assertActive()
        if (!live()) throw stale()
        return Object.freeze({ root: response.root, path: response.path })
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (!live()) throw stale()
        if (error instanceof NativeCommandError && error.code === 'invalid_handle') throw stale()
        throw this.dropError(error)
      }
    })
  }

  receiveDrop(
    event: Extract<WindowEvent, { type: 'drop_target_drag' | 'drop_received' | 'drop_rejected' }>
  ): void {
    if (!this.active) return
    const registration = this.application.dropTargets.get(event.target_id)
    if (!registration?.live) return // Revoked: the host may already have queued this event.
    if (registration.windowId !== this.id)
      throw new ProtocolError('Native event names a drop target outside its owner')
    const common = {
      sequence: event.sequence,
      target: registration.handle,
      signal: registration.controller.signal,
    }
    let delivered: DropTargetEvent
    if (event.type === 'drop_target_drag')
      delivered = { type: event.state === 'entered' ? 'drag_entered' : 'drag_left', ...common }
    else if (event.type === 'drop_rejected') {
      registration.latestDrop = undefined
      delivered = { type: 'drop_rejected', reason: event.reason, ...common }
    } else {
      registration.latestDrop = event.drop_id
      const dropId = event.drop_id
      const items: NativeDroppedItem[] = event.items.map((item, index) =>
        Object.freeze({
          name: item.name,
          resolve: (root: string) => this.resolveDroppedItem(registration, dropId, index, root),
        })
      )
      delivered = { type: 'drop', items: Object.freeze(items), ...common }
    }
    this.application.queueCallback(
      listenerCallback(this.id, registration, Object.freeze(delivered))
    )
  }

  private withdrawNotification(registration: NotificationRegistration): Promise<void> {
    // Local revocation first: no activation is delivered after this call.
    registration.revoke()
    this.application.notifications.delete(registration.id)
    return this.releaseNative({
      type: 'withdraw_notification',
      window_id: this.id,
      notification_id: registration.id,
    })
  }

  receiveNotification(
    event: Extract<WindowEvent, { type: 'notification_activated' | 'notification_dismissed' }>
  ): void {
    if (!this.active) return
    const registration = this.application.notifications.get(event.notification_id)
    if (!registration?.live) return // Withdrawn: the host may already have queued an event.
    if (registration.windowId !== this.id)
      throw new ProtocolError('Native event names a notification outside its owner')
    const common = {
      sequence: event.sequence,
      notification: registration.handle,
      signal: registration.controller.signal,
    }
    if (event.type === 'notification_dismissed') {
      registration.end()
      this.application.notifications.delete(registration.id)
    }
    const delivered: NotificationEvent = Object.freeze(
      event.type === 'notification_activated'
        ? { type: 'notification_activated', ...common }
        : { type: 'notification_dismissed', reason: event.reason, ...common }
    )
    this.application.queueCallback({
      windowId: this.id,
      retain: () => registration.deliverable,
      run: () => dispatchNotification(registration, delivered),
    })
  }

  async showOpenDialog(
    options: OpenDialogOptions,
    request: ServiceRequestOptions = {}
  ): Promise<OpenDialogResult> {
    const wire = openDialogRequest(options)
    const result = await this.fileDialog(wire, serviceSignal(request))
    return result.kind === 'selected'
      ? Object.freeze({ kind: 'selected', paths: Object.freeze([...result.paths]) })
      : Object.freeze({ kind: 'cancelled' })
  }

  async showSaveDialog(
    options: SaveDialogOptions,
    request: ServiceRequestOptions = {}
  ): Promise<SaveDialogResult> {
    const wire = saveDialogRequest(options)
    const result = await this.fileDialog(wire, serviceSignal(request))
    return result.kind === 'selected'
      ? Object.freeze({ kind: 'selected', path: result.paths[0]! })
      : Object.freeze({ kind: 'cancelled' })
  }

  private fileDialog(options: FileDialogOptions, signal: AbortSignal | undefined) {
    return this.openPending(
      'file_dialogs',
      signal,
      this.application.dialogs,
      (other) => other.windowId === this.id,
      'This window already has an open file dialog',
      () => new FileDialogRequest(this.application.ids.dialog.allocate(), this.id, options.mode),
      (dialog) =>
        this.application.host.send({
          type: 'show_file_dialog',
          window_id: this.id,
          dialog_id: dialog.id,
          options,
        }),
      (dialog) =>
        this.cancelPending(
          'file_dialogs',
          this.application.dialogs,
          dialog,
          'The file dialog was cancelled',
          {
            type: 'close_file_dialog',
            window_id: this.id,
            dialog_id: dialog.id,
          }
        )
    )
  }

  async showContextMenu(
    items: readonly MenuEntryOptions[],
    position: ContextMenuPosition,
    request: ServiceRequestOptions = {}
  ): Promise<string | null> {
    const wire = contextMenuRequest(items, position)
    if (!this.application.capabilities.includes('context_menus_v1'))
      throw new UnsupportedFeatureError('context_menu')
    return this.openPending(
      'context_menus',
      serviceSignal(request),
      this.application.contextMenus,
      (other) => other.live,
      'Another context menu is already open',
      () =>
        new ContextMenuRequest(
          this.application.ids.contextMenu.allocate(),
          this.id,
          itemIds(wire.items)
        ),
      (menu) =>
        this.application.host.send({
          type: 'show_context_menu',
          window_id: this.id,
          menu_id: menu.id,
          ...wire,
        }),
      (menu) =>
        this.cancelPending(
          'context_menus',
          this.application.contextMenus,
          menu,
          'The context menu was cancelled',
          {
            type: 'close_context_menu',
            window_id: this.id,
            menu_id: menu.id,
          }
        )
    )
  }

  receiveContextMenu(event: Extract<WindowEvent, { type: 'context_menu_completed' }>): void {
    if (!this.active) return
    const menu = this.application.contextMenus.get(event.menu_id)
    if (!menu) return // Cancelled: the host may already have queued a result.
    if (menu.windowId !== this.id)
      throw new ProtocolError('Native event names a context menu outside its owner')
    this.application.contextMenus.delete(menu.id)
    menu.complete(event.item_id)
  }

  async showMessageDialog(
    options: MessageDialogOptions,
    request: ServiceRequestOptions = {}
  ): Promise<MessageDialogResult> {
    return this.messageDialog(messageDialogSpec(options), request)
  }

  async showConfirmDialog(
    options: ConfirmDialogOptions,
    request: ServiceRequestOptions = {}
  ): Promise<boolean> {
    const result = await this.messageDialog(confirmDialogSpec(options), request)
    return result.kind === 'button' && result.id === 'confirm'
  }

  /** The OS backend, only when the host offers it and the application granted it. */
  private nativeMessageDialogs(): NativeMessageDialogBackend | undefined {
    const capability = this.application.serviceCapabilities.messageDialogs
    if (capability.availability !== 'available' || capability.backend === 'modal_overlay')
      return undefined
    return {
      allocate: () => this.application.ids.messageDialog.allocate(),
      show: async (id, options) => {
        try {
          await this.application.service(() =>
            this.application.host.send({
              type: 'show_message_dialog',
              window_id: this.id,
              dialog_id: id,
              options,
            })
          )
        } catch (error) {
          throw serviceError('message_dialogs', DIALOG_ERRORS, error)
        }
      },
      close: (id) =>
        this.releaseNative({ type: 'close_message_dialog', window_id: this.id, dialog_id: id }),
    }
  }

  private messageDialog(
    spec: Parameters<MessageDialogs['show']>[0],
    request: ServiceRequestOptions
  ): Promise<MessageDialogResult> {
    const signal = serviceSignal(request)
    this.assertActive()
    if (this.application.serviceCapabilities.messageDialogs.availability !== 'available')
      throw new NativeServiceError(
        'message_dialogs',
        'service_unavailable',
        'The native host does not advertise modal overlays with focus requests'
      )
    return this.messages.show(spec, signal)
  }

  receiveFileDialog(event: Extract<WindowEvent, { type: 'file_dialog_completed' }>): void {
    if (!this.active) return
    const dialog = this.application.dialogs.get(event.dialog_id)
    if (!dialog) return // Cancelled: the host may already have queued a result.
    if (dialog.windowId !== this.id)
      throw new ProtocolError('Native event names a file dialog outside its owner')
    this.application.dialogs.delete(dialog.id)
    dialog.complete(event.result)
  }

  receiveShortcut(event: Extract<WindowEvent, { type: 'global_shortcut' }>): void {
    if (!this.active) return
    const registration = this.application.shortcuts.get(event.shortcut_id)
    if (!registration) return // Released: the host may already have queued a press.
    if (registration.windowId !== this.id)
      throw new ProtocolError('Native event names a global shortcut outside its owner')
    this.application.queueCallback(
      listenerCallback(
        this.id,
        registration,
        Object.freeze({
          type: 'global_shortcut' as const,
          sequence: event.sequence,
          shortcut: registration.handle,
          signal: registration.controller.signal,
        })
      )
    )
  }

  /** A failed service request's public error: protocol faults and a closed owner first. */
  private serviceFailure(
    service: NativeServiceError['service'],
    codes: ReadonlySet<string>,
    error: unknown
  ): unknown {
    if (error instanceof ProtocolError) return error
    this.assertActive()
    return serviceError(service, codes, error)
  }

  /**
   * Allocate, record and natively register one service handle. A failure, or
   * a revocation while the host registered it, forgets the record again.
   */
  private register<R extends { readonly id: number; readonly handle: unknown; revoke(): void }>(
    service: NativeServiceError['service'],
    codes: ReadonlySet<string>,
    registrations: Map<number, R>,
    create: () => R,
    send: (registration: R) => Promise<void>,
    accepted: (registration: R) => boolean,
    revoked: string
  ): Promise<R['handle']> {
    return this.application.service(async () => {
      this.assertActive()
      const registration = create()
      registrations.set(registration.id, registration)
      try {
        await send(registration)
        this.assertActive()
        if (!accepted(registration)) throw new NativeServiceError(service, 'cancelled', revoked)
        return registration.handle
      } catch (error) {
        registration.revoke()
        registrations.delete(registration.id)
        throw this.serviceFailure(service, codes, error)
      }
    })
  }

  /**
   * Natively release a handle already revoked locally. Window close and
   * application shutdown release it natively instead, and the owner can end
   * it while the request is in flight (`invalid_handle`).
   */
  private releaseNative(command: WindowCommand): Promise<void> {
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host.send(command).then(
        () => {},
        (error: unknown) => {
          if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
          if (!this.application.running) return
          throw error
        }
      )
    )
  }

  /**
   * Show one host-owned dialog or menu and wait for its result. An abort
   * while the host was showing it closes the now-live request.
   */
  private async openPending<P extends PendingRequest>(
    service: 'file_dialogs' | 'context_menus',
    signal: AbortSignal | undefined,
    pending: Map<number, P>,
    busy: (other: P) => boolean,
    busyMessage: string,
    create: () => P,
    send: (request: P) => Promise<unknown>,
    cancel: (request: P) => void
  ): Promise<Awaited<P['result']>> {
    this.assertActive()
    checkServiceCancellation(signal, service)
    const request = await this.application.service(async () => {
      this.assertActive()
      checkServiceCancellation(signal, service)
      for (const other of pending.values())
        if (busy(other)) throw new NativeServiceError(service, 'limit_exceeded', busyMessage)
      const request = create()
      pending.set(request.id, request)
      try {
        await send(request)
        this.assertActive()
        return request
      } catch (error) {
        request.fail(error instanceof Error ? error : new Error(String(error)))
        pending.delete(request.id)
        throw this.serviceFailure(service, DIALOG_ERRORS, error)
      }
    })
    const abort = () => cancel(request)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      return (await request.result) as Awaited<P['result']>
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Delivery stops at once; the OS dialog or menu is then closed natively. */
  private cancelPending<P extends PendingRequest>(
    service: 'file_dialogs' | 'context_menus',
    pending: Map<number, P>,
    request: P,
    message: string,
    command: WindowCommand
  ): void {
    if (!request.live) return
    request.fail(new NativeServiceError(service, 'cancelled', message))
    pending.delete(request.id)
    void this.releaseNative(command).catch(() => {})
  }

  async close(): Promise<void> {
    if (!this.active) {
      await this.closing
      return
    }
    this.active = false
    this.listeners.clear()
    this.nodes = new Map()
    this.text = new CommittedText(this.application.limits.max_text_bytes)
    this.revokeDisplayChanges()
    this.revokeOwned()
    this.closing = this.application.enqueue(async () => {
      try {
        await this.application.host.send({ type: 'close', window_id: this.id })
      } catch (error) {
        // An OS close can race an application close after revocation.
        if (!(error instanceof NativeCommandError && error.code === 'invalid_handle')) {
          // Do not leave an unreachable native window alive after close fails.
          void this.application.shutdown().catch(() => {})
          throw error
        }
      }
      this.revoke()
    }, true)
    await this.closing
  }

  /**
   * Revoke every service registration this window owns. `close()` runs it as
   * soon as the close starts, so an in-flight grant or process call settles as
   * `cancelled`, not as `invalid_handle` after the host acknowledges the close.
   */
  private revokeOwned(): void {
    const { shortcuts, notifications, fileGrants, processes, dropTargets } = this.application
    for (const registrations of [shortcuts, notifications, fileGrants, processes, dropTargets])
      for (const registration of registrations.values())
        if (registration.windowId === this.id) {
          registration.revoke()
          registrations.delete(registration.id)
        }
  }

  revoke(): void {
    this.active = false
    this.listeners.clear()
    this.nodes = new Map()
    this.text = new CommittedText(this.application.limits.max_text_bytes)
    this.revokeDisplayChanges()
    this.revokeOwned()
    const { dialogs, contextMenus } = this.application
    for (const [pending, name] of [
      [dialogs, 'File dialog'],
      [contextMenus, 'Context menu'],
    ] as const)
      for (const request of pending.values())
        if (request.windowId === this.id) {
          request.fail(new NativeStateError('invalid_handle', name + ' owner window was closed'))
          pending.delete(request.id)
        }
    this.messages.revoke()
    this.application.windows.delete(this.id)
    this.resolveClosed()
  }

  isTargetLive(id: number): boolean {
    return this.active && this.nodes.has(id)
  }

  receive(event: WindowEvent, nextNode: number): void {
    if (event.type === 'closed') {
      this.revoke()
      return
    }
    if (event.type === 'display_changed') {
      this.receiveDisplayChange(event)
      return
    }
    if (event.type === 'global_shortcut') {
      this.receiveShortcut(event)
      return
    }
    if (event.type === 'notification_activated' || event.type === 'notification_dismissed') {
      this.receiveNotification(event)
      return
    }
    if (event.type === 'process_output' || event.type === 'process_exited') {
      this.receiveProcess(event)
      return
    }
    if (event.type === 'file_dialog_completed') {
      this.receiveFileDialog(event)
      return
    }
    if (event.type === 'context_menu_completed') {
      this.receiveContextMenu(event)
      return
    }
    if (event.type === 'message_dialog_completed') {
      if (this.active) this.messages.completeNative(event.dialog_id, event.result)
      return
    }
    if (
      event.type === 'drop_target_drag' ||
      event.type === 'drop_received' ||
      event.type === 'drop_rejected'
    ) {
      this.receiveDrop(event)
      return
    }
    if (!this.active) return
    if (event.tree_revision > this.revision)
      throw new ProtocolError('Native event tree revision is ahead of its acknowledgement')
    if (event.path[0] !== this.rootId)
      throw new ProtocolError('Native event path starts outside its window root')
    const ownedPath: NodeState[] = []
    for (const id of event.path) {
      if (id >= nextNode) throw new ProtocolError('Native event names a node outside its owner')
      const node = this.nodes.get(id)
      if (node) ownedPath.push(node)
      else
        for (const window of this.application.windows.values())
          if (window !== this && window.nodes.has(id))
            throw new ProtocolError('Native event names a node outside its owner')
    }
    // Already revoked ownership cannot be recovered by a delayed native frame.
    if (ownedPath.length !== event.path.length) return
    if (
      event.tree_revision === this.revision &&
      ownedPath.some((node, index) => index > 0 && node.parent !== event.path[index - 1])
    )
      throw new ProtocolError('Native event path does not match its committed tree revision')
    const node = ownedPath.at(-1)!
    if (event.type === 'input') {
      if (node.element.kind !== 'input' || event.input_revision <= node.inputRevision)
        throw new ProtocolError('Native input kind or edit revision is invalid')
      const element = { ...node.element, value: event.value }
      this.text.replace(node.id, node.element, element)
      node.inputRevision = event.input_revision
      node.element = element
    } else if (event.type === 'click') {
      if (node.element.kind !== 'button')
        throw new ProtocolError('Native click targeted a non-button node')
      if (node.element.disabled) return
    } else if (event.type === 'dismiss') {
      if (node.element.kind !== 'overlay' || node.element.surface !== 'window')
        throw new ProtocolError('Native dismissal targeted a non-popup node')
    } else if (event.type === 'split_resize') {
      if (
        node.element.kind !== 'split' ||
        !this.application.capabilities.includes('split_resize_v1')
      )
        throw new ProtocolError(
          'Native split resize targeted a non-split node or was not advertised'
        )
    }
    const route = ownedPath.map((item) => item.handle)
    // Input inside a message dialog settles it during ingestion.
    if (this.messages.receive(event, route, node.handle)) return
    const plan = this.listeners.prepare(event, route)
    if (!plan) return
    const nodeId = node.id
    this.application.queueCallback({
      windowId: this.id,
      retain: () => {
        // A callback whose target or every binding is gone is dropped.
        const window = this.application.windows.get(this.id)
        if (window?.isTargetLive(nodeId) && prunePlan(plan)) return true
        window?.listeners.release(plan)
        return false
      },
      run: () => this.dispatch(nodeId, plan),
    })
  }

  async dispatch(nodeId: number, plan: DispatchPlan): Promise<void> {
    try {
      await dispatchPlan(plan, () => this.isTargetLive(nodeId))
    } finally {
      this.listeners.release(plan)
    }
  }
}

export async function createApplication(options: HostOptions): Promise<NativeApplication> {
  return new Application(await NativeHost.launch(options))
}
