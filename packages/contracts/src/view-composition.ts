/** Portable native-view placement. Values are client-area density-independent pixels. */
import { BunlyError } from './core.ts'
import type { Bounds, BrowserBackend, OperationOptions, ViewHandle, WindowHandle } from './index.ts'

export type ViewLayoutMode = 'stack' | 'manual'
export type ViewLayer = 'content' | 'overlay'

export interface ViewPresentationOptions {
  readonly bounds: Bounds
  /** Intersect the viewport with this client-area rectangle. This resizes, rather than crops, the page viewport. */
  readonly clip?: Bounds | null
  readonly visible?: boolean
  readonly focusable?: boolean
  /** Stable traversal order within a window. Equal values retain native creation order. */
  readonly tabIndex?: number
}
export interface ViewPresentation {
  readonly bounds: Bounds
  readonly clip: Bounds | null
  readonly visible: boolean
  readonly focusable: boolean
  readonly tabIndex: number
}
export interface ViewPresentationState {
  readonly presentation: ViewPresentation
  readonly layer: ViewLayer
  /** Actual native viewport. A fully clipped or intentionally hidden view has zero visible dimensions. */
  readonly viewport: Bounds
  readonly visible: boolean
  readonly drawn: boolean
  readonly focused: boolean
  readonly focusable: boolean
}

/** Optional portable facet, advertised by the view.composition capability. */
export interface ViewCompositionBackend extends BrowserBackend {
  viewPresentation(view: ViewHandle, options?: OperationOptions): Promise<ViewPresentationState>
  setViewPresentation(
    view: ViewHandle,
    presentation: ViewPresentationOptions,
    options?: OperationOptions
  ): Promise<ViewPresentationState>
  /** Requests focus only for an eligible visible view; OS activation remains independent. */
  focusView(view: ViewHandle, options?: OperationOptions): Promise<void>
  /** Returns the requested focus target, not a promise that the OS activated its window. */
  focusNextView(
    window: WindowHandle,
    reverse?: boolean,
    options?: OperationOptions
  ): Promise<ViewHandle | null>
}

function invalid(message: string): never {
  throw new BunlyError('INVALID_ARGUMENT', message)
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Invalid view presentation')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key)))
    invalid('Unknown view presentation field')
  return result
}
function integer(value: unknown, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < low || Number(value) > high)
    invalid('View geometry must contain bounded integer DIPs')
  return Number(value)
}
export function viewRectangle(value: unknown, empty = false): Readonly<Bounds> {
  const object = record(value, ['x', 'y', 'width', 'height'])
  return Object.freeze({
    x: integer(object['x'], -32768, 32768),
    y: integer(object['y'], -32768, 32768),
    width: integer(object['width'], empty ? 0 : 1, 32768),
    height: integer(object['height'], empty ? 0 : 1, 32768),
  })
}
export function normalizeViewPresentation(value: unknown): ViewPresentation {
  const input = record(value, ['bounds', 'clip', 'visible', 'focusable', 'tabIndex'])
  for (const key of ['visible', 'focusable'] as const)
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`Invalid ${key}`)
  return Object.freeze({
    bounds: viewRectangle(input['bounds']),
    clip:
      input['clip'] === undefined || input['clip'] === null
        ? null
        : viewRectangle(input['clip'], true),
    visible: input['visible'] === undefined ? true : (input['visible'] as boolean),
    focusable: input['focusable'] === undefined ? true : (input['focusable'] as boolean),
    tabIndex: input['tabIndex'] === undefined ? 0 : integer(input['tabIndex'], 0, 127),
  })
}

/** Strict adapter readback parser. Never turns requested intent into observed state. */
export function parseViewPresentationState(value: unknown): ViewPresentationState {
  try {
    const input = record(value, [
      'presentation',
      'layer',
      'viewport',
      'visible',
      'drawn',
      'focused',
      'focusable',
    ])
    if (
      Object.keys(input).length !== 7 ||
      (input['layer'] !== 'content' && input['layer'] !== 'overlay')
    )
      invalid('Invalid presentation state')
    for (const key of ['visible', 'drawn', 'focused', 'focusable'])
      if (typeof input[key] !== 'boolean') invalid('Invalid observed presentation state')
    const declared = record(input['presentation'], [
      'bounds',
      'clip',
      'visible',
      'focusable',
      'tabIndex',
    ])
    if (Object.keys(declared).length !== 5) invalid('Incomplete presentation state')
    const presentation = normalizeViewPresentation(declared)
    const viewport = viewRectangle(input['viewport'], true)
    return Object.freeze({
      presentation,
      layer: input['layer'] as ViewLayer,
      viewport,
      visible: input['visible'] as boolean,
      drawn: input['drawn'] as boolean,
      focused: input['focused'] as boolean,
      focusable: input['focusable'] as boolean,
    })
  } catch {
    throw new Error('Malformed native view presentation state')
  }
}
