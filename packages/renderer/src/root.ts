import {
  NativeStateError,
  type InputState,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import { Node, snapshot, visit, type Owner, type Snapshot } from './nodes.ts'
import { commitNativeTree, type Committed, type Counts } from './native-tree.ts'
import { observeInput } from './input-intent.ts'
import { watchWindow } from './window-lifetime.ts'
import {
  eventProperties,
  isEventProperty,
  type EventListener,
  type EventProperty,
} from './event-properties.ts'

type Registration = {
  listener: EventListener
  unsubscribe: () => void
}

export interface RenderRoot {
  /** Initial native acknowledgement. A synchronous JSX evaluation error rejects this promise. */
  readonly ready: Promise<void>
  /** Ends after unmount or OS close; asynchronous renderer failures reject it. */
  readonly closed: Promise<void>
  readonly diagnostics: Readonly<{
    nodes: number
    listeners: number
    pending: boolean
    commits: number
    mutations: Readonly<Counts>
  }>
  /** Wait until all currently staged mutations have native acknowledgements. */
  flush(): Promise<void>
  /** Dispose the framework owner, revoke callbacks and remove only this root's subtree. */
  dispose(): Promise<void>
}

export interface RenderContext {
  readonly container: Node
  /** Register framework teardown before evaluating user components. */
  onCleanup(cleanup: () => void): void
  /** Unrecovered asynchronous framework errors terminate only this render root. */
  fail(cause: unknown): void
}

class Root implements RenderRoot, Owner {
  readonly token = {}
  readonly root = new Node('box')
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private rejectClosed!: (error: Error) => void
  private disposeFramework: (() => void) | undefined
  private unwatch: (() => void) | undefined
  private committed = new Map<Node, Committed>()
  private readonly registrations = new Map<Node, Map<EventProperty, Registration>>()
  private operation: Promise<void> | undefined
  private version = 0
  private acknowledged = -1
  private phase: 'active' | 'disposing' | 'closed' = 'active'
  private windowEnded = false
  private failure: Error | undefined
  private commits = 0
  private readonly mutations: Counts = { create: 0, set: 0, insert: 0, remove: 0 }

  constructor(
    private readonly window: NativeWindow,
    initialize: (context: RenderContext) => void
  ) {
    this.closed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closed.catch(() => {})
    this.root.owner = this
    this.root.scope = this.token
    this.unwatch = watchWindow(window, () => {
      this.windowEnded = true
      this.stop()
      this.finish()
    })
    try {
      initialize({
        container: this.root,
        onCleanup: (cleanup) => {
          if (this.disposeFramework)
            throw new NativeStateError('invalid_state', 'Framework cleanup is already registered')
          this.disposeFramework = cleanup
        },
        fail: (cause) => this.fail(cause),
      })
    } catch (cause) {
      this.failure = cause instanceof Error ? cause : new Error(String(cause))
      this.stop()
    }
    this.start()
    this.ready = this.flush().then(() => {
      if (this.commits === 0)
        throw new NativeStateError(
          'invalid_handle',
          'Render root closed before initial native acknowledgement'
        )
    })
    void this.ready.catch(() => {})
  }

  get diagnostics() {
    let listeners = 0
    for (const registrations of this.registrations.values()) listeners += registrations.size
    return Object.freeze({
      nodes: this.committed.size,
      listeners,
      pending: this.operation !== undefined,
      commits: this.commits,
      mutations: Object.freeze({ ...this.mutations }),
    })
  }

  changed(): void {
    if (this.phase !== 'active') return
    this.version += 1
    this.start()
  }

  detached(node: Node): void {
    visit(node, (child) => this.revoke(child))
  }

  private revoke(node: Node, property?: EventProperty): void {
    const registrations = this.registrations.get(node)
    if (!registrations) return
    if (property) {
      const registration = registrations.get(property)
      registrations.delete(property)
      if (!registrations.size) this.registrations.delete(node)
      registration?.unsubscribe()
    } else {
      this.registrations.delete(node)
      for (const registration of registrations.values()) registration.unsubscribe()
      registrations.clear()
    }
  }

  input(node: Node): InputState {
    const state = this.committed.get(node)
    if (this.phase !== 'active' || !state || state.handle.kind !== 'input')
      throw new NativeStateError(
        'invalid_handle',
        'Input is unmounted or has no committed native handle'
      )
    return this.window.input(state.handle as NativeNode<'input'>)
  }

  private start(): void {
    if (this.operation || this.phase === 'closed') return
    this.operation = Promise.resolve()
      .then(async () => {
        while (this.phase === 'active' && this.acknowledged !== this.version) {
          const version = this.version
          await this.commit(snapshot(this.root))
          this.acknowledged = version
        }
        if (this.phase === 'disposing') await this.cleanup()
      })
      .catch(async (cause: unknown) => {
        if (!this.windowEnded) {
          this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
          this.stop()
          try {
            await this.cleanup()
          } catch (cleanupError) {
            this.failure = new AggregateError(
              [this.failure, cleanupError],
              'Native renderer cleanup failed'
            )
            this.finish()
          }
        }
      })
      .finally(() => {
        this.operation = undefined
        if (
          this.phase === 'disposing' ||
          (this.phase === 'active' && this.acknowledged !== this.version)
        )
          this.start()
      })
  }

  async flush(): Promise<void> {
    while (this.operation) await this.operation
    if (this.failure) throw this.failure
  }

  async dispose(): Promise<void> {
    this.stop()
    this.start()
    await this.flush()
    await this.closed
  }

  private fail(cause: unknown): void {
    if (this.phase !== 'active') return
    this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
    this.stop()
    this.start()
  }

  private stop(): void {
    if (this.phase === 'closed') return
    this.phase = 'disposing'
    const dispose = this.disposeFramework
    this.disposeFramework = undefined
    try {
      dispose?.()
    } catch (cause) {
      this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
    }
    for (const node of this.registrations.keys()) this.revoke(node)
    visit(this.root, (node) => {
      node.owner = undefined
      for (const name of Object.keys(node.properties))
        if (isEventProperty(name)) delete node.properties[name]
    })
  }

  private finish(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.unwatch?.()
    this.unwatch = undefined
    this.committed.clear()
    this.root.children.length = 0
    if (this.failure) this.rejectClosed(this.failure)
    else this.resolveClosed()
  }

  private async cleanup(): Promise<void> {
    const root = this.committed.get(this.root)
    if (root && !this.windowEnded) {
      await this.window.batch((batch) => batch.remove(root.handle))
      this.mutations.remove += 1
      this.commits += 1
    }
    this.finish()
  }

  private async commit(desired: ReadonlyMap<Node, Snapshot>): Promise<void> {
    const previous = this.committed
    const { nodes: next, counts } = await commitNativeTree(
      this.window,
      this.root,
      previous,
      desired
    )
    if (this.windowEnded) return
    this.committed = next
    if (Object.values(counts).some((count) => count > 0)) this.commits += 1
    for (const field of ['create', 'set', 'insert', 'remove'] as const)
      this.mutations[field] += counts[field]
    if (this.phase !== 'active') return
    // Native snapshots own immutable transaction state, never live unsubscribe
    // functions. A detach during acknowledgement revokes this separate registry.
    for (const node of this.registrations.keys())
      if (!next.has(node) || node.owner !== this) this.revoke(node)
    for (const [node, state] of next) {
      if (node.owner !== this) continue
      for (const [name, registration] of this.registrations.get(node) ?? [])
        if (state.events[name] !== registration.listener) this.revoke(node, name)
      for (const [name, listener] of Object.entries(state.events)) {
        if (!isEventProperty(name) || !listener || this.registrations.get(node)?.has(name)) continue
        const binding = eventProperties[name]
        const unsubscribe = this.window.on(
          state.handle,
          binding.type,
          async (event) => {
            if (node.owner !== this || node.properties[name] !== listener) return
            if (event.type === 'input') observeInput(event)
            await listener(event)
            await this.flush()
          },
          { capture: binding.capture }
        )
        let registrations = this.registrations.get(node)
        if (!registrations) {
          registrations = new Map()
          this.registrations.set(node, registrations)
        }
        registrations.set(name, { listener, unsubscribe })
      }
    }
  }
}

/** Own one framework's staged tree, atomic native commits and terminal cleanup. */
export function createRenderRoot(
  window: NativeWindow,
  initialize: (context: RenderContext) => void
): RenderRoot {
  return new Root(window, initialize)
}
