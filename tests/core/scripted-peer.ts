// Headless transport peer whose replies a test scripts through its owned
// control directory. It exercises application error paths; it never renders,
// grabs keys or posts notifications, and is not native acceptance evidence.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  filesystemRootsFromArguments,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type Command,
} from '@bun-native/protocol'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PeerTree } from './peer-tree.ts'

/** One scripted outcome, applied to every command of its type while present. */
export type PeerAction = {
  /** Reply with this native error code instead of the success response. */
  error?: string
  /** Defer the reply; shutdown answers held requests as cancelled before its ack. */
  hold?: boolean
  /** Frames emitted before the reply. */
  before?: unknown[]
  /** Wait after `before` so the client can dispatch those frames first. */
  delayMs?: number
  /** Frames emitted after the reply. */
  after?: unknown[]
}
export type PeerScript = Partial<Record<Command['type'], PeerAction>>

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Scripted peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  filesystem_roots: filesystemRootsFromArguments(process.argv),
}
const windows = new Map<number, PeerTree>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let writing = Promise.resolve()
let sequence = 0
const held: Command[] = []

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

function script(): PeerScript {
  const path = join(directory, 'script.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PeerScript) : {}
}

// "$window", "$other", "$shortcut", "$notification" and "$sequence" name the
// command's owners; "$route": kind spreads the route of that kind's first node.
function resolveFrame(frame: unknown, command: Command): unknown {
  const ids = command as unknown as Record<string, number>
  const window = ids['window_id']!
  const values: Record<string, () => number> = {
    $window: () => window,
    $other: () => [...windows.keys()].find((id) => id !== window)!,
    $shortcut: () => ids['shortcut_id']!,
    $notification: () => ids['notification_id']!,
    $sequence: () => ++sequence,
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frame as Record<string, unknown>)) {
    if (key === '$route') {
      const tree = windows.get(window)!
      const target = [...tree.nodes].find(([, node]) => node.element.kind === value)!
      Object.assign(result, tree.route(target[0]))
    } else result[key] = typeof value === 'string' && value in values ? values[value]!() : value
  }
  return result
}

function success(command: Command): unknown {
  switch (command.type) {
    case 'open':
      return {
        type: 'opened',
        id: command.id,
        window_id: command.window_id,
        root_id: command.root_id,
        tree_revision: 0,
      }
    case 'batch':
      return {
        type: 'applied',
        id: command.id,
        window_id: command.window_id,
        tree_revision: command.base_revision + 1,
      }
    case 'display_snapshot':
      return {
        type: 'display_snapshot',
        id: command.id,
        window_id: command.window_id,
        snapshot: { bounds: { x: 0, y: 0, width: 800, height: 600 }, scale_factor: 1 },
      }
    case 'clipboard_read':
      return {
        type: 'clipboard_text',
        id: command.id,
        window_id: command.window_id,
        result: { kind: 'empty' },
      }
    case 'clipboard_write':
      return { type: 'clipboard_written', id: command.id, window_id: command.window_id }
    case 'register_global_shortcut':
    case 'unregister_global_shortcut':
      return {
        type:
          command.type === 'register_global_shortcut'
            ? 'global_shortcut_registered'
            : 'global_shortcut_unregistered',
        id: command.id,
        window_id: command.window_id,
        shortcut_id: command.shortcut_id,
      }
    case 'post_notification':
      return {
        type: 'notification_posted',
        id: command.id,
        window_id: command.window_id,
        notification_id: command.notification_id,
        activatable: true,
      }
    case 'withdraw_notification':
      return {
        type: 'notification_withdrawn',
        id: command.id,
        window_id: command.window_id,
        notification_id: command.notification_id,
      }
    default:
      return { type: 'ack', id: command.id }
  }
}

for await (const chunk of Bun.stdin.stream())
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    if (command.type === 'hello') {
      await emit({
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        capabilities: [
          ...REQUIRED_CAPABILITIES,
          'clipboard_text_v1',
          'global_shortcuts_v1',
          'notifications_v1',
        ],
        limits:
          mode === 'small'
            ? { ...DEFAULT_LIMITS, max_operations: 8, max_depth: 2 }
            : { ...DEFAULT_LIMITS },
        service_policy: policy,
      })
      await emit({ type: 'ack', id: command.id })
      continue
    }
    if (command.type === 'shutdown') {
      for (const request of held.splice(0))
        await emit({ type: 'error', id: request.id, code: 'cancelled', message: 'Host stopping' })
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
    if (command.type === 'open') windows.set(command.window_id, new PeerTree(command.root_id))
    const action = script()[command.type] ?? {}
    for (const frame of action.before ?? []) await emit(resolveFrame(frame, command))
    if (action.delayMs) await Bun.sleep(action.delayMs)
    if (action.hold) {
      held.push(command)
      continue
    }
    if (action.error) {
      await emit({ type: 'error', id: command.id, code: action.error, message: 'Scripted outcome' })
      if (command.type === 'open') windows.delete(command.window_id)
    } else {
      if (command.type === 'batch') windows.get(command.window_id)!.apply(command.operations)
      await emit(success(command))
      if (command.type === 'close') {
        windows.delete(command.window_id)
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
      }
    }
    for (const frame of action.after ?? []) await emit(resolveFrame(frame, command))
  }
