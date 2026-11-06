import { ProtocolError } from './framing.ts'
import { integer, keys, object, string } from './values.ts'

/** Live drop targets across a session. */
export const MAX_DROP_TARGETS = 32
/** Items one drop may deliver. A larger drop is rejected, never truncated. */
export const MAX_DROP_ITEMS = 64
/** UTF-8 bytes of one untrusted display name. */
export const MAX_DROP_NAME_BYTES = 255

export const DRAG_STATES = Object.freeze(['entered', 'left'] as const)
export type DragState = (typeof DRAG_STATES)[number]
export const DROP_REJECTIONS = Object.freeze(['empty', 'limit_exceeded'] as const)
export type DropRejection = (typeof DROP_REJECTIONS)[number]

/** Untrusted display metadata for one dropped item. It is not a path. */
export interface DroppedItem {
  name: string
}

function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const found = values.find((candidate) => candidate === value)
  if (!found) throw new ProtocolError(field + ' must be one of ' + values.join(', '))
  return found
}

export const parseDragState = (value: unknown): DragState =>
  choice(value, DRAG_STATES, 'Drag state')
export const parseDropRejection = (value: unknown): DropRejection =>
  choice(value, DROP_REJECTIONS, 'Drop rejection')

export function parseDropItemIndex(value: unknown): number {
  return integer(value, 'Dropped item index', 0, MAX_DROP_ITEMS - 1)
}

export function parseDroppedItems(value: unknown): DroppedItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DROP_ITEMS)
    throw new ProtocolError('A drop must deliver between 1 and ' + MAX_DROP_ITEMS + ' items')
  return value.map((entry) => {
    const data = object(entry)
    keys(data, ['name'])
    const name = string(data['name'], 'Dropped item name', MAX_DROP_NAME_BYTES)
    if (!name || /\p{Cc}/u.test(name))
      throw new ProtocolError('Dropped item name must be nonempty without control characters')
    return { name }
  })
}
