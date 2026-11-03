import { NativeStateError, type NativeWindow } from '@bun-native/core'

type Lifetime = { ended: boolean; listeners: Set<() => void> }
const lifetimes = new WeakMap<NativeWindow, Lifetime>()

function lifetimeFor(window: NativeWindow): Lifetime {
  let lifetime = lifetimes.get(window)
  if (!lifetime) {
    const created: Lifetime = { ended: false, listeners: new Set() }
    lifetime = created
    lifetimes.set(window, created)
    // This separate function scope must not contain an individual root listener:
    // JSC can retain that binding through a shared closure environment otherwise.
    void window.closed.then(() => {
      created.ended = true
      const listeners = [...created.listeners]
      created.listeners.clear()
      for (const notify of listeners) notify()
    })
  }
  return lifetime
}

/** One completion observer per window; unmounted roots unsubscribe immediately. */
export function watchWindow(window: NativeWindow, listener: () => void): () => void {
  const lifetime = lifetimeFor(window)
  if (lifetime.ended) throw new NativeStateError('invalid_handle', 'Window is already closed')
  lifetime.listeners.add(listener)
  return () => {
    lifetime.listeners.delete(listener)
  }
}
