import { BunlyError } from '../../contracts/src/core.ts'
import type {
  ApplicationEvent,
  ApplicationQuitReason,
  ApplicationState,
} from '../../contracts/src/desktop.ts'
import type { OperationOptions } from '../../contracts/src/index.ts'

interface Subscription {
  readonly listener: (event: ApplicationEvent) => void
  readonly dispose: () => void
  active: boolean
}
interface ReadyWaiter {
  readonly resolve: (state: ApplicationState) => void
  readonly reject: (error: unknown) => void
  readonly dispose: () => void
}

/** Native observations and requested intent remain separate; callbacks own no OS resources. */
export class ApplicationLifecycle {
  #state: ApplicationState = Object.freeze({
    phase: 'starting',
    quitRequested: false,
    quitReason: null,
    outcome: 'pending',
  })
  readonly #subscriptions = new Set<Subscription>()
  readonly #readyWaiters = new Set<ReadyWaiter>()
  #availability: 'pending' | 'supported' | 'unsupported' = 'pending'
  #listenerErrors = 0

  state(): ApplicationState {
    return this.#state
  }
  diagnostics() {
    return {
      listeners: this.#subscriptions.size,
      readyWaiters: this.#readyWaiters.size,
      listenerErrors: this.#listenerErrors,
    }
  }
  ready(supported: boolean): void {
    if (this.#availability !== 'pending') return
    this.#availability = supported ? 'supported' : 'unsupported'
    if (supported && this.#state.phase === 'starting')
      this.#state = Object.freeze({ ...this.#state, phase: 'running' })
    for (const waiter of this.#readyWaiters) {
      waiter.dispose()
      if (supported) waiter.resolve(this.#state)
      else
        waiter.reject(
          new BunlyError('UNSUPPORTED_CAPABILITY', 'Native application lifecycle unavailable')
        )
    }
  }
  whenReady(options?: OperationOptions): Promise<ApplicationState> {
    try {
      options?.signal?.throwIfAborted()
      if (this.#state.phase === 'closed')
        throw new BunlyError('DISPOSED', 'Native application closed')
      if (this.#availability === 'unsupported')
        throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Native application lifecycle unavailable')
      if (this.#availability === 'supported') return Promise.resolve(this.#state)
      if (this.#readyWaiters.size >= 64)
        throw new BunlyError('RESOURCE_IN_USE', 'Application readiness waiter capacity exceeded')
      return new Promise((resolve, reject) => {
        const signal = options?.signal
        const dispose = () => {
          this.#readyWaiters.delete(waiter)
          signal?.removeEventListener('abort', abort)
        }
        const abort = () => {
          dispose()
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        const waiter: ReadyWaiter = { resolve, reject, dispose }
        this.#readyWaiters.add(waiter)
        signal?.addEventListener('abort', abort, { once: true })
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  requested(): void {
    if (this.#state.quitRequested || this.#state.phase === 'closed') return
    this.#state = Object.freeze({ ...this.#state, quitRequested: true })
    this.#emit({ type: 'quit-requested' })
  }
  quitting(reason: unknown): void {
    if (
      typeof reason !== 'string' ||
      !['requested', 'last-window', 'native', 'failure'].includes(reason)
    )
      throw new Error('Malformed native application quit reason')
    if (this.#state.phase === 'quitting' || this.#state.phase === 'closed')
      throw new Error('Duplicate native application quitting event')
    this.#state = Object.freeze({
      ...this.#state,
      phase: 'quitting',
      quitReason: reason as ApplicationQuitReason,
    })
    this.#emit({ type: 'quitting', reason: reason as ApplicationQuitReason })
  }
  closed(failed: boolean): void {
    if (this.#state.phase === 'closed') return
    const outcome = failed || this.#state.quitReason === 'failure' ? 'failed' : 'orderly'
    this.#state = Object.freeze({ ...this.#state, phase: 'closed', outcome })
    for (const waiter of this.#readyWaiters) {
      waiter.dispose()
      waiter.reject(new BunlyError('DISPOSED', 'Native application closed before readiness'))
    }
    this.#emit({ type: 'closed', outcome })
  }
  subscribe(listener: (event: ApplicationEvent) => void, options?: OperationOptions): () => void {
    if (this.#state.phase === 'closed')
      throw new BunlyError('DISPOSED', 'Native application closed')
    const signal = options?.signal
    signal?.throwIfAborted()
    if (typeof listener !== 'function')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid application listener')
    if (this.#subscriptions.size >= 64)
      throw new BunlyError('RESOURCE_IN_USE', 'Application listener capacity exceeded')
    const dispose = () => {
      if (!subscription.active) return
      subscription.active = false
      this.#subscriptions.delete(subscription)
      signal?.removeEventListener('abort', dispose)
    }
    const subscription: Subscription = { listener, dispose, active: true }
    this.#subscriptions.add(subscription)
    signal?.addEventListener('abort', dispose, { once: true })
    return dispose
  }
  #emit(event: ApplicationEvent): void {
    Object.freeze(event)
    for (const subscription of Array.from(this.#subscriptions)) {
      if (!subscription.active) continue
      if (event.type === 'closed') subscription.dispose()
      try {
        subscription.listener(event)
      } catch {
        this.#listenerErrors++
      }
    }
  }
}
