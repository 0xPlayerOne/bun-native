/** Best-effort callback delivery with bounded outstanding asynchronous results. */
export class DiagnosticObserverBudget {
  #pending = 0
  constructor(readonly onError: () => void = () => {}) {}
  invoke<T>(callback: (value: T) => void, value: T): void {
    if (this.#pending >= 128) return
    let result: unknown
    try {
      result = callback(value)
    } catch {
      this.onError()
      return
    }
    try {
      if (
        result === null ||
        (typeof result !== 'object' && typeof result !== 'function') ||
        typeof (result as { then?: unknown }).then !== 'function'
      )
        return
    } catch {
      this.onError()
      return
    }
    this.#pending++
    void Promise.resolve(result).then(
      () => {
        this.#pending--
      },
      () => {
        this.#pending--
        this.onError()
      }
    )
  }
}
