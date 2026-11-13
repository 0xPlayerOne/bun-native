import type { Listener } from './types.ts'

/**
 * Internal registry entry behind one window-owned service handle: its
 * identity, owner window, listener, the signal that listener receives and one
 * memoized native release. Consumers only receive the frozen handle.
 */
export class Registration<Event = never> {
  readonly controller = new AbortController()
  listener: Listener<Event> | undefined
  /** No further event is accepted and release is a no-op. */
  protected released = false
  private releasing: Promise<void> | undefined

  constructor(
    readonly id: number,
    readonly windowId: number,
    listener?: Listener<Event>
  ) {
    this.listener = listener
  }

  get live(): boolean {
    return !this.released
  }

  /** Shared by the public handle; one native release per registration. */
  release(release: (registration: this) => Promise<void>): Promise<void> {
    this.releasing ??= this.released ? Promise.resolve() : release(this)
    return this.releasing
  }

  /** Synchronous local revocation; the native resource is released separately. */
  revoke(): void {
    this.released = true
    this.listener = undefined
    this.controller.abort()
  }
}
