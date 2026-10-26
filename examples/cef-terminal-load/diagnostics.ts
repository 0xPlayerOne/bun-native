/** One in-flight diagnostic plus one overwritten latest snapshot per terminal.
 * Never gates consumption, changes its deadlines, or queues an unbounded history.
 * A backend snapshot is last observed state, not proof of renderer liveness. */
export interface ConsumerDiagnostic {
  terminal: number
  batch: number
  stage: string
  control: string
  bytes: number
  callbacks: number
  records: number
  visibility: string
  error: string | null
}
export class LatestDiagnostic {
  #latest: ConsumerDiagnostic | undefined
  #running = false
  #failed = false
  constructor(readonly send: (value: ConsumerDiagnostic) => Promise<unknown>) {}
  update(value: ConsumerDiagnostic) {
    if (this.#failed) return
    this.#latest = { ...value }
    if (!this.#running) void this.#drain()
  }
  async #drain() {
    this.#running = true
    try {
      while (this.#latest) {
        const next = this.#latest
        this.#latest = undefined
        await this.send(next)
      }
    } catch {
      this.#failed = true
      this.#latest = undefined
    } finally {
      this.#running = false
    }
  }
}
