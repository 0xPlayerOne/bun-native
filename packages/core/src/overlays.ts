import type { KeyEvent, NativeNode, NativeWindow, PointerEvent } from './types.ts'

export type DismissEvent =
  | { readonly reason: 'escape'; readonly event: KeyEvent<'key_down'> }
  | { readonly reason: 'backdrop'; readonly event: PointerEvent<'pointer_down'> }

/**
 * Observe an overlay's dismissal requests: an unmodified Escape whose native
 * focus route passes through the overlay, or a press on a window overlay's own
 * backdrop (not on any descendant). The innermost overlay handles Escape first
 * and stops it, so one press closes one layer. Removing the overlay, closing
 * the window or calling the returned function revokes both registrations.
 *
 * This occupies the overlay's bubbling `key_down` and `pointer_down`
 * registrations; capture-phase listeners stay available. Nothing is removed
 * natively until the listener commits a batch.
 */
export function onDismiss(
  window: NativeWindow,
  overlay: NativeNode<'overlay'>,
  listener: (event: DismissEvent) => void | Promise<void>
): () => void {
  const keys = window.on(overlay, 'key_down', (event) => {
    const { control, alt, shift, platform, function: fn } = event.modifiers
    if (event.key !== 'escape' || control || alt || shift || platform || fn) return
    event.stopPropagation()
    return listener({ reason: 'escape', event })
  })
  const presses = window.on(overlay, 'pointer_down', (event) => {
    if (event.node !== overlay) return
    event.stopPropagation()
    return listener({ reason: 'backdrop', event })
  })
  return () => {
    keys()
    presses()
  }
}
