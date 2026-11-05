import { parseElement, type Element } from './elements.ts'
import { MAX_FRAME_BYTES, ProtocolError } from './framing.ts'
import {
  parseDisplaySnapshot,
  parseClipboardText,
  parseServicePolicy,
  parseShortcutKey,
  parseShortcutModifiers,
  parseNotificationContent,
  parseNotificationDismissal,
  MAX_CLIPBOARD_BYTES,
  MAX_GLOBAL_SHORTCUTS,
  MAX_NOTIFICATIONS,
  MAX_SERVICE_REQUESTS,
  type ClipboardText,
  type DisplaySnapshot,
  type NotificationDismissal,
  type ServicePolicy,
  type ShortcutModifiers,
} from './services.ts'
import {
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_GRANTS,
  parseFileAccess,
  parseFileOperation,
  parseFilePath,
  parseFileResult,
  parseRootId,
  type FileAccess,
  type FileOperation,
  type FileResult,
} from './files.ts'
import {
  MAX_PROCESSES,
  parseProcessExit,
  parseProcessLaunch,
  parseProcessOutput,
  parseProcessSignal,
  parseProcessStream,
  parseTerminalSize,
  type ProcessExit,
  type ProcessLaunch,
  type ProcessSignal,
  type ProcessStream,
  type TerminalSize,
} from './processes.ts'
import {
  id,
  integer,
  keys,
  MAX_TEXT_BYTES,
  MAX_TITLE_BYTES,
  number,
  object,
  string,
} from './values.ts'

export const PROTOCOL_VERSION = 10
export const MAX_OPERATIONS = 256
const MAX_NODES_PER_WINDOW = 4_096
const MAX_WINDOWS = 16
const MAX_DEPTH = 64
const MAX_TEXT_BYTES_PER_WINDOW = 4_194_304

export interface Limits {
  max_frame_bytes: number
  max_operations: number
  max_nodes_per_window: number
  max_windows: number
  max_depth: number
  max_text_bytes: number
  max_text_bytes_per_window: number
  max_clipboard_bytes: number
  max_service_requests: number
  max_global_shortcuts: number
  max_notifications: number
  max_file_grants: number
  max_file_chunk_bytes: number
  max_processes: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  max_frame_bytes: MAX_FRAME_BYTES,
  max_operations: MAX_OPERATIONS,
  max_nodes_per_window: MAX_NODES_PER_WINDOW,
  max_windows: MAX_WINDOWS,
  max_depth: MAX_DEPTH,
  max_text_bytes: MAX_TEXT_BYTES,
  max_text_bytes_per_window: MAX_TEXT_BYTES_PER_WINDOW,
  max_clipboard_bytes: MAX_CLIPBOARD_BYTES,
  max_service_requests: MAX_SERVICE_REQUESTS,
  max_global_shortcuts: MAX_GLOBAL_SHORTCUTS,
  max_notifications: MAX_NOTIFICATIONS,
  max_file_grants: MAX_FILE_GRANTS,
  max_file_chunk_bytes: MAX_FILE_CHUNK_BYTES,
  max_processes: MAX_PROCESSES,
})

export type Operation =
  | { type: 'create'; node_id: number; element: Element }
  | { type: 'set'; node_id: number; element: Exclude<Element, { kind: 'input' }> }
  | {
      type: 'set'
      node_id: number
      element: Extract<Element, { kind: 'input' }>
      expected_input_revision: number
    }
  | { type: 'insert'; parent_id: number; child_id: number; index: number }
  | { type: 'delete'; node_id: number }

export type Command =
  | { id: number; type: 'hello'; protocol: typeof PROTOCOL_VERSION }
  | {
      id: number
      type: 'open'
      window_id: number
      root_id: number
      title: string
      width: number
      height: number
    }
  | {
      id: number
      type: 'batch'
      window_id: number
      base_revision: number
      operations: readonly Operation[]
    }
  | { id: number; type: 'close'; window_id: number }
  | { id: number; type: 'display_snapshot'; window_id: number }
  | { id: number; type: 'clipboard_read'; window_id: number }
  | { id: number; type: 'clipboard_write'; window_id: number; text: string }
  | {
      id: number
      type: 'register_global_shortcut'
      window_id: number
      shortcut_id: number
      key: string
      modifiers: ShortcutModifiers
    }
  | { id: number; type: 'unregister_global_shortcut'; window_id: number; shortcut_id: number }
  | {
      id: number
      type: 'post_notification'
      window_id: number
      notification_id: number
      title: string
      body: string
    }
  | { id: number; type: 'withdraw_notification'; window_id: number; notification_id: number }
  | {
      id: number
      type: 'open_file_grant'
      window_id: number
      grant_id: number
      root: string
      access: FileAccess
    }
  | { id: number; type: 'close_file_grant'; window_id: number; grant_id: number }
  | {
      id: number
      type: 'file_request'
      window_id: number
      grant_id: number
      path: string
      operation: FileOperation
    }
  | {
      id: number
      type: 'spawn_process'
      window_id: number
      process_id: number
      launch: ProcessLaunch
    }
  | { id: number; type: 'write_process'; window_id: number; process_id: number; data: string }
  | { id: number; type: 'close_process_input'; window_id: number; process_id: number }
  | {
      id: number
      type: 'resize_process'
      window_id: number
      process_id: number
      size: TerminalSize
    }
  | {
      id: number
      type: 'signal_process'
      window_id: number
      process_id: number
      signal: ProcessSignal
    }
  | {
      id: number
      type: 'acknowledge_process_output'
      window_id: number
      process_id: number
      chunk: number
    }
  | { id: number; type: 'release_process'; window_id: number; process_id: number }
  | { id: number; type: 'shutdown' }

export const ERROR_CODES = [
  'invalid_command',
  'version_mismatch',
  'invalid_state',
  'invalid_handle',
  'stale_revision',
  'limit_exceeded',
  'native_failure',
  'permission_denied',
  'service_unavailable',
  'cancelled',
  'operation_timed_out',
  'payload_too_large',
  'conflict',
  'not_found',
  'already_exists',
  'path_denied',
  'wrong_kind',
  'not_empty',
  'access_denied',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
export const REQUIRED_CAPABILITIES = Object.freeze([
  'tree',
  'input_revisions',
  'layout_v1',
  'interactions_v1',
  'window_display_v1',
] as const)
const CAPABILITIES = [
  ...REQUIRED_CAPABILITIES,
  'clipboard_text_v1',
  'global_shortcuts_v1',
  'notifications_v1',
  'filesystem_grants_v1',
  'processes_v1',
  'split_v1',
  'style_decoration_v1',
] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface KeyModifiers {
  control: boolean
  alt: boolean
  shift: boolean
  platform: boolean
  function: boolean
}

export type PointerButton = 'left' | 'right' | 'middle' | 'back' | 'forward'

interface NodeEventRoute {
  sequence: number
  window_id: number
  node_id: number
  tree_revision: number
  /** Native committed ancestry, root first and target last. MAX_DEPTH counts edges. */
  path: readonly number[]
}

type RoutedEvent = NodeEventRoute &
  (
    | { type: 'click' }
    | { type: 'focus' }
    | { type: 'blur' }
    | { type: 'input'; value: string; input_revision: number }
    | { type: 'key_down'; key: string; key_char?: string; modifiers: KeyModifiers }
    | { type: 'key_up'; key: string; key_char?: string; modifiers: KeyModifiers }
    | { type: 'pointer_down'; button: PointerButton; x: number; y: number; modifiers: KeyModifiers }
    | { type: 'pointer_up'; button: PointerButton; x: number; y: number; modifiers: KeyModifiers }
  )

export type NativeEvent =
  | {
      type: 'ready'
      protocol: typeof PROTOCOL_VERSION
      capabilities: Capability[]
      limits: Limits
      service_policy: ServicePolicy
    }
  | { type: 'ack'; id: number }
  | { type: 'opened'; id: number; window_id: number; root_id: number; tree_revision: number }
  | { type: 'applied'; id: number; window_id: number; tree_revision: number }
  | { type: 'display_snapshot'; id: number; window_id: number; snapshot: DisplaySnapshot }
  | { type: 'clipboard_text'; id: number; window_id: number; result: ClipboardText }
  | { type: 'clipboard_written'; id: number; window_id: number }
  | { type: 'global_shortcut_registered'; id: number; window_id: number; shortcut_id: number }
  | { type: 'global_shortcut_unregistered'; id: number; window_id: number; shortcut_id: number }
  | RoutedEvent
  | { type: 'global_shortcut'; sequence: number; window_id: number; shortcut_id: number }
  | {
      type: 'notification_posted'
      id: number
      window_id: number
      notification_id: number
      activatable: boolean
    }
  | { type: 'notification_withdrawn'; id: number; window_id: number; notification_id: number }
  | { type: 'notification_activated'; sequence: number; window_id: number; notification_id: number }
  | {
      type: 'notification_dismissed'
      sequence: number
      window_id: number
      notification_id: number
      reason: NotificationDismissal
    }
  | { type: 'file_grant_opened'; id: number; window_id: number; grant_id: number }
  | { type: 'file_grant_closed'; id: number; window_id: number; grant_id: number }
  | { type: 'file_result'; id: number; window_id: number; grant_id: number; result: FileResult }
  | { type: 'process_spawned'; id: number; window_id: number; process_id: number }
  | { type: 'process_updated'; id: number; window_id: number; process_id: number }
  | { type: 'process_released'; id: number; window_id: number; process_id: number }
  | {
      type: 'process_output'
      sequence: number
      window_id: number
      process_id: number
      chunk: number
      stream: ProcessStream
      data: string
    }
  | {
      type: 'process_exited'
      sequence: number
      window_id: number
      process_id: number
      exit: ProcessExit
    }
  | { type: 'closed'; sequence: number; window_id: number }
  | { type: 'error'; id?: number; code: ErrorCode; message: string }

function version(value: unknown): typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolError('Native protocol version mismatch')
  return PROTOCOL_VERSION
}

function operation(value: unknown): Operation {
  const data = object(value)
  switch (data['type']) {
    case 'create':
      keys(data, ['type', 'node_id', 'element'])
      return {
        type: 'create',
        node_id: id(data['node_id']),
        element: parseElement(data['element']),
      }
    case 'set': {
      keys(data, ['type', 'node_id', 'element', 'expected_input_revision'])
      const node_id = id(data['node_id'])
      const element = parseElement(data['element'])
      if (element.kind === 'input')
        return {
          type: 'set',
          node_id,
          element,
          expected_input_revision: integer(data['expected_input_revision'], 'input revision'),
        }
      if ('expected_input_revision' in data)
        throw new ProtocolError('Only input elements accept an input revision')
      return { type: 'set', node_id, element }
    }
    case 'insert':
      keys(data, ['type', 'parent_id', 'child_id', 'index'])
      return {
        type: 'insert',
        parent_id: id(data['parent_id']),
        child_id: id(data['child_id']),
        index: integer(data['index'], 'index', 0, MAX_NODES_PER_WINDOW),
      }
    case 'delete':
      keys(data, ['type', 'node_id'])
      return { type: 'delete', node_id: id(data['node_id']) }
    default:
      throw new ProtocolError('Unknown native operation')
  }
}

/** Validate before crossing the native boundary, including JavaScript callers. */
export function parseCommand(value: unknown): Command {
  const message = object(value)
  const request = id(message['id'])
  switch (message['type']) {
    case 'hello':
      keys(message, ['id', 'type', 'protocol'])
      return { id: request, type: 'hello', protocol: version(message['protocol']) }
    case 'open': {
      keys(message, ['id', 'type', 'window_id', 'root_id', 'title', 'width', 'height'])
      const title = string(message['title'], 'title', MAX_TITLE_BYTES)
      if (!title || /\p{Cc}/u.test(title))
        throw new ProtocolError('Window title must be nonempty and contain no control characters')
      return {
        id: request,
        type: 'open',
        window_id: id(message['window_id']),
        root_id: id(message['root_id']),
        title,
        width: number(message['width'], 'width', 64, 16_384),
        height: number(message['height'], 'height', 64, 16_384),
      }
    }
    case 'batch': {
      keys(message, ['id', 'type', 'window_id', 'base_revision', 'operations'])
      const operations = message['operations']
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS)
        throw new ProtocolError(
          'Batch must contain between 1 and ' + MAX_OPERATIONS + ' operations'
        )
      return {
        id: request,
        type: 'batch',
        window_id: id(message['window_id']),
        base_revision: integer(message['base_revision'], 'tree revision'),
        operations: operations.map(operation),
      }
    }
    case 'close':
    case 'display_snapshot':
    case 'clipboard_read':
      keys(message, ['id', 'type', 'window_id'])
      return { id: request, type: message['type'], window_id: id(message['window_id']) }
    case 'clipboard_write':
      keys(message, ['id', 'type', 'window_id', 'text'])
      return {
        id: request,
        type: 'clipboard_write',
        window_id: id(message['window_id']),
        text: string(message['text'], 'clipboard text', MAX_CLIPBOARD_BYTES),
      }
    case 'register_global_shortcut':
      keys(message, ['id', 'type', 'window_id', 'shortcut_id', 'key', 'modifiers'])
      return {
        id: request,
        type: 'register_global_shortcut',
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
        key: parseShortcutKey(message['key']),
        modifiers: parseShortcutModifiers(message['modifiers']),
      }
    case 'unregister_global_shortcut':
      keys(message, ['id', 'type', 'window_id', 'shortcut_id'])
      return {
        id: request,
        type: 'unregister_global_shortcut',
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'post_notification': {
      keys(message, ['id', 'type', 'window_id', 'notification_id', 'title', 'body'])
      const { title, body } = parseNotificationContent(message['title'], message['body'])
      return {
        id: request,
        type: 'post_notification',
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
        title,
        body,
      }
    }
    case 'withdraw_notification':
      keys(message, ['id', 'type', 'window_id', 'notification_id'])
      return {
        id: request,
        type: 'withdraw_notification',
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'open_file_grant':
      keys(message, ['id', 'type', 'window_id', 'grant_id', 'root', 'access'])
      return {
        id: request,
        type: 'open_file_grant',
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
        root: parseRootId(message['root']),
        access: parseFileAccess(message['access']),
      }
    case 'close_file_grant':
      keys(message, ['id', 'type', 'window_id', 'grant_id'])
      return {
        id: request,
        type: 'close_file_grant',
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
      }
    case 'file_request': {
      keys(message, ['id', 'type', 'window_id', 'grant_id', 'path', 'operation'])
      const path = parseFilePath(message['path'])
      return {
        id: request,
        type: 'file_request',
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
        path,
        operation: parseFileOperation(message['operation'], path),
      }
    }
    case 'spawn_process':
      keys(message, ['id', 'type', 'window_id', 'process_id', 'launch'])
      return {
        id: request,
        type: 'spawn_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        launch: parseProcessLaunch(message['launch']),
      }
    case 'write_process':
      keys(message, ['id', 'type', 'window_id', 'process_id', 'data'])
      return {
        id: request,
        type: 'write_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        data: parseProcessOutput(message['data']),
      }
    case 'close_process_input':
    case 'release_process':
      keys(message, ['id', 'type', 'window_id', 'process_id'])
      return {
        id: request,
        type: message['type'],
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
      }
    case 'resize_process':
      keys(message, ['id', 'type', 'window_id', 'process_id', 'size'])
      return {
        id: request,
        type: 'resize_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        size: parseTerminalSize(message['size']),
      }
    case 'signal_process':
      keys(message, ['id', 'type', 'window_id', 'process_id', 'signal'])
      return {
        id: request,
        type: 'signal_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        signal: parseProcessSignal(message['signal']),
      }
    case 'acknowledge_process_output':
      keys(message, ['id', 'type', 'window_id', 'process_id', 'chunk'])
      return {
        id: request,
        type: 'acknowledge_process_output',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        chunk: id(message['chunk']),
      }
    case 'shutdown':
      keys(message, ['id', 'type'])
      return { id: request, type: 'shutdown' }
    default:
      throw new ProtocolError('Unknown native command')
  }
}

function limits(value: unknown): Limits {
  const data = object(value)
  keys(data, Object.keys(DEFAULT_LIMITS))
  const parse = (key: keyof Limits) => integer(data[key], key, 1, DEFAULT_LIMITS[key])
  return {
    max_frame_bytes: parse('max_frame_bytes'),
    max_operations: parse('max_operations'),
    max_nodes_per_window: parse('max_nodes_per_window'),
    max_windows: parse('max_windows'),
    max_depth: parse('max_depth'),
    max_text_bytes: parse('max_text_bytes'),
    max_text_bytes_per_window: parse('max_text_bytes_per_window'),
    max_clipboard_bytes: parse('max_clipboard_bytes'),
    max_service_requests: parse('max_service_requests'),
    max_global_shortcuts: parse('max_global_shortcuts'),
    max_notifications: parse('max_notifications'),
    max_file_grants: parse('max_file_grants'),
    max_file_chunk_bytes: parse('max_file_chunk_bytes'),
    max_processes: parse('max_processes'),
  }
}

const ROUTE_KEYS = ['type', 'sequence', 'window_id', 'node_id', 'tree_revision', 'path'] as const

function route(message: Record<string, unknown>): NodeEventRoute {
  const node_id = id(message['node_id'])
  const value = message['path']
  if (!Array.isArray(value) || !value.length || value.length > MAX_DEPTH + 1)
    throw new ProtocolError('Native event path must contain between 1 and 65 node identities')
  const path = value.map(id)
  if (new Set(path).size !== path.length || path.at(-1) !== node_id)
    throw new ProtocolError('Native event path must be unique and end at its target')
  return {
    sequence: id(message['sequence']),
    window_id: id(message['window_id']),
    node_id,
    tree_revision: integer(message['tree_revision'], 'tree revision'),
    path,
  }
}

function modifiers(value: unknown): KeyModifiers {
  const data = object(value)
  keys(data, ['control', 'alt', 'shift', 'platform', 'function'])
  const modifier = (name: keyof KeyModifiers) => {
    if (typeof data[name] !== 'boolean') throw new ProtocolError('Invalid native key modifier')
    return data[name]
  }
  return {
    control: modifier('control'),
    alt: modifier('alt'),
    shift: modifier('shift'),
    platform: modifier('platform'),
    function: modifier('function'),
  }
}

/** Native stdout is untrusted until its message shape and limits are checked. */
export function parseEvent(value: unknown): NativeEvent {
  const message = object(value)
  switch (message['type']) {
    case 'ready': {
      keys(message, ['type', 'protocol', 'capabilities', 'limits', 'service_policy'])
      const capabilities = message['capabilities']
      if (!Array.isArray(capabilities) || capabilities.length > CAPABILITIES.length)
        throw new ProtocolError('Invalid native capabilities')
      const parsed: Capability[] = []
      for (const value of capabilities) {
        const capability = CAPABILITIES.find((candidate) => candidate === value)
        if (!capability || parsed.includes(capability))
          throw new ProtocolError('Unknown or duplicate native capability')
        parsed.push(capability)
      }
      return {
        type: 'ready',
        protocol: version(message['protocol']),
        capabilities: parsed,
        limits: limits(message['limits']),
        service_policy: parseServicePolicy(message['service_policy']),
      }
    }
    case 'ack':
      keys(message, ['type', 'id'])
      return { type: 'ack', id: id(message['id']) }
    case 'opened':
      keys(message, ['type', 'id', 'window_id', 'root_id', 'tree_revision'])
      return {
        type: 'opened',
        id: id(message['id']),
        window_id: id(message['window_id']),
        root_id: id(message['root_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'applied':
      keys(message, ['type', 'id', 'window_id', 'tree_revision'])
      return {
        type: 'applied',
        id: id(message['id']),
        window_id: id(message['window_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'display_snapshot':
      keys(message, ['type', 'id', 'window_id', 'snapshot'])
      return {
        type: 'display_snapshot',
        id: id(message['id']),
        window_id: id(message['window_id']),
        snapshot: parseDisplaySnapshot(message['snapshot']),
      }
    case 'clipboard_text':
      keys(message, ['type', 'id', 'window_id', 'result'])
      return {
        type: 'clipboard_text',
        id: id(message['id']),
        window_id: id(message['window_id']),
        result: parseClipboardText(message['result']),
      }
    case 'clipboard_written':
      keys(message, ['type', 'id', 'window_id'])
      return {
        type: 'clipboard_written',
        id: id(message['id']),
        window_id: id(message['window_id']),
      }
    case 'global_shortcut_registered':
    case 'global_shortcut_unregistered':
      keys(message, ['type', 'id', 'window_id', 'shortcut_id'])
      return {
        type: message['type'],
        id: id(message['id']),
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'global_shortcut':
      keys(message, ['type', 'sequence', 'window_id', 'shortcut_id'])
      return {
        type: 'global_shortcut',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'notification_posted':
      keys(message, ['type', 'id', 'window_id', 'notification_id', 'activatable'])
      if (typeof message['activatable'] !== 'boolean')
        throw new ProtocolError('Notification activatable must be a boolean')
      return {
        type: 'notification_posted',
        id: id(message['id']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
        activatable: message['activatable'],
      }
    case 'notification_withdrawn':
      keys(message, ['type', 'id', 'window_id', 'notification_id'])
      return {
        type: 'notification_withdrawn',
        id: id(message['id']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'notification_activated':
      keys(message, ['type', 'sequence', 'window_id', 'notification_id'])
      return {
        type: 'notification_activated',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'notification_dismissed':
      keys(message, ['type', 'sequence', 'window_id', 'notification_id', 'reason'])
      return {
        type: 'notification_dismissed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
        reason: parseNotificationDismissal(message['reason']),
      }
    case 'file_grant_opened':
    case 'file_grant_closed':
      keys(message, ['type', 'id', 'window_id', 'grant_id'])
      return {
        type: message['type'],
        id: id(message['id']),
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
      }
    case 'file_result':
      keys(message, ['type', 'id', 'window_id', 'grant_id', 'result'])
      return {
        type: 'file_result',
        id: id(message['id']),
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
        result: parseFileResult(message['result']),
      }
    case 'process_spawned':
    case 'process_updated':
    case 'process_released':
      keys(message, ['type', 'id', 'window_id', 'process_id'])
      return {
        type: message['type'],
        id: id(message['id']),
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
      }
    case 'process_output':
      keys(message, ['type', 'sequence', 'window_id', 'process_id', 'chunk', 'stream', 'data'])
      return {
        type: 'process_output',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        chunk: id(message['chunk']),
        stream: parseProcessStream(message['stream']),
        data: parseProcessOutput(message['data']),
      }
    case 'process_exited':
      keys(message, ['type', 'sequence', 'window_id', 'process_id', 'exit'])
      return {
        type: 'process_exited',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        exit: parseProcessExit(message['exit']),
      }
    case 'click':
    case 'focus':
    case 'blur':
      keys(message, ROUTE_KEYS)
      return {
        type: message['type'],
        ...route(message),
      }
    case 'key_down':
    case 'key_up': {
      keys(message, [...ROUTE_KEYS, 'key', 'key_char', 'modifiers'])
      const key = string(message['key'], 'key', 256)
      if (!key) throw new ProtocolError('Native key must be nonempty')
      return {
        type: message['type'],
        ...route(message),
        key,
        ...('key_char' in message
          ? { key_char: string(message['key_char'], 'key_char', 256) }
          : {}),
        modifiers: modifiers(message['modifiers']),
      }
    }
    case 'pointer_down':
    case 'pointer_up': {
      keys(message, [...ROUTE_KEYS, 'button', 'x', 'y', 'modifiers'])
      const button = (['left', 'right', 'middle', 'back', 'forward'] as const).find(
        (button) => button === message['button']
      )
      if (!button) throw new ProtocolError('Unknown native pointer button')
      return {
        type: message['type'],
        ...route(message),
        button,
        x: number(message['x'], 'pointer x', -1_048_576, 1_048_576),
        y: number(message['y'], 'pointer y', -1_048_576, 1_048_576),
        modifiers: modifiers(message['modifiers']),
      }
    }
    case 'closed':
      keys(message, ['type', 'sequence', 'window_id'])
      return {
        type: 'closed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
      }
    case 'input':
      keys(message, [...ROUTE_KEYS, 'value', 'input_revision'])
      return {
        type: 'input',
        ...route(message),
        value: string(message['value'], 'value'),
        input_revision: integer(message['input_revision'], 'input revision'),
      }
    case 'error': {
      keys(message, ['type', 'id', 'code', 'message'])
      const code = ERROR_CODES.find((code) => code === message['code'])
      if (!code) throw new ProtocolError('Invalid native error code')
      return {
        type: 'error',
        code,
        message: string(message['message'], 'message'),
        ...('id' in message ? { id: id(message['id']) } : {}),
      }
    }
    default:
      throw new ProtocolError('Unknown native event')
  }
}
