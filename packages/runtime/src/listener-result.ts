type ResultRecord = { count: number; state: 'pending' | 'fulfilled' | 'rejected' }

// Keep the promise reactions outside the observer's method scope so a retained
// promise cannot capture the observer (and its weak-key table) through `this`.
function attach(
  promise: Promise<unknown>,
  record: ResultRecord,
  counterRef: WeakRef<{ count: number }>
): void {
  void Promise.prototype.then.call(
    promise,
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

/** Observe async listener failures without retaining the listener or its owner. */
export class ListenerResultObserver {
  readonly #counter: WeakRef<{ count: number }>
  readonly #pending = new WeakMap<Promise<unknown>, ResultRecord>()

  constructor(counter: { count: number }) {
    this.#counter = new WeakRef(counter)
  }

  observe(value: unknown): void {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    // Both Promise.resolve and intrinsic then may consult a native promise's
    // constructor/species. A hostile accessor can prevent observation; the
    // dispatcher's catch counts the observation failure, not its rejection.
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
    const record: ResultRecord = { count: 1, state: 'pending' }
    this.#pending.set(promise, record)
    attach(promise, record, this.#counter)
  }
}
