import {
  ProtocolError,
  type Capability,
  type ClipboardText,
  type DisplaySnapshot,
  type ServicePolicy,
} from '@bun-native/protocol'

export type NativeClipboardText = Readonly<ClipboardText>
type ServiceName =
  | 'window_display'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'global_shortcuts'
  | 'notifications'

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
  /**
   * The display's work area (excluding the menu bar, Dock or taskbar), in the
   * same logical coordinates as `bounds`. Only when `windowDisplay.details`
   * is available (macOS and Windows).
   */
  readonly visibleBounds?: Readonly<{ x: number; y: number; width: number; height: number }>
  /**
   * The platform's display identifier when `windowDisplay.details` is
   * available and the OS reports one. macOS: the CoreGraphics display UUID.
   * Windows: derived from the GDI device name (for example `\\.\DISPLAY1`),
   * so it names an adapter output rather than a physical monitor.
   */
  readonly displayId?: string
}

export interface DisplayChangeEvent {
  readonly type: 'display_change'
  readonly sequence: number
  /** The window's display after the change. */
  readonly snapshot: NativeDisplaySnapshot
  /** Aborted when the listener is removed, its window closes or the app stops. */
  readonly signal: AbortSignal
}

type UnavailableService = Readonly<{ availability: 'unavailable'; reason: 'not_implemented' }>

export interface ServiceCapabilities {
  readonly windowDisplay: Readonly<{
    availability: 'available'
    permission: 'allow' | 'deny'
    scope: 'owned_window'
    /** Snapshots include `visibleBounds` and, when the OS reports it, `displayId`. */
    details: 'available' | 'unavailable'
    /** `onDisplayChange` reports display moves and OS display reconfiguration. */
    changes: 'available' | 'unavailable'
  }>
  readonly clipboardText:
    | Readonly<{
        availability: 'available'
        read: 'allow' | 'deny'
        write: 'allow' | 'deny'
        scope: 'owned_window'
        backend: 'x11'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly globalShortcuts:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'owned_window'
        backend: 'x11'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly systemMenus: UnavailableService
  readonly dialogs: UnavailableService
  readonly notifications:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'owned_window'
        backend: 'freedesktop'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly dragDrop: UnavailableService
  readonly filesystemGrants: UnavailableService
  readonly ptyProcess: UnavailableService
}

export class NativeServiceError extends Error {
  override readonly name = 'NativeServiceError'
  constructor(
    readonly service: ServiceName,
    readonly code:
      | 'permission_denied'
      | 'service_unavailable'
      | 'cancelled'
      | 'native_failure'
      | 'operation_timed_out'
      | 'payload_too_large'
      | 'limit_exceeded'
      | 'conflict',
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
  policy: Readonly<ServicePolicy>,
  capabilities: readonly Capability[]
): Readonly<ServiceCapabilities> {
  return Object.freeze({
    windowDisplay: Object.freeze({
      availability: 'available',
      permission: policy.window_display ? 'allow' : 'deny',
      scope: 'owned_window',
      details: capabilities.includes('display_details_v1') ? 'available' : 'unavailable',
      changes: capabilities.includes('display_changes_v1') ? 'available' : 'unavailable',
    }),
    clipboardText: capabilities.includes('clipboard_text_v1')
      ? Object.freeze({
          availability: 'available',
          read: policy.clipboard_read ? 'allow' : 'deny',
          write: policy.clipboard_write ? 'allow' : 'deny',
          scope: 'owned_window',
          backend: 'x11',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    globalShortcuts: capabilities.includes('global_shortcuts_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.global_shortcuts ? 'allow' : 'deny',
          scope: 'owned_window',
          backend: 'x11',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    systemMenus: unavailable,
    dialogs: unavailable,
    notifications: capabilities.includes('notifications_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.notifications ? 'allow' : 'deny',
          scope: 'owned_window',
          backend: 'freedesktop',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    dragDrop: unavailable,
    filesystemGrants: unavailable,
    ptyProcess: unavailable,
  })
}

/** A frozen public snapshot; details are accepted only from a host that advertised them. */
export function publicDisplaySnapshot(
  snapshot: DisplaySnapshot,
  capabilities: readonly Capability[]
): NativeDisplaySnapshot {
  const details = capabilities.includes('display_details_v1')
  if (details ? !snapshot.visible_bounds : snapshot.visible_bounds || snapshot.display_uuid)
    throw new ProtocolError('Native display details do not match the negotiated capabilities')
  return Object.freeze({
    bounds: Object.freeze({ ...snapshot.bounds }),
    scaleFactor: snapshot.scale_factor,
    ...(snapshot.visible_bounds
      ? { visibleBounds: Object.freeze({ ...snapshot.visible_bounds }) }
      : {}),
    ...(snapshot.display_uuid ? { displayId: snapshot.display_uuid } : {}),
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

export function checkServiceCancellation(
  signal: AbortSignal | undefined,
  service: ServiceName
): void {
  if (signal?.aborted)
    throw new NativeServiceError(
      service,
      'cancelled',
      'Native service read was cancelled; no result is delivered'
    )
}
