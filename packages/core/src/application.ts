import { ProtocolError, REQUIRED_CAPABILITIES, type Limits } from '@bun-native/protocol'
import {
  NativeCommandError,
  NativeHost,
  type HostOptions,
  type WindowEvent,
} from '@bun-native/runtime'
import { dispatchPlan, EventBindings, prunePlan, type DispatchPlan } from './events.ts'
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
type Callback = { windowId: number; nodeId: number; plan: DispatchPlan }

class Application implements NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  // NativeHost.launch has negotiated every mandatory protocol feature.
  readonly capabilities = REQUIRED_CAPABILITIES
  readonly windows = new Map<number, Window>()
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
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
    })
  }

  allocateNode(): number {
    if (!Number.isSafeInteger(this.nextNode))
      throw new NativeStateError('limit_exceeded', 'Native node identity space exhausted')
    return this.nextNode++
  }

  cancelCallbacks(windowId: number): void {
    const window = this.windows.get(windowId)
    this.callbacks = this.callbacks.filter((callback) => {
      if (callback.windowId !== windowId) return true
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
        await window.dispatch(callback.nodeId, callback.plan)
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

  async shutdown(): Promise<void> {
    if (!this.stopping) {
      this.phase = 'stopping'
      for (const window of this.windows.values()) window.revoke()
      this.stopping = (async () => {
        await this.tail
        await this.host.shutdown()
      })()
    }
    await this.stopping
    if (this.failure) throw this.failure
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.host) {
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
      this.phase = 'closed'
    }
    if (this.failure) throw this.failure
  }
}

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
