/** Latch asynchronous failure even after the last signal-aware native operation. */
export function observeCompositionLifetime(
  closed: Promise<void>,
  controller: AbortController,
  failed: (error: unknown) => void
): { beginShutdown(): void; detach(): void } {
  let shutdownRequested = false,
    active = true
  const aborted = () => {
    if (active) failed(controller.signal.reason ?? new Error('Composition cancelled'))
  }
  controller.signal.addEventListener('abort', aborted, { once: true })
  if (controller.signal.aborted) aborted()
  void closed.then(
    () => {
      if (active && !shutdownRequested)
        controller.abort(new Error('Composition host closed before completion'))
    },
    (error: unknown) => {
      if (active) controller.abort(error)
    }
  )
  return {
    beginShutdown() {
      shutdownRequested = true
    },
    detach() {
      active = false
      controller.signal.removeEventListener('abort', aborted)
    },
  }
}
