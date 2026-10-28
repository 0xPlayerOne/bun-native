import { BunlyError } from '../../contracts/src/core.ts'
import type { NativeTransport } from './native-transport.ts'

export const VIEW_CONTROL_LIMITS = Object.freeze({ operations: 8, bytes: 8 * 1024 * 1024 })

/** Shared with every development controller on one native transport. Reserve
 * synchronously before copying caller bytes or awaiting native admission.
 */
export class CefViewControlBudget {
  readonly #owners = new Map<number, { readonly token: symbol; readonly bytes: number }>()
  #bytes = 0

  reserve(view: number, bytes: number): Readonly<{ release(): void }> {
    if (
      !Number.isSafeInteger(view) ||
      view < 1 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > VIEW_CONTROL_LIMITS.bytes
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid view-control reservation')
    if (
      this.#owners.has(view) ||
      this.#owners.size >= VIEW_CONTROL_LIMITS.operations ||
      this.#bytes + bytes > VIEW_CONTROL_LIMITS.bytes
    )
      throw new BunlyError('RESOURCE_IN_USE', 'Native view-control capacity is still owned')
    const token = Symbol()
    this.#owners.set(view, { token, bytes })
    this.#bytes += bytes
    return Object.freeze({
      release: () => {
        const owned = this.#owners.get(view)
        if (owned?.token !== token) return
        this.#owners.delete(view)
        this.#bytes -= owned.bytes
      },
    })
  }

  diagnostics(): Readonly<{ operations: number; bytes: number }> {
    return Object.freeze({ operations: this.#owners.size, bytes: this.#bytes })
  }
}

const transports = new WeakMap<NativeTransport, CefViewControlBudget>()
export function viewControlBudget(transport: NativeTransport): CefViewControlBudget {
  let budget = transports.get(transport)
  if (!budget) {
    budget = new CefViewControlBudget()
    transports.set(transport, budget)
  }
  return budget
}
