import {
  parseRootId,
  ProtocolError,
  type Capability,
  type FileDialogOptions,
  type Limits,
  type Operation,
} from '@bun-native/protocol'
import {
  NativeCommandError,
  NativeHost,
  type ApplicationEvent,
  type HostOptions,
  type WindowEvent,
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
  type MenuOptions,
  type NativeMenuBar,
} from './app-menu.ts'
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
  type MessageDialogOptions,
  type MessageDialogResult,
} from './message-dialogs.ts'
import { CommittedText, makeNode, own, Transaction, type NodeState } from './tree.ts'
import {
  NativeStateError,
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
type Callback =
  | { windowId: number; nodeId: number; plan: DispatchPlan }
  | { windowId: number; shortcut: ShortcutRegistration; event: GlobalShortcutEvent }
  | { windowId: number; notification: NotificationRegistration; event: NotificationEvent }
  | { windowId: number; process: ProcessRegistration; event: ProcessEvent; chunk: number }
  | { windowId: number; display: DisplaySubscription; event: DisplayChangeEvent }
  | { windowId: number; dropTarget: DropTargetRegistration; event: DropTargetEvent }
  /** Application-scoped: no window owns the menu bar. */
  | { menuBar: MenuBarRegistration; event: AppMenuItemEvent }

class Application implements NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  // NativeHost.launch has negotiated every mandatory protocol feature.
  readonly capabilities: readonly Capability[]
  readonly serviceCapabilities: Readonly<ServiceCapabilities>
  readonly windows = new Map<number, Window>()
  readonly shortcuts = new Map<number, ShortcutRegistration>()
  private nextShortcut = 1
  readonly notifications = new Map<number, NotificationRegistration>()
  private nextNotification = 1
  readonly fileGrants = new Map<number, FileGrantRegistration>()
  private nextFileGrant = 1
  readonly processes = new Map<number, ProcessRegistration>()
  private nextProcess = 1
  readonly dialogs = new Map<number, FileDialogRequest>()
  private nextDialog = 1
  readonly dropTargets = new Map<number, DropTargetRegistration>()
  private nextDropTarget = 1
  private lastDrop = 0
  /** The installed (or installing) menu bar; replaced bars are revoked. */
  private menuBar: MenuBarRegistration | undefined
  private nextMenuBar = 1
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
  private readonly services = new Set<Promise<void>>()
  private callbacks: Callback[] = []
  private dispatching: Promise<void> | undefined
  private activeCallbacks = 0
  private nextWindow = 1
  private nextNode = 1
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

  allocateNode(): number {
    if (!Number.isSafeInteger(this.nextNode))
      throw new NativeStateError('limit_exceeded', 'Native node identity space exhausted')
    return this.nextNode++
  }

  allocateShortcut(): number {
    if (!Number.isSafeInteger(this.nextShortcut))
      throw new NativeStateError('limit_exceeded', 'Global shortcut identity space exhausted')
    return this.nextShortcut++
  }

  isAllocatedShortcut(id: number): boolean {
    return id < this.nextShortcut
  }

  allocateNotification(): number {
    if (!Number.isSafeInteger(this.nextNotification))
      throw new NativeStateError('limit_exceeded', 'Notification identity space exhausted')
    return this.nextNotification++
  }

  isAllocatedNotification(id: number): boolean {
    return id < this.nextNotification
  }

  allocateFileGrant(): number {
    if (!Number.isSafeInteger(this.nextFileGrant))
      throw new NativeStateError('limit_exceeded', 'File grant identity space exhausted')
    return this.nextFileGrant++
  }

  allocateProcess(): number {
    if (!Number.isSafeInteger(this.nextProcess))
      throw new NativeStateError('limit_exceeded', 'Process identity space exhausted')
    return this.nextProcess++
  }

  isAllocatedProcess(id: number): boolean {
    return id < this.nextProcess
  }

  allocateDialog(): number {
    if (!Number.isSafeInteger(this.nextDialog))
      throw new NativeStateError('limit_exceeded', 'File dialog identity space exhausted')
    return this.nextDialog++
  }

  isAllocatedDialog(id: number): boolean {
    return id < this.nextDialog
  }

  allocateDropTarget(): number {
    if (!Number.isSafeInteger(this.nextDropTarget))
      throw new NativeStateError('limit_exceeded', 'Drop target identity space exhausted')
    return this.nextDropTarget++
  }

  cancelCallbacks(windowId: number): void {
    const window = this.windows.get(windowId)
    this.callbacks = this.callbacks.filter((callback) => {
      if ('menuBar' in callback || callback.windowId !== windowId) return true
      if ('shortcut' in callback) return callback.shortcut.live
      if ('notification' in callback) return callback.notification.deliverable
      if ('dropTarget' in callback) return callback.dropTarget.live
      if ('process' in callback) return callback.process.live
      if ('display' in callback) return callback.display.live
      if (window?.isTargetLive(callback.nodeId) && prunePlan(callback.plan)) return true
      window?.listeners.release(callback.plan)
      return false
    })
  }

  queueCallback(callback: Callback): void {
    if (this.phase !== 'running') return
    if (this.callbacks.length >= MAX_QUEUED_CALLBACKS)
      throw new ProtocolError('Application callback queue limit exceeded')
    this.callbacks.push(callback)
    this.startDispatch()
  }

  private startDispatch(): void {
    if (!this.callbacks.length) return
    if (this.dispatching) return
    this.dispatching = this.dispatchCallbacks()
      .catch(async (cause) => {
        this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
        await this.shutdown().catch(() => {})
      })
      .finally(() => {
        this.dispatching = undefined
        this.startDispatch()
      })
  }

  private async dispatchCallbacks(): Promise<void> {
    while (this.callbacks.length) {
      const callback = this.callbacks.shift()!
      const window = 'menuBar' in callback ? undefined : this.windows.get(callback.windowId)
      if (!window && !('menuBar' in callback)) continue
      this.activeCallbacks = 1
      try {
        if ('menuBar' in callback) {
          const listener = callback.menuBar.listener
          if (listener && callback.menuBar.live)
            await dispatchOwned(listener, callback.event, callback.menuBar.controller.signal)
        } else if (!window) continue
        else if ('shortcut' in callback) await dispatchShortcut(callback.shortcut, callback.event)
        else if ('dropTarget' in callback)
          await dispatchDropTarget(callback.dropTarget, callback.event)
        else if ('notification' in callback)
          await dispatchNotification(callback.notification, callback.event)
        else if ('process' in callback)
          await window.dispatchProcess(callback.process, callback.event, callback.chunk)
        else if ('display' in callback) {
          const listener = callback.display.current
          if (listener)
            await dispatchOwned(listener, callback.event, callback.display.controller.signal)
        } else await window.dispatch(callback.nodeId, callback.plan)
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
      if (!Number.isSafeInteger(this.nextWindow))
        throw new NativeStateError('limit_exceeded', 'Native window identity space exhausted')
      const window = new Window(this, this.nextWindow++, this.allocateNode())
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
    const registration = new MenuBarRegistration(this.allocateMenuBar(), listener, (item) =>
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
    const id = this.allocateMenuBar()
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

  private allocateMenuBar(): number {
    if (!Number.isSafeInteger(this.nextMenuBar))
      throw new NativeStateError('limit_exceeded', 'Menu bar identity space exhausted')
    return this.nextMenuBar++
  }

  private async sendMenuBar(id: number, menus: ReturnType<typeof menuBarRequest>): Promise<void> {
    try {
      await this.service(() => this.host.send({ type: 'set_app_menu', menu_id: id, menus }))
    } catch (error) {
      if (this.menuBar?.id === id) {
        this.menuBar.revoke()
        this.menuBar = undefined
      }
      if (
        error instanceof NativeCommandError &&
        (MENU_ERRORS as readonly string[]).includes(error.code)
      )
        throw new NativeServiceError(
          'app_menu',
          error.code as NativeServiceError['code'],
          error.message
        )
      throw error
    }
  }

  private receiveMenuItem(event: ApplicationEvent): void {
    if (!this.capabilities.includes('app_menu_v1'))
      throw new ProtocolError('Native menu selection arrived without app_menu_v1')
    if (event.menu_id >= this.nextMenuBar)
      throw new ProtocolError('Native event names an unallocated menu bar')
    const registration = this.menuBar
    // A replaced or cleared bar's selection is stale and never delivered.
    if (!registration?.live || registration.id !== event.menu_id) return
    this.queueCallback({
      menuBar: registration,
      event: Object.freeze({
        type: 'app_menu_item',
        sequence: event.sequence,
        itemId: event.item_id,
        menuBar: registration.handle,
        signal: registration.controller.signal,
      }),
    })
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.host) {
        if (event.type === 'app_menu_item') {
          this.receiveMenuItem(event)
          continue
        }
        if (event.type === 'global_shortcut' && !this.isAllocatedShortcut(event.shortcut_id))
          throw new ProtocolError('Native event names an unallocated global shortcut')
        if (
          (event.type === 'notification_activated' || event.type === 'notification_dismissed') &&
          !this.isAllocatedNotification(event.notification_id)
        )
          throw new ProtocolError('Native event names an unallocated notification')
        if (
          (event.type === 'process_output' || event.type === 'process_exited') &&
          !this.isAllocatedProcess(event.process_id)
        )
          throw new ProtocolError('Native event names an unallocated process')
        if (event.type === 'file_dialog_completed' && !this.isAllocatedDialog(event.dialog_id))
          throw new ProtocolError('Native event names an unallocated file dialog')
        if (
          (event.type === 'drop_target_drag' ||
            event.type === 'drop_received' ||
            event.type === 'drop_rejected') &&
          event.target_id >= this.nextDropTarget
        )
          throw new ProtocolError('Native event names an unallocated drop target')
        if (event.type === 'drop_received') {
          if (event.drop_id <= this.lastDrop)
            throw new ProtocolError('Native drop identities must increase')
          this.lastDrop = event.drop_id
        }
        const window = this.windows.get(event.window_id)
        if (!window) {
          if (event.window_id >= this.nextWindow)
            throw new ProtocolError('Native event names an unallocated window')
          continue // Revoked window: late events must not retain or invoke callbacks.
        }
        window.receive(event, this.nextNode)
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

async function dispatchShortcut(
  registration: ShortcutRegistration,
  event: GlobalShortcutEvent
): Promise<void> {
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

async function dispatchDropTarget(
  registration: DropTargetRegistration,
  event: DropTargetEvent
): Promise<void> {
  const listener = registration.listener
  if (!listener || !registration.live) return
  await dispatchOwned(listener, event, registration.controller.signal)
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

const FILE_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'limit_exceeded',
  'not_found',
  'already_exists',
  'path_denied',
  'wrong_kind',
  'not_empty',
  'access_denied',
] as const

const PROCESS_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'limit_exceeded',
  'not_found',
  'path_denied',
  'wrong_kind',
  'access_denied',
  'invalid_state',
] as const

const DROP_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'conflict',
  'cancelled',
  'native_failure',
  'limit_exceeded',
  'not_found',
  'path_denied',
] as const

const NOTIFICATION_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'operation_timed_out',
  'limit_exceeded',
] as const

const DIALOG_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'operation_timed_out',
  'limit_exceeded',
] as const

const MENU_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'limit_exceeded',
] as const

const SHORTCUT_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'conflict',
  'cancelled',
  'native_failure',
  'operation_timed_out',
  'limit_exceeded',
] as const

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
  private readonly messages = new MessageDialogs(this)

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
        () => this.application.allocateNode(),
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
        this.listeners.retain(this.nodes)
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
        () => this.application.allocateNode(),
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
        if (
          error instanceof NativeCommandError &&
          (error.code === 'permission_denied' || error.code === 'service_unavailable')
        )
          throw new NativeServiceError('window_display', error.code, error.message)
        throw error
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
    for (const subscription of this.displayChanges)
      this.application.queueCallback({
        windowId: this.id,
        display: subscription,
        event: Object.freeze({
          type: 'display_change',
          sequence: event.sequence,
          snapshot,
          signal: subscription.controller.signal,
        }),
      })
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
        if (
          error instanceof NativeCommandError &&
          [
            'permission_denied',
            'service_unavailable',
            'cancelled',
            'native_failure',
            'operation_timed_out',
            'payload_too_large',
            'limit_exceeded',
          ].includes(error.code)
        )
          throw new NativeServiceError(
            service,
            error.code as NativeServiceError['code'],
            error.message
          )
        throw error
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
    return this.application.service(async () => {
      this.assertActive()
      const registration = new ShortcutRegistration(
        this.application.allocateShortcut(),
        this.id,
        key,
        modifiers,
        listener,
        (item) => this.releaseShortcut(item)
      )
      this.application.shortcuts.set(registration.id, registration)
      try {
        await this.application.host.send({
          type: 'register_global_shortcut',
          window_id: this.id,
          shortcut_id: registration.id,
          key,
          modifiers,
        })
        this.assertActive()
        if (!registration.live)
          throw new NativeServiceError(
            'global_shortcuts',
            'cancelled',
            'Global shortcut was revoked during registration'
          )
        return registration.handle
      } catch (error) {
        registration.revoke()
        this.application.shortcuts.delete(registration.id)
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (
          error instanceof NativeCommandError &&
          (SHORTCUT_ERRORS as readonly string[]).includes(error.code)
        )
          throw new NativeServiceError(
            'global_shortcuts',
            error.code as NativeServiceError['code'],
            error.message
          )
        throw error
      }
    })
  }

  private releaseShortcut(registration: ShortcutRegistration): Promise<void> {
    // Local revocation first: no activation is delivered after this call.
    registration.revoke()
    this.application.shortcuts.delete(registration.id)
    // Window close and application shutdown release the native grab.
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host
        .send({
          type: 'unregister_global_shortcut',
          window_id: this.id,
          shortcut_id: registration.id,
        })
        .then(
          () => {},
          (error: unknown) => {
            // The owner window can close while the request is in flight.
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            if (!this.application.running) return
            throw error
          }
        )
    )
  }

  async postNotification(
    options: NotificationOptions,
    listener: (event: NotificationEvent) => void | Promise<void>
  ): Promise<NativeNotification> {
    const { title, body } = notificationRequest(options)
    if (typeof listener !== 'function')
      throw new TypeError('A notification listener must be a function')
    this.assertActive()
    return this.application.service(async () => {
      this.assertActive()
      const registration = new NotificationRegistration(
        this.application.allocateNotification(),
        this.id,
        title,
        body,
        listener,
        (item) => this.withdrawNotification(item)
      )
      this.application.notifications.set(registration.id, registration)
      try {
        const posted = await this.application.host.send({
          type: 'post_notification',
          window_id: this.id,
          notification_id: registration.id,
          title,
          body,
        })
        registration.activatable = posted.activatable
        this.assertActive()
        if (!registration.deliverable)
          throw new NativeServiceError(
            'notifications',
            'cancelled',
            'Notification was revoked while it was posted'
          )
        return registration.handle
      } catch (error) {
        registration.revoke()
        this.application.notifications.delete(registration.id)
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (
          error instanceof NativeCommandError &&
          (NOTIFICATION_ERRORS as readonly string[]).includes(error.code)
        )
          throw new NativeServiceError(
            'notifications',
            error.code as NativeServiceError['code'],
            error.message
          )
        throw error
      }
    })
  }

  async openFileGrant(root: string, options: FileGrantOptions = {}): Promise<NativeFileGrant> {
    const request = fileGrantRequest(root, options)
    this.assertActive()
    return this.application.service(async () => {
      this.assertActive()
      const registration = new FileGrantRegistration(
        this.application.allocateFileGrant(),
        this.id,
        request.root,
        request.access,
        (item, call) => this.fileCall(item, call),
        (item) => this.closeFileGrant(item)
      )
      this.application.fileGrants.set(registration.id, registration)
      try {
        await this.application.host.send({
          type: 'open_file_grant',
          window_id: this.id,
          grant_id: registration.id,
          root: request.root,
          access: request.access,
        })
        this.assertActive()
        if (!registration.live)
          throw new NativeServiceError(
            'filesystem_grants',
            'cancelled',
            'File grant was revoked while it opened'
          )
        return registration.handle
      } catch (error) {
        registration.revoke()
        this.application.fileGrants.delete(registration.id)
        throw this.fileError(error)
      }
    })
  }

  private fileError(error: unknown): unknown {
    if (error instanceof ProtocolError) return error
    this.assertActive()
    if (
      error instanceof NativeCommandError &&
      (FILE_ERRORS as readonly string[]).includes(error.code)
    )
      return new NativeServiceError(
        'filesystem_grants',
        error.code as NativeServiceError['code'],
        error.message
      )
    return error
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
        this.assertActive()
        if (!registration.live) throw revoked()
        return call.finish(response.result)
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (!registration.live) throw revoked()
        throw this.fileError(error)
      }
    })
  }

  private closeFileGrant(registration: FileGrantRegistration): Promise<void> {
    registration.revoke()
    this.application.fileGrants.delete(registration.id)
    // Window close and application shutdown close the descriptor natively.
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host
        .send({ type: 'close_file_grant', window_id: this.id, grant_id: registration.id })
        .then(
          () => {},
          (error: unknown) => {
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            if (!this.application.running) return
            throw error
          }
        )
    )
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
    return this.application.service(async () => {
      this.assertActive()
      const registration = new ProcessRegistration(
        this.application.allocateProcess(),
        this.id,
        request.launch.executable,
        request.launch.terminal !== undefined,
        listener,
        (item, call) => this.processCall(item, call),
        (item) => this.releaseProcess(item)
      )
      this.application.processes.set(registration.id, registration)
      try {
        await this.application.host.send({
          type: 'spawn_process',
          window_id: this.id,
          process_id: registration.id,
          launch: cwd ? { ...request.launch, cwd } : request.launch,
        })
        this.assertActive()
        if (!registration.live)
          throw new NativeServiceError(
            'processes',
            'cancelled',
            'Process was released while it started'
          )
        return registration.handle
      } catch (error) {
        registration.revoke()
        this.application.processes.delete(registration.id)
        throw this.processError(error)
      }
    })
  }

  private processError(error: unknown): unknown {
    if (error instanceof ProtocolError) return error
    this.assertActive()
    if (
      error instanceof NativeCommandError &&
      (PROCESS_ERRORS as readonly string[]).includes(error.code)
    )
      return new NativeServiceError(
        'processes',
        error.code as NativeServiceError['code'],
        error.message
      )
    return error
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
        this.assertActive()
        if (!registration.live) throw revoked()
        throw this.processError(error)
      }
    })
  }

  private releaseProcess(registration: ProcessRegistration): Promise<void> {
    registration.revoke()
    this.application.processes.delete(registration.id)
    // Window close and application shutdown stop the process group natively.
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host
        .send({ type: 'release_process', window_id: this.id, process_id: registration.id })
        .then(
          () => {},
          (error: unknown) => {
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            if (!this.application.running) return
            throw error
          }
        )
    )
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
      this.application.queueCallback({
        windowId: this.id,
        process: registration,
        chunk: event.chunk,
        event: Object.freeze({
          type: 'process_output',
          stream: event.stream,
          bytes: Uint8Array.fromBase64(event.data),
          ...common,
        }),
      })
      return
    }
    registration.end()
    registration.exit = Object.freeze({ ...event.exit })
    this.application.queueCallback({
      windowId: this.id,
      process: registration,
      chunk: 0,
      event: Object.freeze({ type: 'process_exited', exit: registration.exit, ...common }),
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
            if (!this.application.running) return
            throw error
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
    return this.application.service(async () => {
      this.assertActive()
      if (this.nodes.get(node.id)?.handle !== node.handle)
        throw new NativeStateError('invalid_handle', 'Drop target node was removed')
      const registration = new DropTargetRegistration(
        this.application.allocateDropTarget(),
        this.id,
        node.id,
        node.handle,
        listener,
        (item) => this.releaseDropTarget(item)
      )
      this.application.dropTargets.set(registration.id, registration)
      try {
        await this.application.host.send({
          type: 'register_drop_target',
          window_id: this.id,
          target_id: registration.id,
          node_id: node.id,
        })
        this.assertActive()
        if (!registration.live)
          throw new NativeServiceError(
            'drag_drop',
            'cancelled',
            'Drop target was revoked during registration'
          )
        return registration.handle
      } catch (error) {
        registration.revoke()
        this.application.dropTargets.delete(registration.id)
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (error instanceof NativeCommandError && error.code === 'invalid_handle')
          throw new NativeStateError('invalid_handle', 'Drop target node is not committed')
        throw this.dropError(error)
      }
    })
  }

  private dropError(error: unknown): unknown {
    if (
      error instanceof NativeCommandError &&
      (DROP_ERRORS as readonly string[]).includes(error.code)
    )
      return new NativeServiceError(
        'drag_drop',
        error.code as NativeServiceError['code'],
        error.message
      )
    return error
  }

  private releaseDropTarget(registration: DropTargetRegistration): Promise<void> {
    // Local revocation first: no drag or drop is delivered after this call.
    registration.revoke()
    this.application.dropTargets.delete(registration.id)
    // Window close and application shutdown remove it natively.
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host
        .send({
          type: 'unregister_drop_target',
          window_id: this.id,
          target_id: registration.id,
        })
        .then(
          () => {},
          (error: unknown) => {
            // A tree commit or the owner window can remove it while in flight.
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            if (!this.application.running) return
            throw error
          }
        )
    )
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
    this.application.queueCallback({
      windowId: this.id,
      dropTarget: registration,
      event: Object.freeze(delivered),
    })
  }

  private withdrawNotification(registration: NotificationRegistration): Promise<void> {
    // Local revocation first: no activation is delivered after this call.
    registration.revoke()
    this.application.notifications.delete(registration.id)
    // Window close and application shutdown withdraw it natively.
    if (!this.active || !this.application.running) return Promise.resolve()
    return this.application.track(
      this.application.host
        .send({
          type: 'withdraw_notification',
          window_id: this.id,
          notification_id: registration.id,
        })
        .then(
          () => {},
          (error: unknown) => {
            // The server or the owner can end it while the request is in flight.
            if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
            if (!this.application.running) return
            throw error
          }
        )
    )
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
    this.application.queueCallback({
      windowId: this.id,
      notification: registration,
      event: Object.freeze(
        event.type === 'notification_activated'
          ? { type: 'notification_activated', ...common }
          : { type: 'notification_dismissed', reason: event.reason, ...common }
      ),
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

  private async fileDialog(options: FileDialogOptions, signal: AbortSignal | undefined) {
    this.assertActive()
    checkServiceCancellation(signal, 'file_dialogs')
    const dialog = await this.application.service(async () => {
      this.assertActive()
      checkServiceCancellation(signal, 'file_dialogs')
      for (const other of this.application.dialogs.values())
        if (other.windowId === this.id)
          throw new NativeServiceError(
            'file_dialogs',
            'limit_exceeded',
            'This window already has an open file dialog'
          )
      const dialog = new FileDialogRequest(this.application.allocateDialog(), this.id, options.mode)
      this.application.dialogs.set(dialog.id, dialog)
      try {
        await this.application.host.send({
          type: 'show_file_dialog',
          window_id: this.id,
          dialog_id: dialog.id,
          options,
        })
        this.assertActive()
        return dialog
      } catch (error) {
        dialog.fail(error instanceof Error ? error : new Error(String(error)))
        this.application.dialogs.delete(dialog.id)
        if (error instanceof ProtocolError) throw error
        this.assertActive()
        if (
          error instanceof NativeCommandError &&
          (DIALOG_ERRORS as readonly string[]).includes(error.code)
        )
          throw new NativeServiceError(
            'file_dialogs',
            error.code as NativeServiceError['code'],
            error.message
          )
        throw error
      }
    })
    // An abort while the host was showing it closes the now-live dialog.
    const cancel = () => this.closeFileDialog(dialog)
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await dialog.result
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
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

  /** Delivery stops at once; the OS dialog is then closed natively. */
  private closeFileDialog(dialog: FileDialogRequest): void {
    if (!dialog.live) return
    dialog.fail(
      new NativeServiceError('file_dialogs', 'cancelled', 'The file dialog was cancelled')
    )
    this.application.dialogs.delete(dialog.id)
    // Window close and application shutdown close it natively.
    if (!this.active || !this.application.running) return
    void this.application
      .track(
        this.application.host
          .send({ type: 'close_file_dialog', window_id: this.id, dialog_id: dialog.id })
          .then(
            () => {},
            (error: unknown) => {
              // The user can finish it, or the owner close, while this is in flight.
              if (error instanceof NativeCommandError && error.code === 'invalid_handle') return
              if (!this.application.running) return
              throw error
            }
          )
      )
      .catch(() => {})
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
    this.application.queueCallback({
      windowId: this.id,
      shortcut: registration,
      event: Object.freeze({
        type: 'global_shortcut',
        sequence: event.sequence,
        shortcut: registration.handle,
        signal: registration.controller.signal,
      }),
    })
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

  revoke(): void {
    this.active = false
    this.listeners.clear()
    this.nodes = new Map()
    this.text = new CommittedText(this.application.limits.max_text_bytes)
    this.revokeDisplayChanges()
    for (const registration of this.application.shortcuts.values())
      if (registration.windowId === this.id) {
        registration.revoke()
        this.application.shortcuts.delete(registration.id)
      }
    for (const registration of this.application.notifications.values())
      if (registration.windowId === this.id) {
        registration.revoke()
        this.application.notifications.delete(registration.id)
      }
    for (const registration of this.application.fileGrants.values())
      if (registration.windowId === this.id) {
        registration.revoke()
        this.application.fileGrants.delete(registration.id)
      }
    for (const registration of this.application.processes.values())
      if (registration.windowId === this.id) {
        registration.revoke()
        this.application.processes.delete(registration.id)
      }
    for (const dialog of this.application.dialogs.values())
      if (dialog.windowId === this.id) {
        dialog.fail(new NativeStateError('invalid_handle', 'File dialog owner window was closed'))
        this.application.dialogs.delete(dialog.id)
      }
    for (const registration of this.application.dropTargets.values())
      if (registration.windowId === this.id) {
        registration.revoke()
        this.application.dropTargets.delete(registration.id)
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
    }
    // Input inside a message dialog settles it during ingestion.
    if (
      this.messages.receive(
        event,
        ownedPath.map((item) => item.handle),
        node.handle
      )
    )
      return
    const plan = this.listeners.prepare(
      event,
      ownedPath.map((item) => item.handle)
    )
    if (plan) this.application.queueCallback({ windowId: this.id, nodeId: node.id, plan })
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
