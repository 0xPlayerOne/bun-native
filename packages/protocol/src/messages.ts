import {
  parseAppMenuItemId,
  parseAppMenus,
  parseContextMenuItems,
  type AppMenu,
  type AppMenuEntry,
} from './app-menu.ts'
import {
  parseFileDialogOptions,
  parseFileDialogResult,
  type FileDialogOptions,
  type FileDialogResult,
} from './dialogs.ts'
import { parseElement, type Element } from './elements.ts'
import {
  parseMessageDialogOptions,
  parseMessageDialogResult,
  type MessageDialogOptions,
  type MessageDialogResult,
} from './message-dialogs.ts'
import { ProtocolError } from './framing.ts'
import {
  parseDisplaySnapshot,
  parseClipboardText,
  parseServicePolicy,
  parseShortcutKey,
  parseShortcutModifiers,
  parseNotificationContent,
  parseNotificationDismissal,
  type ClipboardText,
  type DisplaySnapshot,
  type NotificationDismissal,
  type ServicePolicy,
  type ShortcutModifiers,
} from './services.ts'
import {
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
  parseDragState,
  parseDropItemIndex,
  parseDroppedItems,
  parseDropRejection,
  type DragState,
  type DroppedItem,
  type DropRejection,
} from './drops.ts'
import { id, integer, keys, number, object, string } from './values.ts'
import {
  CAPABILITIES,
  COMMAND_KEYS,
  DEFAULT_LIMITS,
  DISMISS_REASONS,
  ERROR_CODES,
  EVENT_KEYS,
  MAX_CLIPBOARD_BYTES,
  MAX_DEPTH,
  MAX_KEY_BYTES,
  MAX_NODES_PER_WINDOW,
  MAX_OPERATIONS,
  MAX_POINTER_COORDINATE,
  MAX_SCROLL_OFFSET,
  MAX_TITLE_BYTES,
  MODIFIER_KEYS,
  OPERATION_KEYS,
  POINTER_BUTTONS,
  PROTOCOL_VERSION,
  RESIZE_SOURCES,
  type Capability,
  type DismissReason,
  type ErrorCode,
  type Limits,
  type PointerButton,
  type ResizeSource,
} from './wire-schema.ts'

export type { Capability, DismissReason, ErrorCode, Limits, PointerButton, ResizeSource }

export type Operation =
  | { type: 'create'; node_id: number; element: Element }
  | {
      type: 'set'
      node_id: number
      element: Exclude<Element, { kind: 'input' }>
    }
  | {
      type: 'set'
      node_id: number
      element: Extract<Element, { kind: 'input' }>
      expected_input_revision: number
    }
  | { type: 'insert'; parent_id: number; child_id: number; index: number }
  | { type: 'delete'; node_id: number }
  /** Requires `focus_v1`; applied after the batch's tree changes. */
  | { type: 'focus'; node_id: number }
  /** Requires `scroll_control_v1`; offsets from the content start, clamped natively. */
  | { type: 'scroll_to'; node_id: number; x?: number; y?: number }
  /** Requires `scroll_control_v1`. */
  | { type: 'scroll_into_view'; node_id: number }

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
  | {
      id: number
      type: 'unregister_global_shortcut'
      window_id: number
      shortcut_id: number
    }
  | {
      id: number
      type: 'post_notification'
      window_id: number
      notification_id: number
      title: string
      body: string
    }
  | {
      id: number
      type: 'withdraw_notification'
      window_id: number
      notification_id: number
    }
  | {
      id: number
      type: 'open_file_grant'
      window_id: number
      grant_id: number
      root: string
      access: FileAccess
    }
  | {
      id: number
      type: 'close_file_grant'
      window_id: number
      grant_id: number
    }
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
  | {
      id: number
      type: 'show_file_dialog'
      window_id: number
      dialog_id: number
      options: FileDialogOptions
    }
  | {
      id: number
      type: 'close_file_dialog'
      window_id: number
      dialog_id: number
    }
  | {
      id: number
      type: 'show_message_dialog'
      window_id: number
      dialog_id: number
      options: MessageDialogOptions
    }
  | {
      id: number
      type: 'close_message_dialog'
      window_id: number
      dialog_id: number
    }
  /** Shows an OS context menu at a logical point of the window's content. */
  | {
      id: number
      type: 'show_context_menu'
      window_id: number
      menu_id: number
      x: number
      y: number
      items: AppMenuEntry[]
    }
  | { id: number; type: 'close_context_menu'; window_id: number; menu_id: number }
  | {
      id: number
      type: 'register_drop_target'
      window_id: number
      target_id: number
      node_id: number
    }
  | { id: number; type: 'unregister_drop_target'; window_id: number; target_id: number }
  | {
      id: number
      type: 'resolve_dropped_item'
      window_id: number
      target_id: number
      drop_id: number
      item: number
      root: string
    }
  /** Replaces the application menu bar; an empty `menus` removes it. */
  | { id: number; type: 'set_app_menu'; menu_id: number; menus: AppMenu[] }
  | { id: number; type: 'shutdown' }

export interface KeyModifiers {
  control: boolean
  alt: boolean
  shift: boolean
  platform: boolean
  function: boolean
}

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
    | {
        type: 'key_down'
        key: string
        key_char?: string
        modifiers: KeyModifiers
      }
    | {
        type: 'key_up'
        key: string
        key_char?: string
        modifiers: KeyModifiers
      }
    | {
        type: 'pointer_down'
        button: PointerButton
        x: number
        y: number
        modifiers: KeyModifiers
      }
    | {
        type: 'pointer_up'
        button: PointerButton
        x: number
        y: number
        modifiers: KeyModifiers
      }
    | { type: 'dismiss'; reason: DismissReason }
    | { type: 'split_resize'; ratio: number; source: ResizeSource }
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
  | {
      type: 'opened'
      id: number
      window_id: number
      root_id: number
      tree_revision: number
    }
  | { type: 'applied'; id: number; window_id: number; tree_revision: number }
  | {
      type: 'display_snapshot'
      id: number
      window_id: number
      snapshot: DisplaySnapshot
    }
  | {
      type: 'clipboard_text'
      id: number
      window_id: number
      result: ClipboardText
    }
  | { type: 'clipboard_written'; id: number; window_id: number }
  | {
      type: 'global_shortcut_registered'
      id: number
      window_id: number
      shortcut_id: number
    }
  | {
      type: 'global_shortcut_unregistered'
      id: number
      window_id: number
      shortcut_id: number
    }
  | RoutedEvent
  | { type: 'display_changed'; sequence: number; window_id: number; snapshot: DisplaySnapshot }
  | { type: 'global_shortcut'; sequence: number; window_id: number; shortcut_id: number }
  | {
      type: 'notification_posted'
      id: number
      window_id: number
      notification_id: number
      activatable: boolean
    }
  | {
      type: 'notification_withdrawn'
      id: number
      window_id: number
      notification_id: number
    }
  | {
      type: 'notification_activated'
      sequence: number
      window_id: number
      notification_id: number
    }
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
  | {
      type: 'file_dialog_opened'
      id: number
      window_id: number
      dialog_id: number
    }
  | {
      type: 'file_dialog_closed'
      id: number
      window_id: number
      dialog_id: number
    }
  | {
      type: 'file_dialog_completed'
      sequence: number
      window_id: number
      dialog_id: number
      result: FileDialogResult
    }
  | {
      type: 'message_dialog_opened'
      id: number
      window_id: number
      dialog_id: number
    }
  | {
      type: 'message_dialog_closed'
      id: number
      window_id: number
      dialog_id: number
    }
  | {
      type: 'message_dialog_completed'
      sequence: number
      window_id: number
      dialog_id: number
      result: MessageDialogResult
    }
  | { type: 'context_menu_opened'; id: number; window_id: number; menu_id: number }
  | { type: 'context_menu_closed'; id: number; window_id: number; menu_id: number }
  /** `item_id` is absent when the menu was dismissed. */
  | {
      type: 'context_menu_completed'
      sequence: number
      window_id: number
      menu_id: number
      item_id?: string
    }
  | { type: 'drop_target_registered'; id: number; window_id: number; target_id: number }
  | { type: 'drop_target_unregistered'; id: number; window_id: number; target_id: number }
  | {
      type: 'dropped_item_resolved'
      id: number
      window_id: number
      target_id: number
      drop_id: number
      item: number
      root: string
      path: string
    }
  | {
      type: 'drop_target_drag'
      sequence: number
      window_id: number
      target_id: number
      state: DragState
    }
  | {
      type: 'drop_received'
      sequence: number
      window_id: number
      target_id: number
      drop_id: number
      items: DroppedItem[]
    }
  | {
      type: 'drop_rejected'
      sequence: number
      window_id: number
      target_id: number
      reason: DropRejection
    }
  | { type: 'closed'; sequence: number; window_id: number }
  | { type: 'app_menu_set'; id: number; menu_id: number }
  /** Application-scoped: a menu bar belongs to the application, not a window. */
  | { type: 'app_menu_item'; sequence: number; menu_id: number; item_id: string }
  | { type: 'error'; id?: number; code: ErrorCode; message: string }
/** Sequenced events owned by one window. */
export type WindowEvent = Extract<NativeEvent, { sequence: number; window_id: number }>
/** Sequenced events owned by the application rather than one window. */
export type ApplicationEvent = Extract<NativeEvent, { type: 'app_menu_item' }>
/** Unsolicited events, as opposed to responses that carry a request id. */
export type HostEvent = WindowEvent | ApplicationEvent

function version(value: unknown): typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolError('Native protocol version mismatch')
  return PROTOCOL_VERSION
}

function createOperation(nodeId: unknown, element: unknown): Operation {
  return { type: 'create', node_id: id(nodeId), element: parseElement(element) }
}

function setOperation(
  nodeId: unknown,
  value: unknown,
  revised: boolean,
  revision: unknown
): Operation {
  const node_id = id(nodeId)
  const element = parseElement(value)
  if (element.kind === 'input')
    return {
      type: 'set',
      node_id,
      element,
      expected_input_revision: integer(revision, 'input revision'),
    }
  if (revised) throw new ProtocolError('Only input elements accept an input revision')
  return { type: 'set', node_id, element }
}

function insertOperation(parentId: unknown, childId: unknown, index: unknown): Operation {
  return {
    type: 'insert',
    parent_id: id(parentId),
    child_id: id(childId),
    index: integer(index, 'index', 0, MAX_NODES_PER_WINDOW),
  }
}

function scrollOperation(
  nodeId: unknown,
  offset: { readonly x?: unknown; readonly y?: unknown }
): Operation {
  if (!('x' in offset) && !('y' in offset)) throw new ProtocolError('scroll_to requires x or y')
  const axis = (name: 'x' | 'y') =>
    name in offset ? { [name]: number(offset[name], 'scroll ' + name, 0, MAX_SCROLL_OFFSET) } : {}
  return { type: 'scroll_to', node_id: id(nodeId), ...axis('x'), ...axis('y') }
}

/** The operations of an `OperationList`, copied, or `undefined` for any other value. */
let listed: (value: unknown) => Operation[] | undefined

/**
 * One batch's operations, built by checked constructors for a trusted builder
 * such as core's transaction. Each constructor checks its fields as
 * `parseCommand` would and freezes the operation, and the list keeps them
 * where no caller can replace them, so `parseCommand` accepts a list as its
 * batch operations without parsing each one again. A plain operations array,
 * including one read from a list, is parsed in full.
 */
export class OperationList implements Iterable<Operation> {
  #operations: Operation[] = []

  static {
    listed = (value) =>
      value !== null && typeof value === 'object' && #operations in value
        ? (value as OperationList).#operations.slice()
        : undefined
  }

  /** One list of `lists`, in order, as one batch carries them. */
  static join(lists: readonly OperationList[]): OperationList {
    const joined = new OperationList()
    joined.#operations = lists.flatMap((list) => list.#operations)
    return joined
  }

  get length(): number {
    return this.#operations.length
  }

  [Symbol.iterator](): Iterator<Operation> {
    return this.#operations.values()
  }

  #push(operation: Operation): void {
    this.#operations.push(Object.freeze(operation))
  }

  create(nodeId: number, element: Element): void {
    this.#push(createOperation(nodeId, element))
  }

  set(nodeId: number, element: Element, expectedInputRevision?: number): void {
    this.#push(
      setOperation(nodeId, element, expectedInputRevision !== undefined, expectedInputRevision)
    )
  }

  insert(parentId: number, childId: number, index: number): void {
    this.#push(insertOperation(parentId, childId, index))
  }

  delete(nodeId: number): void {
    this.#push({ type: 'delete', node_id: id(nodeId) })
  }

  focus(nodeId: number): void {
    this.#push({ type: 'focus', node_id: id(nodeId) })
  }

  scrollTo(nodeId: number, offset: { readonly x?: number; readonly y?: number }): void {
    this.#push(scrollOperation(nodeId, offset))
  }

  scrollIntoView(nodeId: number): void {
    this.#push({ type: 'scroll_into_view', node_id: id(nodeId) })
  }
}

function operation(value: unknown): Operation {
  const data = object(value)
  const type = data['type']
  switch (type) {
    case 'create':
      keys(data, OPERATION_KEYS.create)
      return createOperation(data['node_id'], data['element'])
    case 'set':
      keys(data, OPERATION_KEYS.set)
      return setOperation(
        data['node_id'],
        data['element'],
        'expected_input_revision' in data,
        data['expected_input_revision']
      )
    case 'insert':
      keys(data, OPERATION_KEYS.insert)
      return insertOperation(data['parent_id'], data['child_id'], data['index'])
    case 'delete':
    case 'focus':
    case 'scroll_into_view':
      keys(
        data,
        type === 'delete'
          ? OPERATION_KEYS.delete
          : type === 'focus'
            ? OPERATION_KEYS.focus
            : OPERATION_KEYS.scroll_into_view
      )
      return { type, node_id: id(data['node_id']) }
    case 'scroll_to':
      keys(data, OPERATION_KEYS.scroll_to)
      return scrollOperation(data['node_id'], data)
    default:
      throw new ProtocolError('Unknown native operation')
  }
}

/** Validate before crossing the native boundary, including JavaScript callers. */
export function parseCommand(value: unknown): Command {
  const message = object(value)
  const request = id(message['id'])
  const type = message['type']
  switch (type) {
    case 'hello':
      keys(message, COMMAND_KEYS.hello)
      return {
        id: request,
        type: 'hello',
        protocol: version(message['protocol']),
      }
    case 'open': {
      keys(message, COMMAND_KEYS.open)
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
      keys(message, COMMAND_KEYS.batch)
      // A list's operations were checked as it was built and cannot change since.
      const built = listed(message['operations'])
      const operations = built ?? message['operations']
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS)
        throw new ProtocolError(
          'Batch must contain between 1 and ' + MAX_OPERATIONS + ' operations'
        )
      return {
        id: request,
        type: 'batch',
        window_id: id(message['window_id']),
        base_revision: integer(message['base_revision'], 'tree revision'),
        operations: built ?? operations.map(operation),
      }
    }
    case 'close':
    case 'display_snapshot':
    case 'clipboard_read':
      keys(message, COMMAND_KEYS[type])
      return {
        id: request,
        type,
        window_id: id(message['window_id']),
      }
    case 'clipboard_write':
      keys(message, COMMAND_KEYS.clipboard_write)
      return {
        id: request,
        type: 'clipboard_write',
        window_id: id(message['window_id']),
        text: string(message['text'], 'clipboard text', MAX_CLIPBOARD_BYTES),
      }
    case 'register_global_shortcut':
      keys(message, COMMAND_KEYS.register_global_shortcut)
      return {
        id: request,
        type: 'register_global_shortcut',
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
        key: parseShortcutKey(message['key']),
        modifiers: parseShortcutModifiers(message['modifiers']),
      }
    case 'unregister_global_shortcut':
      keys(message, COMMAND_KEYS.unregister_global_shortcut)
      return {
        id: request,
        type: 'unregister_global_shortcut',
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'post_notification': {
      keys(message, COMMAND_KEYS.post_notification)
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
      keys(message, COMMAND_KEYS.withdraw_notification)
      return {
        id: request,
        type: 'withdraw_notification',
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'open_file_grant':
      keys(message, COMMAND_KEYS.open_file_grant)
      return {
        id: request,
        type: 'open_file_grant',
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
        root: parseRootId(message['root']),
        access: parseFileAccess(message['access']),
      }
    case 'close_file_grant':
      keys(message, COMMAND_KEYS.close_file_grant)
      return {
        id: request,
        type: 'close_file_grant',
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
      }
    case 'file_request': {
      keys(message, COMMAND_KEYS.file_request)
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
      keys(message, COMMAND_KEYS.spawn_process)
      return {
        id: request,
        type: 'spawn_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        launch: parseProcessLaunch(message['launch']),
      }
    case 'write_process':
      keys(message, COMMAND_KEYS.write_process)
      return {
        id: request,
        type: 'write_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        data: parseProcessOutput(message['data']),
      }
    case 'close_process_input':
    case 'release_process':
      keys(message, COMMAND_KEYS[type])
      return {
        id: request,
        type,
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
      }
    case 'resize_process':
      keys(message, COMMAND_KEYS.resize_process)
      return {
        id: request,
        type: 'resize_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        size: parseTerminalSize(message['size']),
      }
    case 'signal_process':
      keys(message, COMMAND_KEYS.signal_process)
      return {
        id: request,
        type: 'signal_process',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        signal: parseProcessSignal(message['signal']),
      }
    case 'acknowledge_process_output':
      keys(message, COMMAND_KEYS.acknowledge_process_output)
      return {
        id: request,
        type: 'acknowledge_process_output',
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        chunk: id(message['chunk']),
      }
    case 'show_file_dialog':
      keys(message, COMMAND_KEYS.show_file_dialog)
      return {
        id: request,
        type: 'show_file_dialog',
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
        options: parseFileDialogOptions(message['options']),
      }
    case 'close_file_dialog':
      keys(message, COMMAND_KEYS.close_file_dialog)
      return {
        id: request,
        type: 'close_file_dialog',
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
      }
    case 'show_message_dialog':
      keys(message, COMMAND_KEYS.show_message_dialog)
      return {
        id: request,
        type: 'show_message_dialog',
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
        options: parseMessageDialogOptions(message['options']),
      }
    case 'close_message_dialog':
      keys(message, COMMAND_KEYS.close_message_dialog)
      return {
        id: request,
        type: 'close_message_dialog',
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
      }
    case 'show_context_menu':
      keys(message, COMMAND_KEYS.show_context_menu)
      return {
        id: request,
        type: 'show_context_menu',
        window_id: id(message['window_id']),
        menu_id: id(message['menu_id']),
        x: number(message['x'], 'context menu x', 0, MAX_POINTER_COORDINATE),
        y: number(message['y'], 'context menu y', 0, MAX_POINTER_COORDINATE),
        items: parseContextMenuItems(message['items']),
      }
    case 'close_context_menu':
      keys(message, COMMAND_KEYS.close_context_menu)
      return {
        id: request,
        type: 'close_context_menu',
        window_id: id(message['window_id']),
        menu_id: id(message['menu_id']),
      }
    case 'register_drop_target':
      keys(message, COMMAND_KEYS.register_drop_target)
      return {
        id: request,
        type: 'register_drop_target',
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        node_id: id(message['node_id']),
      }
    case 'unregister_drop_target':
      keys(message, COMMAND_KEYS.unregister_drop_target)
      return {
        id: request,
        type: 'unregister_drop_target',
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
      }
    case 'resolve_dropped_item':
      keys(message, COMMAND_KEYS.resolve_dropped_item)
      return {
        id: request,
        type: 'resolve_dropped_item',
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        drop_id: id(message['drop_id']),
        item: parseDropItemIndex(message['item']),
        root: parseRootId(message['root']),
      }
    case 'set_app_menu':
      keys(message, COMMAND_KEYS.set_app_menu)
      return {
        id: request,
        type: 'set_app_menu',
        menu_id: id(message['menu_id']),
        menus: parseAppMenus(message['menus']),
      }
    case 'shutdown':
      keys(message, COMMAND_KEYS.shutdown)
      return { id: request, type: 'shutdown' }
    default:
      throw new ProtocolError('Unknown native command')
  }
}

const LIMITS_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_LIMITS))

function limits(value: unknown): Limits {
  const data = object(value)
  keys(data, LIMITS_KEYS)
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
    max_drop_targets: parse('max_drop_targets'),
    max_drop_items: parse('max_drop_items'),
  }
}

/** Short paths, the common case, compare pairwise instead of building a set. */
function unique(path: readonly number[]): boolean {
  if (path.length > 16) return new Set(path).size === path.length
  for (let index = 1; index < path.length; index++)
    for (let other = 0; other < index; other++) if (path[index] === path[other]) return false
  return true
}

function route(message: Record<string, unknown>): NodeEventRoute {
  const node_id = id(message['node_id'])
  const value = message['path']
  if (!Array.isArray(value) || !value.length || value.length > MAX_DEPTH + 1)
    throw new ProtocolError('Native event path must contain between 1 and 65 node identities')
  const path = value.map(id)
  if (!unique(path) || path.at(-1) !== node_id)
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
  keys(data, MODIFIER_KEYS)
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

const BUTTONS: ReadonlySet<PointerButton> = new Set(POINTER_BUTTONS)
const DISMISSALS: ReadonlySet<DismissReason> = new Set(DISMISS_REASONS)
const SOURCES: ReadonlySet<ResizeSource> = new Set(RESIZE_SOURCES)
const CODES: ReadonlySet<ErrorCode> = new Set(ERROR_CODES)
const KNOWN_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES)

/** `value` when `values` holds it: one lookup, where scanning a frozen list is slower. */
function member<T>(values: ReadonlySet<T>, value: unknown, message: string): T {
  if (!values.has(value as T)) throw new ProtocolError(message)
  return value as T
}

/** Native stdout is untrusted until its message shape and limits are checked. */
export function parseEvent(value: unknown): NativeEvent {
  const message = object(value)
  const type = message['type']
  switch (type) {
    case 'ready': {
      keys(message, EVENT_KEYS.ready)
      const capabilities = message['capabilities']
      if (!Array.isArray(capabilities) || capabilities.length > CAPABILITIES.length)
        throw new ProtocolError('Invalid native capabilities')
      const parsed: Capability[] = []
      for (const value of capabilities) {
        const capability = member(
          KNOWN_CAPABILITIES,
          value,
          'Unknown or duplicate native capability'
        )
        if (parsed.includes(capability))
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
      keys(message, EVENT_KEYS.ack)
      return { type: 'ack', id: id(message['id']) }
    case 'opened':
      keys(message, EVENT_KEYS.opened)
      return {
        type: 'opened',
        id: id(message['id']),
        window_id: id(message['window_id']),
        root_id: id(message['root_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'applied':
      keys(message, EVENT_KEYS.applied)
      return {
        type: 'applied',
        id: id(message['id']),
        window_id: id(message['window_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'display_snapshot':
      keys(message, EVENT_KEYS.display_snapshot)
      return {
        type: 'display_snapshot',
        id: id(message['id']),
        window_id: id(message['window_id']),
        snapshot: parseDisplaySnapshot(message['snapshot']),
      }
    case 'clipboard_text':
      keys(message, EVENT_KEYS.clipboard_text)
      return {
        type: 'clipboard_text',
        id: id(message['id']),
        window_id: id(message['window_id']),
        result: parseClipboardText(message['result']),
      }
    case 'clipboard_written':
      keys(message, EVENT_KEYS.clipboard_written)
      return {
        type: 'clipboard_written',
        id: id(message['id']),
        window_id: id(message['window_id']),
      }
    case 'global_shortcut_registered':
    case 'global_shortcut_unregistered':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'display_changed':
      keys(message, EVENT_KEYS.display_changed)
      return {
        type: 'display_changed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        snapshot: parseDisplaySnapshot(message['snapshot']),
      }
    case 'global_shortcut':
      keys(message, EVENT_KEYS.global_shortcut)
      return {
        type: 'global_shortcut',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        shortcut_id: id(message['shortcut_id']),
      }
    case 'notification_posted':
      keys(message, EVENT_KEYS.notification_posted)
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
      keys(message, EVENT_KEYS.notification_withdrawn)
      return {
        type: 'notification_withdrawn',
        id: id(message['id']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'notification_activated':
      keys(message, EVENT_KEYS.notification_activated)
      return {
        type: 'notification_activated',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
      }
    case 'notification_dismissed':
      keys(message, EVENT_KEYS.notification_dismissed)
      return {
        type: 'notification_dismissed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        notification_id: id(message['notification_id']),
        reason: parseNotificationDismissal(message['reason']),
      }
    case 'file_grant_opened':
    case 'file_grant_closed':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        grant_id: id(message['grant_id']),
      }
    case 'file_result':
      keys(message, EVENT_KEYS.file_result)
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
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
      }
    case 'process_output':
      keys(message, EVENT_KEYS.process_output)
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
      keys(message, EVENT_KEYS.process_exited)
      return {
        type: 'process_exited',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        process_id: id(message['process_id']),
        exit: parseProcessExit(message['exit']),
      }
    case 'file_dialog_opened':
    case 'file_dialog_closed':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
      }
    case 'file_dialog_completed':
      keys(message, EVENT_KEYS.file_dialog_completed)
      return {
        type: 'file_dialog_completed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
        result: parseFileDialogResult(message['result']),
      }
    case 'message_dialog_opened':
    case 'message_dialog_closed':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
      }
    case 'message_dialog_completed':
      keys(message, EVENT_KEYS.message_dialog_completed)
      return {
        type: 'message_dialog_completed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        dialog_id: id(message['dialog_id']),
        result: parseMessageDialogResult(message['result']),
      }
    case 'context_menu_opened':
    case 'context_menu_closed':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        menu_id: id(message['menu_id']),
      }
    case 'context_menu_completed': {
      keys(message, EVENT_KEYS.context_menu_completed)
      const event: Extract<NativeEvent, { type: 'context_menu_completed' }> = {
        type: 'context_menu_completed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        menu_id: id(message['menu_id']),
      }
      if ('item_id' in message) event.item_id = parseAppMenuItemId(message['item_id'])
      return event
    }
    case 'drop_target_registered':
    case 'drop_target_unregistered':
      keys(message, EVENT_KEYS[type])
      return {
        type,
        id: id(message['id']),
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
      }
    case 'dropped_item_resolved':
      keys(message, EVENT_KEYS.dropped_item_resolved)
      return {
        type: 'dropped_item_resolved',
        id: id(message['id']),
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        drop_id: id(message['drop_id']),
        item: parseDropItemIndex(message['item']),
        root: parseRootId(message['root']),
        path: parseFilePath(message['path']),
      }
    case 'drop_target_drag':
      keys(message, EVENT_KEYS.drop_target_drag)
      return {
        type: 'drop_target_drag',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        state: parseDragState(message['state']),
      }
    case 'drop_received':
      keys(message, EVENT_KEYS.drop_received)
      return {
        type: 'drop_received',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        drop_id: id(message['drop_id']),
        items: parseDroppedItems(message['items']),
      }
    case 'drop_rejected':
      keys(message, EVENT_KEYS.drop_rejected)
      return {
        type: 'drop_rejected',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        target_id: id(message['target_id']),
        reason: parseDropRejection(message['reason']),
      }
    case 'click':
    case 'focus':
    case 'blur':
      // Hot input paths read their table entry statically; a keyed read costs
      // about a tenth of the parse.
      keys(
        message,
        type === 'click' ? EVENT_KEYS.click : type === 'focus' ? EVENT_KEYS.focus : EVENT_KEYS.blur
      )
      return {
        type,
        ...route(message),
      }
    case 'key_down':
    case 'key_up': {
      keys(message, type === 'key_down' ? EVENT_KEYS.key_down : EVENT_KEYS.key_up)
      const key = string(message['key'], 'key', MAX_KEY_BYTES)
      if (!key) throw new ProtocolError('Native key must be nonempty')
      return {
        type,
        ...route(message),
        key,
        ...('key_char' in message
          ? { key_char: string(message['key_char'], 'key_char', MAX_KEY_BYTES) }
          : {}),
        modifiers: modifiers(message['modifiers']),
      }
    }
    case 'pointer_down':
    case 'pointer_up': {
      keys(message, type === 'pointer_down' ? EVENT_KEYS.pointer_down : EVENT_KEYS.pointer_up)
      return {
        type,
        ...route(message),
        button: member(BUTTONS, message['button'], 'Unknown native pointer button'),
        x: number(message['x'], 'pointer x', -MAX_POINTER_COORDINATE, MAX_POINTER_COORDINATE),
        y: number(message['y'], 'pointer y', -MAX_POINTER_COORDINATE, MAX_POINTER_COORDINATE),
        modifiers: modifiers(message['modifiers']),
      }
    }
    case 'dismiss':
      keys(message, EVENT_KEYS.dismiss)
      return {
        type: 'dismiss',
        ...route(message),
        reason: member(DISMISSALS, message['reason'], 'Unknown native dismissal reason'),
      }
    case 'split_resize': {
      keys(message, EVENT_KEYS.split_resize)
      return {
        type: 'split_resize',
        ...route(message),
        ratio: number(message['ratio'], 'split ratio', 0, 1),
        source: member(SOURCES, message['source'], 'Unknown split resize source'),
      }
    }
    case 'closed':
      keys(message, EVENT_KEYS.closed)
      return {
        type: 'closed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
      }
    case 'input':
      keys(message, EVENT_KEYS.input)
      return {
        type: 'input',
        ...route(message),
        value: string(message['value'], 'value'),
        input_revision: integer(message['input_revision'], 'input revision'),
      }
    case 'app_menu_set':
      keys(message, EVENT_KEYS.app_menu_set)
      return { type: 'app_menu_set', id: id(message['id']), menu_id: id(message['menu_id']) }
    case 'app_menu_item':
      keys(message, EVENT_KEYS.app_menu_item)
      return {
        type: 'app_menu_item',
        sequence: id(message['sequence']),
        menu_id: id(message['menu_id']),
        item_id: parseAppMenuItemId(message['item_id']),
      }
    case 'error': {
      keys(message, EVENT_KEYS.error)
      return {
        type: 'error',
        code: member(CODES, message['code'], 'Invalid native error code'),
        message: string(message['message'], 'message'),
        ...('id' in message ? { id: id(message['id']) } : {}),
      }
    }
    default:
      throw new ProtocolError('Unknown native event')
  }
}
