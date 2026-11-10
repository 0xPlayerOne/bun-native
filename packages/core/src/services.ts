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
  | 'filesystem_grants'
  | 'processes'
  | 'file_dialogs'
  | 'message_dialogs'
  | 'context_menus'
  | 'drag_drop'
  | 'app_menu'

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
  /**
   * The application menu bar: a native NSMenu bar on macOS. GPUI's Linux and
   * Windows backends only store menus, so they report it unavailable. OS
   * context menus are a separate service (`contextMenus`).
   */
  readonly appMenu:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'application'
        backend: 'appkit'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  /**
   * `window.showContextMenu`: an OS context menu at a point of the window, an
   * `NSMenu` on macOS and a Win32 popup menu on Windows. It needs no grant.
   */
  readonly contextMenus:
    | Readonly<{
        availability: 'available'
        scope: 'owned_window'
        backend: 'appkit' | 'win32'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  /** OS file open/save/folder dialogs. Selected paths are data, not filesystem grants. */
  readonly fileDialogs:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'owned_window'
        backend: 'xdg_desktop_portal'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  /**
   * `showMessageDialog`/`showConfirmDialog`: an in-window modal overlay drawn
   * by core on every platform and needing no launch grant, or, when the host
   * advertises `task_dialogs_v1` and `permissions.taskDialogs` is `allow`, an
   * OS dialog owned by the window: a task dialog on Windows, an `NSAlert`
   * sheet on macOS.
   */
  readonly messageDialogs:
    | Readonly<{
        availability: 'available'
        scope: 'owned_window'
        backend: 'modal_overlay' | 'task_dialog' | 'alert_sheet'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_host' }>
  readonly notifications:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'owned_window'
        backend: 'freedesktop'
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly dragDrop:
    | Readonly<{
        availability: 'available'
        permission: 'allow' | 'deny'
        scope: 'owned_target'
        /** Local files only, delivered as untrusted display names. */
        payload: 'files'
        /** GPUI's X11 XDND target, AppKit dragging destination or OLE drop target. */
        backend: DropBackend
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly filesystemGrants:
    | Readonly<{
        availability: 'available'
        /** Launch roots by ID; each caps the access a grant may request. */
        roots: Readonly<Record<string, Readonly<{ access: 'read' | 'read_write' }>>>
        scope: 'owned_window'
        /**
         * Linux resolves with `openat2`; macOS walks one name at a time with
         * `openat(O_NOFOLLOW)`; Windows walks one name at a time with
         * handle-relative `NtCreateFile` that never follows a reparse point.
         */
        backend: FilesystemBackend
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
  readonly ptyProcess:
    | Readonly<{
        availability: 'available'
        /** Launch-policy executables by ID; nothing else can be started. */
        executables: Readonly<
          Record<
            string,
            Readonly<{
              executable: string
              /** Limits every child of this entry runs under, when the launch policy set any. */
              limits?: Readonly<{ cpuSeconds?: number; memoryBytes?: number; openFiles?: number }>
            }>
          >
        >
        scope: 'owned_window'
        /** POSIX process groups and PTYs, or Windows job objects and ConPTY. */
        backend: ProcessBackend
      }>
    | Readonly<{ availability: 'unavailable'; reason: 'unsupported_platform' }>
}

type DropBackend = 'x11' | 'appkit' | 'ole'
type FilesystemBackend = 'openat2' | 'openat_walk' | 'ntcreatefile_walk'
type ProcessBackend = 'posix' | 'windows_job'

/** The confinement the host on this platform enforces for filesystem grants. */
function filesystemBackend(): FilesystemBackend {
  if (process.platform === 'darwin') return 'openat_walk'
  return process.platform === 'win32' ? 'ntcreatefile_walk' : 'openat2'
}

/** The host runs beside the core, so its platform names the OS dialog backend. */
function osDialogBackend(): 'task_dialog' | 'alert_sheet' {
  return process.platform === 'darwin' ? 'alert_sheet' : 'task_dialog'
}

/** The host runs beside the core, so its platform names the drop backend. */
function dropBackend(): DropBackend {
  if (process.platform === 'darwin') return 'appkit'
  if (process.platform === 'win32') return 'ole'
  return 'x11'
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
    contextMenus: capabilities.includes('context_menus_v1')
      ? Object.freeze({
          availability: 'available',
          scope: 'owned_window',
          // The host runs beside the core, so its platform names the backend.
          backend: process.platform === 'darwin' ? 'appkit' : 'win32',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    appMenu: capabilities.includes('app_menu_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.app_menu ? 'allow' : 'deny',
          scope: 'application',
          backend: 'appkit',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    fileDialogs: capabilities.includes('file_dialogs_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.file_dialogs ? 'allow' : 'deny',
          scope: 'owned_window',
          backend: 'xdg_desktop_portal',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    // The modal overlay and a focus request are the only native features used.
    messageDialogs:
      capabilities.includes('overlays_v1') && capabilities.includes('focus_v1')
        ? Object.freeze({
            availability: 'available',
            scope: 'owned_window',
            // The OS backend needs both the host capability and the grant.
            backend:
              capabilities.includes('task_dialogs_v1') && policy.task_dialogs
                ? osDialogBackend()
                : 'modal_overlay',
          })
        : Object.freeze({ availability: 'unavailable', reason: 'unsupported_host' }),
    notifications: capabilities.includes('notifications_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.notifications ? 'allow' : 'deny',
          scope: 'owned_window',
          backend: 'freedesktop',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    dragDrop: capabilities.includes('drag_drop_files_v1')
      ? Object.freeze({
          availability: 'available',
          permission: policy.drag_drop ? 'allow' : 'deny',
          scope: 'owned_target',
          payload: 'files',
          backend: dropBackend(),
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
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
          backend: filesystemBackend(),
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
    ptyProcess: capabilities.includes('processes_v1')
      ? Object.freeze({
          availability: 'available',
          executables: Object.freeze(
            Object.fromEntries(
              policy.processes.map((entry) => [
                entry.id,
                Object.freeze({
                  executable: entry.executable,
                  ...(entry.limits && {
                    limits: Object.freeze({
                      ...(entry.limits.cpu_seconds !== undefined && {
                        cpuSeconds: entry.limits.cpu_seconds,
                      }),
                      ...(entry.limits.memory_bytes !== undefined && {
                        memoryBytes: entry.limits.memory_bytes,
                      }),
                      ...(entry.limits.open_files !== undefined && {
                        openFiles: entry.limits.open_files,
                      }),
                    }),
                  }),
                }),
              ])
            )
          ),
          scope: 'owned_window',
          backend: process.platform === 'win32' ? 'windows_job' : 'posix',
        })
      : Object.freeze({ availability: 'unavailable', reason: 'unsupported_platform' }),
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
