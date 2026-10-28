import type { WindowCommandsEvent } from '../../packages/contracts/src/index.ts'

/** Contributor observation queue. It never manufactures a native command or lifecycle event. */
export class CommandObservations {
  readonly events: WindowCommandsEvent[] = []
  #cursor = 0
  #failure: Error | undefined
  #pending:
    | { resolve: (event: WindowCommandsEvent) => void; reject: (error: Error) => void }
    | undefined
  readonly #abort: () => void
  constructor(readonly signal: AbortSignal) {
    this.#abort = () => this.fail(new Error('Window command observations aborted'))
    signal.addEventListener('abort', this.#abort, { once: true })
    if (signal.aborted) this.#abort()
  }
  receive(event: WindowCommandsEvent): void {
    if (this.#failure) return
    if (this.events.length === 32) {
      this.fail(new Error('Window command observation capacity'))
      return
    }
    this.events.push(event)
    if (this.#pending) {
      const pending = this.#pending
      this.#pending = undefined
      this.#cursor++
      pending.resolve(event)
    }
  }
  fail(error: Error): void {
    this.#failure ??= error
    this.#pending?.reject(this.#failure)
    this.#pending = undefined
  }
  async take(
    type: WindowCommandsEvent['type'],
    source?: 'menu' | 'shortcut'
  ): Promise<WindowCommandsEvent> {
    if (this.#failure) throw this.#failure
    if (this.#pending) throw new Error('Concurrent window command observation waiter')
    const next = this.events[this.#cursor]
    const event = next
      ? (this.#cursor++, next)
      : await new Promise<WindowCommandsEvent>((resolve, reject) => {
          this.#pending = { resolve, reject }
        })
    if (
      event.type !== type ||
      (source !== undefined && (event.type !== 'command' || event.source !== source))
    )
      throw new Error('Unexpected native window command observation order')
    return event
  }
  assertDrained(): void {
    if (this.#failure) throw this.#failure
    if (this.#pending || this.#cursor !== this.events.length)
      throw new Error('Unexpected unconsumed native window command observations')
  }
  close(): void {
    this.signal.removeEventListener('abort', this.#abort)
    this.fail(new Error('Window command observations closed'))
  }
}
