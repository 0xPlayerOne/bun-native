/** Compile-only contract for core event, error and desktop-service exports not covered elsewhere. */
import {
  NativeCommandError,
  NativeServiceError,
  NativeStateError,
  ProtocolError,
  UnsupportedFeatureError,
  type ApplicationOptions,
  type ClickEvent,
  type ElementKind,
  type EventContext,
  type FocusEvent,
  type GlobalShortcutEvent,
  type GlobalShortcutKey,
  type GlobalShortcutOptions,
  type InputEvent,
  type InputState,
  type KeyEvent,
  type KeyModifiers,
  type Listener,
  type ListenerOptions,
  type NativeApplication,
  type NativeClipboardText,
  type NativeDisplaySnapshot,
  type NativeEventMap,
  type NativeEventType,
  type NativeGlobalShortcut,
  type NativeNode,
  type NativeNotification,
  type NativeUIEvent,
  type NativeWindow,
  type NotificationEvent,
  type NotificationOptions,
  type PointerButton,
  type PointerEvent,
  type ServiceCapabilities,
  type ServicePermissions,
  type ServiceRequestOptions,
  type Style,
  type WindowOptions,
} from '@bun-native/core'

export const kinds: readonly ElementKind[] = ['box', 'text', 'button', 'input']
// @ts-expect-error Element kinds are the closed native set.
export const webview: ElementKind = 'webview'

export const eventTypes: readonly NativeEventType[] = [
  'click',
  'input',
  'key_down',
  'key_up',
  'pointer_down',
  'pointer_up',
  'focus',
  'blur',
]
// @ts-expect-error DOM event names are not native event types.
export const domEvent: NativeEventType = 'pointer_move'

export const buttons: readonly PointerButton[] = ['left', 'right', 'middle', 'back', 'forward']
// @ts-expect-error Pointer buttons are named, not DOM button indices.
export const numericButton: PointerButton = 0

export function checkEvents(window: NativeWindow, box: NativeNode<'box'>): void {
  const options: ListenerOptions = { capture: true }
  const stopKey = window.on(
    box,
    'key_down',
    (event) => {
      const type: 'key_down' = event.type
      const modifiers: Readonly<KeyModifiers> = event.modifiers
      const fn: boolean = modifiers.function
      // @ts-expect-error Event modifiers are an immutable snapshot.
      event.modifiers.shift = true
      void [type, fn]
    },
    options
  )
  const stopPointer = window.on(box, 'pointer_up', (event) => {
    const button: PointerButton = event.button
    const coordinates: readonly [number, number] = [event.x, event.y]
    // @ts-expect-error Pointer events carry no keyboard key.
    void event.key
    void [button, coordinates]
  })
  const stopFocus = window.on(box, 'blur', async (event) => {
    const type: 'blur' = event.type
    const phase: 'capture' | 'target' | 'bubble' = event.phase
    await Promise.resolve()
    void [type, phase]
  })
  stopKey()
  stopPointer()
  stopFocus()

  // @ts-expect-error A listener for one event type cannot observe another's payload.
  window.on(box, 'click', (event: InputEvent) => void event.value)
  // @ts-expect-error Only native event types can be observed.
  window.on(box, 'pointer_move', () => {})
  // @ts-expect-error Capture is the only listener option and it is a boolean.
  window.on(box, 'focus', () => {}, { capture: 'yes' })
  // @ts-expect-error DOM listener options such as once are not supported.
  window.on(box, 'focus', () => {}, { once: true })
  // @ts-expect-error A listener returns nothing or a promise of nothing.
  window.on(box, 'focus', () => 'handled')
}

export function checkEventShapes(
  click: ClickEvent,
  input: InputEvent,
  key: KeyEvent,
  pointer: PointerEvent,
  focus: FocusEvent,
  context: EventContext<'text'>
): void {
  const button: NativeNode<'button'> = click.node
  const inputNode: NativeNode<'input'> = input.node
  const state: InputState = input
  const keyType: 'key_down' | 'key_up' = key.type
  const keyChar: string | undefined = key.keyChar
  const pointerType: 'pointer_down' | 'pointer_up' = pointer.type
  const focusType: 'focus' | 'blur' = focus.type
  const text: NativeNode<'text'> = context.node
  const path: readonly NativeNode[] = context.path
  const counters: readonly number[] = [context.treeRevision, context.sequence]
  const stopped: boolean = context.propagationStopped
  void [button, inputNode, state, keyType, keyChar, pointerType, focusType, text, path, counters]
  void stopped

  const union: NativeUIEvent = click
  const mapped: NativeEventMap['input'] = input
  const handler: Listener<NativeEventMap['click']> = async () => {}
  void [union, mapped, handler]

  // @ts-expect-error The event target cannot be reassigned.
  context.node = text
  // @ts-expect-error Propagation is stopped through the method, not by assignment.
  context.propagationStopped = true
  // @ts-expect-error Event paths are immutable.
  context.path.push(text)
  // @ts-expect-error Input state is an immutable observation.
  input.revision = 1
  // @ts-expect-error A click target is always a button handle.
  const wrongTarget: NativeNode<'input'> = click.node
  // @ts-expect-error The event map has no DOM change entry.
  const change: NativeEventMap['change'] = input
  // @ts-expect-error A key event is not a click event.
  const notClick: ClickEvent = key
  void [wrongTarget, notClick, change]
}

export function checkErrors(error: unknown): string | undefined {
  if (error instanceof NativeStateError) {
    const code: 'invalid_handle' | 'invalid_state' | 'stale_revision' | 'limit_exceeded' =
      error.code
    return code
  }
  if (error instanceof UnsupportedFeatureError) return error.feature
  if (error instanceof NativeServiceError) {
    const service:
      | 'window_display'
      | 'clipboard_read'
      | 'clipboard_write'
      | 'global_shortcuts'
      | 'notifications'
      | 'filesystem_grants'
      | 'processes'
      | 'file_dialogs'
      | 'drag_drop'
      | 'app_menu' = error.service
    return service + error.code
  }
  if (error instanceof NativeCommandError) {
    const requestId: number = error.requestId
    return error.code + requestId
  }
  if (error instanceof ProtocolError) return error.name
  return undefined
}

export const stateError = new NativeStateError('stale_revision', 'Edited concurrently')
// @ts-expect-error State error codes are a closed set.
export const unknownStateError = new NativeStateError('timeout', 'Not a state code')
export const serviceError = new NativeServiceError('notifications', 'conflict', 'Already posted')
// @ts-expect-error Service names are the implemented native services only.
export const unknownService = new NativeServiceError('dialogs', 'cancelled', 'No dialogs service')
// @ts-expect-error Native command errors use protocol error codes.
export const unknownCommand = new NativeCommandError('teapot', 1, 'Not a protocol code')
export function checkErrorReadonly(): void {
  // @ts-expect-error Error codes cannot be rewritten after construction.
  stateError.code = 'invalid_state'
  // @ts-expect-error The error name is a fixed discriminator.
  serviceError.name = 'Error'
}

export const permissions: ServicePermissions = {
  windowDisplay: 'deny',
  clipboardRead: 'allow',
  clipboardWrite: 'deny',
  globalShortcuts: 'allow',
  notifications: 'allow',
}
export function checkPermissions(): void {
  // @ts-expect-error Launch permissions are immutable once declared.
  permissions.notifications = 'deny'
}
// @ts-expect-error Unimplemented services cannot be granted at launch.
export const dialogsGrant: ServicePermissions = { dialogs: 'allow' }
// @ts-expect-error A grant is allow or deny, never prompt.
export const promptGrant: ServicePermissions = { globalShortcuts: 'prompt' }

export const launch: ApplicationOptions = {
  executable: '/absolute/prebuilt/host',
  args: ['--verbose'],
  requestTimeoutMs: 1_000,
  permissions,
}
// @ts-expect-error The prebuilt executable path is required.
export const missingExecutable: ApplicationOptions = { args: [] }
// @ts-expect-error Native process arguments are strings, passed without a shell.
export const numericArgs: ApplicationOptions = { executable: '/host', args: [1] }

export const windowOptions: WindowOptions = { title: 'Typed', width: 640, height: 480 }
// @ts-expect-error Every native window has a title.
export const untitled: WindowOptions = { width: 640 }
// @ts-expect-error Window dimensions are logical pixel numbers.
export const cssWindow: WindowOptions = { title: 'CSS', width: '640px' }

export const style: Style = { background: 0xffffff, color: 0, font_size: 14, padding: 4 }
// @ts-expect-error Colors are packed RGB integers, not CSS strings.
export const cssColor: Style = { color: '#fff' }

export function checkCapabilities(app: NativeApplication): void {
  const services: Readonly<ServiceCapabilities> = app.serviceCapabilities
  if (services.clipboardText.availability === 'available') {
    const backend: 'x11' = services.clipboardText.backend
    const read: 'allow' | 'deny' = services.clipboardText.read
    void [backend, read]
  } else {
    const reason: 'unsupported_platform' = services.clipboardText.reason
    void reason
  }
  if (services.notifications.availability === 'available') {
    const backend: 'freedesktop' = services.notifications.backend
    void backend
  }
  const menus: 'available' | 'unavailable' = services.appMenu.availability
  const pty: 'available' | 'unavailable' = services.ptyProcess.availability
  const diagnostics: number = app.diagnostics.serviceRequests + app.diagnostics.activeCallbacks
  const maxWindows: number = app.limits.max_windows
  void [menus, pty, diagnostics, maxWindows]

  // @ts-expect-error Unimplemented services report no permission.
  void services.dialogs.permission
  // @ts-expect-error The clipboard backend is known only when the service is available.
  void services.clipboardText.backend
  // @ts-expect-error Service capabilities are a negotiated, immutable record.
  services.windowDisplay = { availability: 'available', permission: 'allow', scope: 'owned_window' }
  // @ts-expect-error Diagnostics are an immutable snapshot.
  app.diagnostics.windows = 0
  // @ts-expect-error Negotiated limits are immutable.
  app.limits.max_windows = 64
}

export async function checkServices(window: NativeWindow): Promise<void> {
  const request: ServiceRequestOptions = { signal: AbortSignal.timeout(100) }
  const snapshot: NativeDisplaySnapshot = await window.displaySnapshot(request)
  const clipboard: NativeClipboardText = await window.readClipboardText()
  if (clipboard.kind === 'text') void clipboard.text
  // @ts-expect-error An empty clipboard result has no text.
  else void clipboard.text
  // @ts-expect-error The display bounds are immutable.
  snapshot.bounds = { x: 0, y: 0, width: 0, height: 0 }
  // @ts-expect-error Service request options accept only a cancellation signal.
  await window.readClipboardText({ timeout: 100 })
}

export async function checkShortcuts(window: NativeWindow): Promise<NativeGlobalShortcut> {
  const keys: readonly GlobalShortcutKey[] = ['a', 'z', '0', '9', 'f1', 'f12']
  const options: GlobalShortcutOptions = { key: 'k', control: true, shift: true }
  const shortcut = await window.registerGlobalShortcut(options, async (event) => {
    const type: 'global_shortcut' = event.type
    const owner: NativeGlobalShortcut = event.shortcut
    event.signal.throwIfAborted()
    void [type, owner]
  })
  const active: boolean = shortcut.active
  const platform: boolean = shortcut.modifiers.platform
  await shortcut.unregister()
  void [keys, active, platform]

  // @ts-expect-error Uppercase letters are not layout-level key names.
  const upper: GlobalShortcutKey = 'A'
  // @ts-expect-error Only f1 through f12 are function keys.
  const f13: GlobalShortcutKey = 'f13'
  // @ts-expect-error Named keys such as escape are not supported.
  const escape: GlobalShortcutKey = 'escape'
  // @ts-expect-error A shortcut names one key, not an accelerator string.
  await window.registerGlobalShortcut({ key: 'Ctrl+K' }, () => {})
  // @ts-expect-error Modifiers are explicit booleans.
  await window.registerGlobalShortcut({ key: 'k', control: 'yes' }, () => {})
  // @ts-expect-error A shortcut event has no notification payload.
  await window.registerGlobalShortcut(options, (event) => void event.notification)
  // @ts-expect-error A registration's active state is read-only.
  shortcut.active = true
  // @ts-expect-error A registration's modifiers are read-only.
  shortcut.modifiers.control = false
  const event = undefined as unknown as GlobalShortcutEvent
  // @ts-expect-error Event sequence numbers are read-only.
  event.sequence = 0
  void [upper, f13, escape]
  return shortcut
}

export async function checkNotifications(window: NativeWindow): Promise<NativeNotification> {
  const options: NotificationOptions = { title: 'Build finished', body: 'All checks passed' }
  const notification = await window.postNotification(options, (event) => {
    if (event.type === 'notification_dismissed') {
      const reason: 'expired' | 'dismissed' | 'closed' = event.reason
      void reason
    } else {
      const type: 'notification_activated' = event.type
      // @ts-expect-error Only a dismissal carries a reason.
      void event.reason
      void type
    }
  })
  const content: readonly [string, string] = [notification.title, notification.body]
  const flags: readonly [boolean, boolean] = [notification.activatable, notification.active]
  await notification.withdraw()
  void [content, flags]

  // @ts-expect-error Every notification has a title.
  await window.postNotification({ body: 'Untitled' }, () => {})
  // @ts-expect-error Notifications are plain text; no markup or icon option exists.
  await window.postNotification({ title: 'Icon', icon: 'dialog-information' }, () => {})
  // @ts-expect-error A notification listener receives notification events, not shortcuts.
  await window.postNotification(options, (event: GlobalShortcutEvent) => void event)
  // @ts-expect-error Notification content is fixed after posting.
  notification.title = 'Edited'
  const event = undefined as unknown as NotificationEvent
  // @ts-expect-error Notification events are immutable.
  event.type = 'notification_activated'
  // @ts-expect-error Notification options are read-only once declared.
  options.title = 'Changed'
  return notification
}
