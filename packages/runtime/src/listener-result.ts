/** Observe async listener failures without retaining the listener or its owner. */
export class ListenerResultObserver {
  readonly #counter: WeakRef<{ count: number }>
  readonly #pending = new WeakMap<
    Promise<unknown>,
    { count: number; state: 'pending' | 'fulfilled' | 'rejected' }
  >()

  constructor(counter: { count: number }) {
    this.#counter = new WeakRef(counter)
  }

  observe(value: unknown): void {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    const promise = Promise.resolve(value)
    const prior = this.#pending.get(promise)
    if (prior) {
      if (prior.state === 'pending') prior.count++
      else if (prior.state === 'rejected') {
        const counter = this.#counter.deref()
        if (counter) counter.count++
      }
      return
    }
    const record = { count: 1, state: 'pending' as 'pending' | 'fulfilled' | 'rejected' }
    this.#pending.set(promise, record)
    const counterRef = this.#counter
    void promise.then(
      () => {
        record.state = 'fulfilled'
        record.count = 0
      },
      () => {
        record.state = 'rejected'
        const counter = counterRef.deref()
        if (counter) counter.count += record.count
        record.count = 0
      }
    )
  }
}
