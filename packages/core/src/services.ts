import type { ServicePolicy } from '@bun-native/protocol'

export type ServicePermissions = NonNullable<
  import('@bun-native/runtime').HostOptions['permissions']
>

export interface ServiceRequestOptions {
  /** Cancels queued dispatch or delivery of an already-dispatched, bounded native read. */
  readonly signal?: AbortSignal
}

export interface NativeDisplaySnapshot {
  /** GPUI-reported logical display bounds; coordinate origins depend on the backend. */
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>
  readonly scaleFactor: number
}

type UnavailableService = Readonly<{ availability: 'unavailable'; reason: 'not_implemented' }>

export interface ServiceCapabilities {
  readonly windowDisplay: Readonly<{
    availability: 'available'
    permission: 'allow' | 'deny'
    scope: 'owned_window'
  }>
  readonly clipboardText: UnavailableService
  readonly globalShortcuts: UnavailableService
  readonly systemMenus: UnavailableService
  readonly dialogs: UnavailableService
  readonly notifications: UnavailableService
  readonly dragDrop: UnavailableService
  readonly filesystemGrants: UnavailableService
  readonly ptyProcess: UnavailableService
}

export class NativeServiceError extends Error {
  override readonly name = 'NativeServiceError'
  readonly service = 'window_display'
  constructor(
    readonly code: 'permission_denied' | 'service_unavailable' | 'cancelled',
    message: string
  ) {
    super(message)
  }
}

const unavailable: UnavailableService = Object.freeze({
  availability: 'unavailable',
  reason: 'not_implemented',
})

export function serviceCapabilities(
  policy: Readonly<ServicePolicy>
): Readonly<ServiceCapabilities> {
  return Object.freeze({
    windowDisplay: Object.freeze({
      availability: 'available',
      permission: policy.window_display ? 'allow' : 'deny',
      scope: 'owned_window',
    }),
    clipboardText: unavailable,
    globalShortcuts: unavailable,
    systemMenus: unavailable,
    dialogs: unavailable,
    notifications: unavailable,
    dragDrop: unavailable,
    filesystemGrants: unavailable,
    ptyProcess: unavailable,
  })
}

export function serviceSignal(options: ServiceRequestOptions): AbortSignal | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Native service options must be an object')
  if (Object.keys(options).some((key) => key !== 'signal'))
    throw new TypeError('Unknown native service option')
  const signal = Object.hasOwn(options, 'signal') ? options.signal : undefined
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('Native service signal must be an AbortSignal')
  return signal
}

export function checkServiceCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new NativeServiceError(
      'cancelled',
      'Native display read was cancelled; no result is delivered'
    )
}
