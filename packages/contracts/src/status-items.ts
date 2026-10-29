import { BunlyError } from './core.ts'
import type { PolicyScope } from './desktop.ts'
import type { OperationOptions } from './index.ts'

declare const statusItemBrand: unique symbol
/** An in-process owner identity. The public ID is diagnostic, never authority. */
export interface StatusItemHandle {
  readonly id: string
  readonly [statusItemBrand]: true
}
export interface StatusItemDefinition {
  readonly title: string
  readonly tooltip?: string
}
export type StatusItemEvent = {
  readonly type: 'click' | 'revoked'
  readonly sequence: number
}
/** Bounded text status items. Icons, menus and application keepalive are separate APIs. */
export interface StatusItemBackend {
  /** The signal owns the item until disposal, including after creation resolves. */
  createStatusItem(
    scope: PolicyScope,
    definition: StatusItemDefinition,
    options?: OperationOptions
  ): Promise<StatusItemHandle>
  updateStatusItem(item: StatusItemHandle, definition: StatusItemDefinition): Promise<void>
  onStatusItemEvent(
    item: StatusItemHandle,
    listener: (event: StatusItemEvent) => void,
    options?: OperationOptions
  ): () => void
  /** Resolves after the actual platform item is removed; authentic disposal is idempotent. */
  disposeStatusItem(item: StatusItemHandle): Promise<void>
}
export const STATUS_ITEM_LIMITS = Object.freeze({
  items: 4,
  itemsPerView: 1,
  listeners: 16,
  titleBytes: 64,
  tooltipBytes: 256,
})
function invalid(): never {
  throw new BunlyError('INVALID_ARGUMENT', 'Invalid text status item')
}
function text(value: unknown, maximum: number, empty: boolean): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) invalid()
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || (unit >= 0xdc00 && unit <= 0xdfff))
      invalid()
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid()
    }
  }
  if (new TextEncoder().encode(value).length > maximum) invalid()
  return value
}
/** Snapshot only plain text before crossing an asynchronous or native boundary. */
export function normalizeStatusItem(value: unknown): Readonly<Required<StatusItemDefinition>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  if (
    !Object.hasOwn(input, 'title') ||
    Object.keys(input).some((key) => key !== 'title' && key !== 'tooltip')
  )
    invalid()
  return Object.freeze({
    title: text(input['title'], STATUS_ITEM_LIMITS.titleBytes, false),
    tooltip: text(
      input['tooltip'] === undefined ? '' : input['tooltip'],
      STATUS_ITEM_LIMITS.tooltipBytes,
      true
    ),
  })
}
