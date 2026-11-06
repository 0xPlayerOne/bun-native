import {
  NativeStateError,
  type NativeNode,
  type NativeWindow,
  type SplitResizeEvent,
} from './types.ts'

/**
 * Observe the user's divider moves on one split, for example to persist them.
 * Requires the host's `split_resize_v1` capability; without it this throws
 * `UnsupportedFeatureError('event:split_resize')` before registering.
 *
 * A pointer drag reports once, after the button is released, when the drag
 * changed the ratio; each keyboard step that changes it reports once. A
 * declared `ratio` the host adopts is the application's own value and is
 * never reported. The listener occupies the split's bubbling `split_resize`
 * registration; removing the split, closing the window or calling the
 * returned function revokes it.
 */
export function onSplitResize(
  window: NativeWindow,
  split: NativeNode<'split'>,
  listener: (event: SplitResizeEvent) => void | Promise<void>
): () => void {
  if (split.kind !== 'split' || typeof listener !== 'function')
    throw new NativeStateError(
      'invalid_state',
      'Split resize listeners require a split and a function'
    )
  return window.on(split, 'split_resize', (event) => {
    if (event.node !== split) return
    return listener(event)
  })
}
