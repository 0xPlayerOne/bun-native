import type { RpcContext } from '../../packages/runtime/src/rpc.ts'
import type { Pane } from './contract.ts'
import {
  parseInitialObservation,
  requireInitialObservation,
  type InitialObservation,
  type InitialObservationCommand,
  type InitialObservationPhase,
} from './initial-observation.ts'

interface Entry {
  readonly identity: RpcContext['identity']
  history: InitialObservation
  pending?: { resolve(next: InitialObservationCommand): void; reject(error: Error): void }
  waiting?: {
    phase: InitialObservationPhase
    resolve(history: InitialObservation): void
    reject(error: Error): void
  }
}

/** One bounded long-poll per authenticated document. Checkpoints acknowledge real
 * page samples after a host request; there is no timer, evaluation or state override.
 */
export class InitialObservationRequests {
  readonly #entries = new Map<Pane, Entry>()
  #closed: Error | undefined

  has(pane: Pane): boolean {
    return this.#entries.has(pane)
  }

  receive(input: unknown, context: RpcContext): Promise<{ next: InitialObservationCommand }> {
    if (this.#closed) throw this.#closed
    context.signal.throwIfAborted()
    const history = parseInitialObservation(input)
    if (history.overflow) throw new Error('Initial composition observation overflow')
    let entry = this.#entries.get(history.pane)
    if (entry) {
      const identity = context.identity
      const previousIdentity = entry.identity
      if (
        Object.keys(previousIdentity).some(
          (key) =>
            previousIdentity[key as keyof typeof identity] !==
            identity[key as keyof typeof identity]
        ) ||
        entry.pending ||
        entry.waiting?.phase !== history.phase ||
        entry.history.instance !== history.instance ||
        history.events.length <= entry.history.events.length ||
        JSON.stringify(history.events.slice(0, entry.history.events.length)) !==
          JSON.stringify(entry.history.events)
      )
        throw new Error('Initial composition document, history or checkpoint changed')
      entry.history = history
    } else {
      if (
        history.phase !== 'initial' ||
        [...this.#entries.values()].some(
          (other) => other.identity.viewId === context.identity.viewId
        )
      )
        throw new Error('Unexpected initial composition document')
      entry = { identity: Object.freeze({ ...context.identity }), history }
      this.#entries.set(history.pane, entry)
    }
    if (history.phase === 'before-show') {
      requireInitialObservation(history)
      entry.waiting?.resolve(history)
      delete entry.waiting
      return Promise.resolve({ next: 'stop' })
    }
    const current = entry
    const response = new Promise<{ next: InitialObservationCommand }>((resolve, reject) => {
      const remove = () => context.signal.removeEventListener('abort', abort)
      const abort = () => {
        remove()
        this.close(
          context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error('Initial composition document cancelled')
        )
      }
      current.pending = {
        resolve(next) {
          remove()
          resolve({ next })
        },
        reject(error) {
          remove()
          reject(error)
        },
      }
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
    })
    entry.waiting?.resolve(history)
    delete entry.waiting
    return response
  }

  checkpoint(
    pane: Pane,
    phase: Exclude<InitialObservationPhase, 'initial'>
  ): Promise<InitialObservation> {
    if (this.#closed) throw this.#closed
    const entry = this.#entries.get(pane)
    const expected =
      entry?.history.phase === 'initial' && pane !== 'overlay'
        ? 'before-create'
        : entry?.history.phase === 'initial' || entry?.history.phase === 'before-create'
          ? 'after-create'
          : 'before-show'
    if (!entry?.pending || entry.waiting || phase !== expected)
      throw new Error('Unexpected initial composition checkpoint request')
    const completed = new Promise<InitialObservation>((resolve, reject) => {
      entry.waiting = { phase, resolve, reject }
    })
    const pending = entry.pending
    delete entry.pending
    pending.resolve(phase)
    return completed
  }

  observations() {
    return Object.fromEntries(
      [...this.#entries].map(([pane, entry]) => [
        pane,
        {
          viewId: entry.identity.viewId,
          documentId: entry.identity.documentId,
          history: entry.history,
        },
      ])
    )
  }

  close(error = new Error('Initial composition observation closed')): void {
    this.#closed ??= error
    for (const entry of this.#entries.values()) {
      entry.pending?.reject(error)
      entry.waiting?.reject(error)
      delete entry.pending
      delete entry.waiting
    }
  }
}
