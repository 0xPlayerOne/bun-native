import {
  MAX_POINTER_COORDINATE,
  parseContextMenuItems,
  ProtocolError,
  type AppMenuEntry,
} from '@bun-native/protocol'
import { menuEntriesRequest, type MenuEntryOptions } from './app-menu.ts'

/** Where an OS context menu opens, in logical pixels of the window's content. */
export interface ContextMenuPosition {
  readonly x: number
  readonly y: number
}

/** Copies consumer items into the closed wire shape and validates it with the shared parser. */
export function contextMenuRequest(
  items: readonly MenuEntryOptions[],
  position: ContextMenuPosition
): { items: AppMenuEntry[]; x: number; y: number } {
  if (!position || typeof position !== 'object')
    throw new TypeError('Context menu position must be an object')
  const { x, y } = position
  for (const value of [x, y])
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_POINTER_COORDINATE
    )
      throw new TypeError('Context menu position must be finite, nonnegative logical pixels')
  try {
    return { items: parseContextMenuItems(menuEntriesRequest(items)), x, y }
  } catch (error) {
    if (error instanceof ProtocolError) throw new TypeError(error.message)
    throw error
  }
}

/** Internal registry entry for one live native context menu. */
export class ContextMenuRequest {
  readonly result: Promise<string | null>
  private resolve!: (result: string | null) => void
  private reject!: (error: Error) => void
  private settled = false

  constructor(
    readonly id: number,
    readonly windowId: number,
    private readonly ids: ReadonlySet<string>
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // The caller may not await before revocation rejects it.
    void this.result.catch(() => {})
  }

  get live(): boolean {
    return !this.settled
  }

  complete(itemId: string | undefined): void {
    if (this.settled) return
    if (itemId !== undefined && !this.ids.has(itemId))
      throw new ProtocolError('Native context menu chose an item it was not given')
    this.settled = true
    this.resolve(itemId ?? null)
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.reject(error)
  }
}

/** Every item id of a validated menu, at any depth. */
export function itemIds(items: readonly AppMenuEntry[], into = new Set<string>()): Set<string> {
  for (const item of items)
    if (item.kind === 'item') into.add(item.id)
    else if (item.kind === 'submenu') itemIds(item.items, into)
  return into
}
