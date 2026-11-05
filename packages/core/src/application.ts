import { ProtocolError, type Capability, type Limits } from '@bun-native/protocol'
import {
  NativeCommandError,
  NativeHost,
  type HostOptions,
  type WindowEvent,
} from '@bun-native/runtime'
import { dispatchPlan, EventBindings, prunePlan, type DispatchPlan } from './events.ts'
import {
  checkServiceCancellation,
  NativeServiceError,
  serviceCapabilities,
  serviceSignal,
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
  fileGrantRequest,
  FileGrantRegistration,
  type FileCall,
  type FileGrantOptions,
  type NativeFileGrant,
} from './files.ts'
import { makeNode, own, Transaction, type NodeState } from './tree.ts'
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
      callbacks += window.listeners.size
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

  cancelCallbacks(windowId: number): void {
    const window = this.windows.get(windowId)
    this.callbacks = this.callbacks.filter((callback) => {
      if (callback.windowId !== windowId) return true
      if ('shortcut' in callback) return callback.shortcut.live
      if ('notification' in callback) return callback.notification.deliverable
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
      const window = this.windows.get(callback.windowId)
      if (!window) continue
      this.activeCallbacks = 1
      try {
        if ('shortcut' in callback) await dispatchShortcut(callback.shortcut, callback.event)
        else if ('notification' in callback)
          await dispatchNotification(callback.notification, callback.event)
        else await window.dispatch(callback.nodeId, callback.plan)
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

  private async consume(): Promise<void> {
    try {
      for await (const event of this.host) {
        if (event.type === 'global_shortcut' && !this.isAllocatedShortcut(event.shortcut_id))
          throw new ProtocolError('Native event names an unallocated global shortcut')
        if (
          (event.type === 'notification_activated' || event.type === 'notification_dismissed') &&
          !this.isAllocatedNotification(event.notification_id)
        )
          throw new ProtocolError('Native event names an unallocated notification')
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

const NOTIFICATION_ERRORS = [
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'native_failure',
  'operation_timed_out',
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
  nodes = new Map<number, NodeState>()
  revision = 0
  private active = true
  private resolveClosed!: () => void
  private closing: Promise<void> | undefined

  constructor(
    private readonly application: Application,
    readonly id: number,
    readonly rootId: number
  ) {
    const node = makeNode(rootId, { kind: 'box' })
    this.root = node.handle
    this.nodes.set(rootId, node)
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
        this.application.limits
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
      const reply = await this.application.host.send({
        type: 'batch',
        window_id: this.id,
        base_revision: this.revision,
        operations: transaction.operations,
      })
      this.assertActive()
      // Native input can arrive while an unrelated batch is in flight. Preserve
      // every newer edit instead of replacing it with a cloned candidate value.
      for (const [id, candidate] of transaction.nodes) {
        const current = this.nodes.get(id)
        if (
          current &&
          current.inputRevision > candidate.inputRevision &&
          current.element.kind === 'input' &&
          candidate.element.kind === 'input'
        ) {
          candidate.inputRevision = current.inputRevision
          candidate.element = { ...candidate.element, value: current.element.value }
        }
      }
      this.nodes = transaction.nodes
      this.revision = reply.tree_revision
      this.listeners.retain(this.nodes)
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
        // Cancellation and owner revocation suppress data after a submitted
        // read, while the transport still drains and validates its response.
        this.assertActive()
        checkServiceCancellation(signal, 'window_display')
        return Object.freeze({
          bounds: Object.freeze({ ...response.snapshot.bounds }),
          scaleFactor: response.snapshot.scale_factor,
        })
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
    this.nodes.clear()
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
    this.nodes.clear()
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
    if (event.type === 'global_shortcut') {
      this.receiveShortcut(event)
      return
    }
    if (event.type === 'notification_activated' || event.type === 'notification_dismissed') {
      this.receiveNotification(event)
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
      node.inputRevision = event.input_revision
      node.element = { ...node.element, value: event.value }
    } else if (event.type === 'click') {
      if (node.element.kind !== 'button')
        throw new ProtocolError('Native click targeted a non-button node')
      if (node.element.disabled) return
    }
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
