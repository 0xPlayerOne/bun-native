import type { DisplayChangeEvent } from './services.ts'

/** Internal owner of one `onDisplayChange` listener. Consumers only receive its remover. */
export class DisplaySubscription {
  readonly controller = new AbortController()
  private listener: ((event: DisplayChangeEvent) => void | Promise<void>) | undefined

  constructor(listener: (event: DisplayChangeEvent) => void | Promise<void>) {
    this.listener = listener
  }

  get live(): boolean {
    return this.listener !== undefined
  }

  /** Idempotent: no later change is delivered and an active listener's signal aborts. */
  revoke(): void {
    this.listener = undefined
    this.controller.abort()
  }

  get current(): ((event: DisplayChangeEvent) => void | Promise<void>) | undefined {
    return this.listener
  }
}
