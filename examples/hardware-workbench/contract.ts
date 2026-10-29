import { defineRpc, procedure } from '../../packages/contracts/src/rpc.ts'
import {
  parseViewPresentationState,
  type Bounds,
  type ViewPresentationState,
  type WindowState,
} from '../../packages/contracts/src/index.ts'

export const previewNames = ['left', 'right'] as const
export type PreviewName = (typeof previewNames)[number]
export const windowActions = [
  'activate',
  'minimize',
  'maximize',
  'restore',
  'fullscreen',
  'windowed',
  'hide-briefly',
] as const
export type WorkbenchCommand =
  | { readonly action: 'focus' | 'close-pane' | 'reopen-pane'; readonly pane: PreviewName }
  | {
      readonly action: 'present'
      readonly pane: PreviewName
      readonly visible: boolean
      readonly focusable: boolean
      readonly clip: 'none' | 'partial' | 'full'
      readonly width: number
      readonly height: number
    }
  | { readonly action: 'traverse'; readonly reverse: boolean }
  | { readonly action: 'overlay'; readonly state: 'open' | 'hidden' | 'closed' }
  | { readonly action: 'window'; readonly operation: (typeof windowActions)[number] }
  | { readonly action: 'resize-window'; readonly size: 'compact' | 'regular' | 'large' }
  | { readonly action: 'dismiss-overlay' | 'quit' | 'native-menu' | 'open-dialog' }

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new Error('Invalid workbench fields')
  return value as Record<string, unknown>
}
function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new Error('Invalid workbench choice')
  return value as T
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new Error('Invalid workbench integer')
  return Number(value)
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid workbench boolean')
  return value
}

/** No arbitrary IDs, URLs, script, native operation names, paths or extra fields. */
export function parseWorkbenchCommand(input: unknown): WorkbenchCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid workbench command')
  const action = (input as Record<string, unknown>)['action']
  switch (action) {
    case 'focus':
    case 'close-pane':
    case 'reopen-pane': {
      const row = object(input, ['action', 'pane'])
      return Object.freeze({ action, pane: member(row['pane'], previewNames) })
    }
    case 'present': {
      const row = object(input, [
        'action',
        'pane',
        'visible',
        'focusable',
        'clip',
        'width',
        'height',
      ])
      return Object.freeze({
        action,
        pane: member(row['pane'], previewNames),
        visible: boolean(row['visible']),
        focusable: boolean(row['focusable']),
        clip: member(row['clip'], ['none', 'partial', 'full']),
        width: integer(row['width'], 240, 720),
        height: integer(row['height'], 180, 680),
      })
    }
    case 'traverse': {
      const row = object(input, ['action', 'reverse'])
      return Object.freeze({ action, reverse: boolean(row['reverse']) })
    }
    case 'overlay': {
      const row = object(input, ['action', 'state'])
      return Object.freeze({ action, state: member(row['state'], ['open', 'hidden', 'closed']) })
    }
    case 'window': {
      const row = object(input, ['action', 'operation'])
      return Object.freeze({ action, operation: member(row['operation'], windowActions) })
    }
    case 'resize-window': {
      const row = object(input, ['action', 'size'])
      return Object.freeze({ action, size: member(row['size'], ['compact', 'regular', 'large']) })
    }
    case 'dismiss-overlay':
    case 'native-menu':
    case 'open-dialog':
    case 'quit':
      object(input, ['action'])
      return Object.freeze({ action })
    default:
      throw new Error('Unknown workbench command')
  }
}

export interface WorkbenchSnapshot {
  readonly phase: 'starting' | 'ready' | 'closing'
  readonly heartbeat: number
  readonly observedAtMs: number
  readonly window: { readonly state: WindowState; readonly bounds: Bounds } | null
  readonly panes: readonly {
    readonly name: PreviewName
    readonly incarnation: number
    readonly native: ViewPresentationState | null
  }[]
  readonly overlay: ViewPresentationState | null
  readonly events: readonly {
    readonly sequence: number
    readonly elapsedMs: number
    readonly message: string
  }[]
  readonly discardedEvents: number
}

export function parseWorkbenchSnapshot(input: unknown): WorkbenchSnapshot {
  const row = object(input, [
    'phase',
    'heartbeat',
    'observedAtMs',
    'window',
    'panes',
    'overlay',
    'events',
    'discardedEvents',
  ])
  let window: WorkbenchSnapshot['window'] = null
  if (row['window'] !== null) {
    const value = object(row['window'], ['state', 'bounds'])
    const state = object(value['state'], [
      'visible',
      'active',
      'minimized',
      'maximized',
      'fullscreen',
    ])
    const bounds = object(value['bounds'], ['x', 'y', 'width', 'height'])
    window = {
      state: {
        visible: boolean(state['visible']),
        active: boolean(state['active']),
        minimized: boolean(state['minimized']),
        maximized: boolean(state['maximized']),
        fullscreen: boolean(state['fullscreen']),
      },
      bounds: {
        x: integer(bounds['x'], -2147483648, 2147483647),
        y: integer(bounds['y'], -2147483648, 2147483647),
        width: integer(bounds['width'], 0, 2147483647),
        height: integer(bounds['height'], 0, 2147483647),
      },
    }
  }
  const panes = row['panes'],
    events = row['events']
  if (!Array.isArray(panes) || panes.length !== 2 || !Array.isArray(events) || events.length > 48)
    throw new Error('Invalid workbench snapshot capacity')
  return {
    phase: member(row['phase'], ['starting', 'ready', 'closing']),
    heartbeat: integer(row['heartbeat'], 0, Number.MAX_SAFE_INTEGER),
    observedAtMs: integer(row['observedAtMs'], 0, Number.MAX_SAFE_INTEGER),
    window,
    panes: panes.map((value, index) => {
      const pane = object(value, ['name', 'incarnation', 'native'])
      if (pane['name'] !== previewNames[index]) throw new Error('Invalid workbench pane order')
      return {
        name: previewNames[index]!,
        incarnation: integer(pane['incarnation'], 0, Number.MAX_SAFE_INTEGER),
        native: pane['native'] === null ? null : parseViewPresentationState(pane['native']),
      }
    }),
    overlay: row['overlay'] === null ? null : parseViewPresentationState(row['overlay']),
    events: events.map((value) => {
      const event = object(value, ['sequence', 'elapsedMs', 'message'])
      if (
        typeof event['message'] !== 'string' ||
        event['message'].length > 240 ||
        [...event['message']].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Invalid workbench event')
      return {
        sequence: integer(event['sequence'], 1, Number.MAX_SAFE_INTEGER),
        elapsedMs: integer(event['elapsedMs'], 0, Number.MAX_SAFE_INTEGER),
        message: event['message'],
      }
    }),
    discardedEvents: integer(row['discardedEvents'], 0, Number.MAX_SAFE_INTEGER),
  }
}

export const workbenchSchema = defineRpc({
  snapshot: procedure((input: unknown): null => {
    if (input !== null) throw new Error('Snapshot takes no arguments')
    return null
  }, parseWorkbenchSnapshot),
  command: procedure(parseWorkbenchCommand, (input: unknown): null => {
    if (input !== null) throw new Error('Invalid workbench acknowledgement')
    return null
  }),
})
