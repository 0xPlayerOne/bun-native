import { NativeStateError, type NativeWindow } from '@bun-native/core'

type Registration = { listener: (() => void) | undefined }
type Lifetime = { ended: boolean; listeners: Set<Registration> }
const lifetimes = new WeakMap<NativeWindow, Lifetime>()

/** Release ownership before invocation, even if user code throws or reenters. */
function consume(registration: Registration): (() => void) | undefined {
  const listener = registration.listener
  registration.listener = undefined
  return listener
}

function lifetimeFor(window: NativeWindow): Lifetime {
  let lifetime = lifetimes.get(window)
  if (!lifetime) {
    const created: Lifetime = { ended: false, listeners: new Set() }
    lifetime = created
    lifetimes.set(window, created)
    // This scope never contains an individual root. Completion owns revocable
    // registrations rather than keeping callback bindings in retained closures.
    void window.closed.then(() => {
      created.ended = true
      const listeners = [...created.listeners].map(consume)
      created.listeners.clear()
      for (const notify of listeners) notify?.()
    })
  }
  return lifetime
}

/** One completion observer per window; release clears the callback itself. */
export function watchWindow(window: NativeWindow, listener: () => void): () => void {
  const lifetime = lifetimeFor(window)
  if (lifetime.ended) throw new NativeStateError('invalid_handle', 'Window is already closed')
  const registration: Registration = { listener }
  lifetime.listeners.add(registration)
  return () => {
    lifetime.listeners.delete(registration)
    registration.listener = undefined
  }
}
