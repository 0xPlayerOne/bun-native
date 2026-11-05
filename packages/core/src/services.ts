import type { Capability, ClipboardText, ServicePolicy } from '@bun-native/protocol'

export type NativeClipboardText = Readonly<ClipboardText>
type ServiceName =
  | 'window_display'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'global_shortcuts'
  | 'notifications'
  | 'filesystem_grants'
  | 'processes'

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
  readonly filesystemGrants:
    | Readonly<{
        availability: 'available'
        /** Launch roots by ID; each caps the access a grant may request. */
        roots: Readonly<Record<string, Readonly<{ access: 'read' | 'read_write' }>>>
        scope: 'owned_window'
        /** Linux resolves with `openat2`; macOS walks one name at a time with `openat(O_NOFOLLOW)`. */
        backend: 'openat2' | 'openat_walk'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly ptyProcess:
    | Readonly<{
        availability: 'available'
        /** Launch-policy executables by ID; nothing else can be started. */
        executables: Readonly<Record<string, Readonly<{ executable: string }>>>
        scope: 'owned_window'
        backend: 'posix'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
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
      | 'conflict'
      | 'not_found'
      | 'already_exists'
      | 'path_denied'
      | 'wrong_kind'
      | 'not_empty'
      | 'access_denied'
      | 'invalid_state',
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
    filesystemGrants: capabilities.includes('filesystem_grants_v1')
      ? Object.freeze({
          availability: 'available',
          roots: Object.freeze(
            Object.fromEntries(
              policy.filesystem_roots.map((root) => [
                root.id,
                Object.freeze({ access: root.access }),
              ])
            )
          ),
          scope: 'owned_window',
          backend: process.platform === 'darwin' ? 'openat_walk' : 'openat2',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    ptyProcess: capabilities.includes('processes_v1')
      ? Object.freeze({
          availability: 'available',
          executables: Object.freeze(
            Object.fromEntries(
              policy.processes.map((entry) => [
                entry.id,
                Object.freeze({ executable: entry.executable }),
              ])
            )
          ),
          scope: 'owned_window',
          backend: 'posix',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
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
