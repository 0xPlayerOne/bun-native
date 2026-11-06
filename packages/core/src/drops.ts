import type { DropRejection } from '@bun-native/protocol'
import type { Listener, NativeNode } from './types.ts'

/**
 * One item of a drop. `name` is untrusted display text: the final path
 * component, lossily decoded and bounded. It is not unique and not a path.
 */
export interface NativeDroppedItem {
  readonly name: string
  /**
   * Map this item to a path relative to a launch filesystem root the
   * application already holds. The host matches the path it retained for
   * the drop; nothing here grants new authority. Rejects with `path_denied`
   * when the item is not beneath that root, and `cancelled` once a newer drop
   * replaced this one or the target, its node or its window is gone.
   */
  resolve(root: string): Promise<Readonly<{ root: string; path: string }>>
}

interface TargetEvent {
  readonly sequence: number
  readonly target: NativeDropTarget
  /** Aborted when the target closes, its node is removed, its window closes or the app stops. */
  readonly signal: AbortSignal
}

export type DropTargetEvent =
  | (TargetEvent & { readonly type: 'drag_entered' })
  /** The drag moved off the target or ended without a drop on it. */
  | (TargetEvent & { readonly type: 'drag_left' })
  | (TargetEvent & { readonly type: 'drop'; readonly items: readonly NativeDroppedItem[] })
  | (TargetEvent & { readonly type: 'drop_rejected'; readonly reason: DropRejection })

export interface NativeDropTarget {
  readonly node: NativeNode
  /** False once closed or revoked; no later event is delivered. */
  readonly active: boolean
  /** Idempotent. Delivery stops immediately; resolves after native removal. */
  close(): Promise<void>
}

/** Internal registry entry. Consumers only receive its frozen handle. */
export class DropTargetRegistration {
  readonly handle: NativeDropTarget
  readonly controller = new AbortController()
  listener: Listener<DropTargetEvent> | undefined
  /** The host retains paths only for the target's latest accepted drop. */
  latestDrop: number | undefined
  private released = false
  private releasing: Promise<void> | undefined

  constructor(
    readonly id: number,
    readonly windowId: number,
    readonly nodeId: number,
    node: NativeNode,
    listener: Listener<DropTargetEvent>,
    release: (registration: DropTargetRegistration) => Promise<void>
  ) {
    this.listener = listener
    this.handle = publicHandle(this, node, release)
  }

  release(release: (registration: DropTargetRegistration) => Promise<void>): Promise<void> {
    this.releasing ??= this.released ? Promise.resolve() : release(this)
    return this.releasing
  }

  get live(): boolean {
    return !this.released
  }

  /** Synchronous local revocation; native removal happens separately. */
  revoke(): void {
    if (this.released) return
    this.released = true
    this.listener = undefined
    this.latestDrop = undefined
    this.controller.abort()
  }
}

function publicHandle(
  registration: DropTargetRegistration,
  node: NativeNode,
  release: (registration: DropTargetRegistration) => Promise<void>
): NativeDropTarget {
  return Object.freeze({
    node,
    get active() {
      return registration.live
    },
    close: () => registration.release(release),
  })
}
