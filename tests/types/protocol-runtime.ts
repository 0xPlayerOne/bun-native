/** Compile-only contract for the protocol schema and runtime transport exports. */
import {
  DEFAULT_LIMITS,
  encodeFrame,
  ERROR_CODES,
  FrameDecoder,
  GLOBAL_SHORTCUT_KEYS,
  MAX_CLIPBOARD_BYTES,
  MAX_FRAME_BYTES,
  MAX_GLOBAL_SHORTCUTS,
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_TITLE_BYTES,
  MAX_NOTIFICATIONS,
  MAX_OPERATIONS,
  MAX_TEXT_BYTES,
  NOTIFICATION_DISMISSALS,
  parseCommand,
  parseElement,
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  REQUIRED_CAPABILITIES,
  type Capability,
  type ClipboardText,
  type Command,
  type Element,
  type ErrorCode,
  type KeyModifiers,
  type Limits,
  type NativeEvent,
  type NotificationDismissal,
  type Operation,
  type PointerButton,
  type ServicePolicy,
  type ShortcutModifiers,
  type Style,
} from '@bun-native/protocol'
import {
  NativeCommandError,
  NativeHost,
  type HostOptions,
  type HostResponse,
  type ServicePermissions,
  type WindowCommand,
  type WindowEvent,
} from '@bun-native/runtime'

export const sizes: readonly number[] = [
  MAX_CLIPBOARD_BYTES,
  MAX_FRAME_BYTES,
  MAX_GLOBAL_SHORTCUTS,
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_TITLE_BYTES,
  MAX_NOTIFICATIONS,
  MAX_OPERATIONS,
  MAX_TEXT_BYTES,
]
export const version: 9 = PROTOCOL_VERSION

export function checkFraming(bytes: Uint8Array): unknown[] {
  const frame: Uint8Array = encodeFrame({ type: 'ack', id: 1 })
  const decoder = new FrameDecoder()
  const messages: unknown[] = decoder.push(frame)
  decoder.push(bytes)
  decoder.finish()
  // @ts-expect-error The decoder consumes bytes, not decoded strings.
  decoder.push('{"type":"ack"}')
  const error: Error = new ProtocolError('Malformed frame')
  void error
  return messages
}

export function checkParsers(raw: unknown): void {
  const element: Element = parseElement(raw)
  const command: Command = parseCommand(raw)
  const event: NativeEvent = parseEvent(raw)
  void [element, command, event]
  // @ts-expect-error A parsed command is not a native event.
  const misrouted: NativeEvent = parseCommand(raw)
  void misrouted
}

export function checkConstants(): void {
  const limits: Readonly<Limits> = DEFAULT_LIMITS
  const frameLimit: number = limits.max_frame_bytes
  const code: ErrorCode = ERROR_CODES[0]
  const required: readonly Capability[] = REQUIRED_CAPABILITIES
  const dismissals: readonly NotificationDismissal[] = NOTIFICATION_DISMISSALS
  const keys: readonly string[] = GLOBAL_SHORTCUT_KEYS
  void [frameLimit, code, required, dismissals, keys]

  // @ts-expect-error Default limits are frozen.
  DEFAULT_LIMITS.max_operations = 1_024
  // @ts-expect-error The error code table is read-only.
  ERROR_CODES.push('teapot')
  // @ts-expect-error Required capabilities are frozen.
  REQUIRED_CAPABILITIES.push('clipboard_text_v1')
  // @ts-expect-error Dismissal reasons are frozen.
  NOTIFICATION_DISMISSALS[0] = 'closed'
  // @ts-expect-error Shortcut keys are frozen.
  GLOBAL_SHORTCUT_KEYS.push('escape')
}

export const capability: Capability = 'notifications_v1'
// @ts-expect-error Capabilities are the closed negotiated set.
export const unknownCapability: Capability = 'webgpu_v1'
export const errorCode: ErrorCode = 'conflict'
// @ts-expect-error Error codes are the closed protocol set.
export const unknownErrorCode: ErrorCode = 'teapot'
export const dismissal: NotificationDismissal = 'expired'
// @ts-expect-error Dismissal reasons are the closed freedesktop mapping.
export const unknownDismissal: NotificationDismissal = 'clicked'
export const pointer: PointerButton = 'back'
export const modifiers: KeyModifiers = {
  control: false,
  alt: false,
  shift: true,
  platform: false,
  function: false,
}
// @ts-expect-error Event modifiers state every flag, including function.
export const partialModifiers: KeyModifiers = {
  control: true,
  alt: false,
  shift: false,
  platform: false,
}
export const shortcutModifiers: ShortcutModifiers = {
  control: true,
  alt: false,
  shift: false,
  platform: false,
}
// @ts-expect-error Shortcut modifiers have no function-key flag.
export const fnShortcut: ShortcutModifiers = { ...shortcutModifiers, function: true }
export const policy: ServicePolicy = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: true,
  filesystem_roots: [],
}
// @ts-expect-error The wire policy is boolean, unlike the allow/deny launch option.
export const wirePolicy: ServicePolicy = { ...policy, notifications: 'allow' }
export const clipboard: ClipboardText = { kind: 'text', text: 'copied' }
// @ts-expect-error An empty clipboard result carries no text.
export const emptyWithText: ClipboardText = { kind: 'empty', text: '' }
export const protocolStyle: Style = { width: 'fill', min_height: 0 }
// @ts-expect-error Only width and height accept fill.
export const fillMinimum: Style = { min_width: 'fill' }

export const operations: readonly Operation[] = [
  { type: 'create', node_id: 2, element: { kind: 'input', value: '' } },
  { type: 'set', node_id: 3, element: { kind: 'text', text: 'Updated' } },
  {
    type: 'set',
    node_id: 2,
    element: { kind: 'input', value: 'Replacement' },
    expected_input_revision: 4,
  },
  { type: 'insert', parent_id: 1, child_id: 2, index: 0 },
  { type: 'delete', node_id: 3 },
]
// @ts-expect-error An input replacement on the wire requires its observed revision.
export const unversioned: Operation = {
  type: 'set',
  node_id: 2,
  element: { kind: 'input', value: '' },
}
// @ts-expect-error Insertion has no implicit append; the index is explicit.
export const appendOperation: Operation = { type: 'insert', parent_id: 1, child_id: 2 }
// @ts-expect-error Node ids are numbers, never native handle objects.
export const objectId: Operation = { type: 'delete', node_id: { kind: 'box' } }

export const hello: Command = { id: 1, type: 'hello', protocol: PROTOCOL_VERSION }
// @ts-expect-error A command names exactly the current protocol version.
export const oldHello: Command = { id: 1, type: 'hello', protocol: 7 }
// @ts-expect-error Every wire command carries a request id.
export const anonymous: Command = { type: 'shutdown' }

export function checkEventNarrowing(event: NativeEvent): void {
  switch (event.type) {
    case 'ready': {
      const policy: ServicePolicy = event.service_policy
      const limits: Limits = event.limits
      void [policy, limits]
      break
    }
    case 'input': {
      const state: readonly [string, number] = [event.value, event.input_revision]
      const path: readonly number[] = event.path
      void [state, path]
      break
    }
    case 'notification_dismissed': {
      const reason: NotificationDismissal = event.reason
      void reason
      break
    }
    case 'error': {
      const id: number | undefined = event.id
      // @ts-expect-error Some errors are not tied to a request id.
      const requestId: number = event.id
      void [id, requestId]
      break
    }
    case 'click':
      // @ts-expect-error Click events carry no input value.
      void event.value
      break
  }
}

export const permissions: ServicePermissions = { windowDisplay: 'allow', notifications: 'deny' }
export const hostOptions: HostOptions = {
  executable: '/absolute/prebuilt/host',
  args: ['--profile'],
  requestTimeoutMs: 5_000,
  permissions,
}
const booleanGrant = { notifications: true }
// @ts-expect-error Runtime permissions are explicit allow/deny policies.
export const booleanPermissions: HostOptions = { executable: '/host', permissions: booleanGrant }
// @ts-expect-error The request timeout is milliseconds as a number.
export const stringTimeout: HostOptions = { executable: '/host', requestTimeoutMs: '5s' }

export const windowCommands: readonly WindowCommand[] = [
  { type: 'open', window_id: 1, root_id: 1, title: 'Window', width: 640, height: 480 },
  { type: 'clipboard_write', window_id: 1, text: 'copy' },
  { type: 'withdraw_notification', window_id: 1, notification_id: 3 },
]
// @ts-expect-error Request ids are assigned by the host, not the caller.
export const withId: WindowCommand = { id: 7, type: 'close', window_id: 1 }
// @ts-expect-error Protocol negotiation is private to the host.
export const helloCommand: WindowCommand = { type: 'hello', protocol: PROTOCOL_VERSION }
// @ts-expect-error Process shutdown uses NativeHost.shutdown, not send.
export const shutdownCommand: WindowCommand = { type: 'shutdown' }

export function checkResponses(response: HostResponse, event: WindowEvent): void {
  // @ts-expect-error The ready handshake is never a command response.
  const ready: Extract<HostResponse, { type: 'ready' }>['type'] = 'ready'
  // @ts-expect-error Request responses are not ordered window events.
  const ack: WindowEvent = { type: 'ack', id: 1 }
  const sequence: number = event.sequence
  const windowId: number = event.window_id
  void [response, ready, ack, sequence, windowId]
}

export async function checkHost(): Promise<void> {
  const host: NativeHost = await NativeHost.launch(hostOptions)
  const limits: Readonly<Limits> = host.limits
  const servicePolicy: Readonly<ServicePolicy> = host.servicePolicy
  const capabilities: readonly Capability[] = host.capabilities
  const exitCode: Promise<number> = host.exited
  void [limits, servicePolicy, capabilities, exitCode]

  const opened = await host.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Typed',
    width: 320,
    height: 240,
  })
  const treeRevision: number = opened.tree_revision
  const snapshot = await host.send({ type: 'display_snapshot', window_id: 1 })
  const scale: number = snapshot.snapshot.scale_factor
  const read = await host.send({ type: 'clipboard_read', window_id: 1 })
  const result: ClipboardText = read.result
  const posted = await host.send({
    type: 'post_notification',
    window_id: 1,
    notification_id: 1,
    title: 'Title',
    body: '',
  })
  const activatable: boolean = posted.activatable
  void [treeRevision, scale, result, activatable]

  for await (const event of host) {
    const sequence: number = event.sequence
    void sequence
    break
  }
  await host.shutdown()

  // @ts-expect-error The constructor is private; hosts are launched and negotiated.
  void new NativeHost(hostOptions, policy)
  // @ts-expect-error The hello handshake is not a sendable window command.
  await host.send({ type: 'hello', protocol: PROTOCOL_VERSION })
  // @ts-expect-error A close acknowledgement is not a clipboard result.
  const wrongResponse: ClipboardText = (await host.send({ type: 'close', window_id: 1 })).result
  // @ts-expect-error Negotiated limits are immutable.
  host.limits.max_operations = 1
  // @ts-expect-error Negotiated capabilities are immutable.
  host.capabilities.push('tree')
  // @ts-expect-error The exit promise cannot be replaced.
  host.exited = Promise.resolve(0)
  void wrongResponse

  const failure = new NativeCommandError('stale_revision', 4, 'Revision moved')
  const failedRequest: number = failure.requestId
  void failedRequest
  // @ts-expect-error Command failures keep their request id.
  failure.requestId = 5
}
