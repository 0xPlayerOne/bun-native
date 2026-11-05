// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a desktop notification was shown or activated.
import {
  DEFAULT_LIMITS,
  filesystemRootsFromArguments,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Notification peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  drag_drop: process.argv.includes('--bun-native-allow-drag-drop'),
  filesystem_roots: filesystemRootsFromArguments(process.argv),
}
const windows = new Set<number>()
const live = new Map<number, number>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let writing = Promise.resolve()
let sequence = 0

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

const activate = (window_id: number, notification_id: number) =>
  emit({ type: 'notification_activated', sequence: ++sequence, window_id, notification_id })
const dismiss = (window_id: number, notification_id: number, reason: string) =>
  emit({ type: 'notification_dismissed', sequence: ++sequence, window_id, notification_id, reason })

for await (const chunk of Bun.stdin.stream())
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    appendFileSync(join(directory, 'requests.jsonl'), JSON.stringify(command) + '\n')
    switch (command.type) {
      case 'hello':
        await emit({
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          capabilities:
            mode === 'unavailable'
              ? REQUIRED_CAPABILITIES
              : [...REQUIRED_CAPABILITIES, 'notifications_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: policy,
        })
        await emit({ type: 'ack', id: command.id })
        break
      case 'open':
        windows.add(command.window_id)
        await emit({
          type: 'opened',
          id: command.id,
          window_id: command.window_id,
          root_id: command.root_id,
          tree_revision: 0,
        })
        break
      case 'post_notification': {
        const code = !policy.notifications
          ? 'permission_denied'
          : !windows.has(command.window_id)
            ? 'invalid_handle'
            : mode === 'unavailable' || mode === 'no-server'
              ? 'service_unavailable'
              : undefined
        if (code) {
          await emit({ type: 'error', id: command.id, code, message: 'Headless outcome' })
          break
        }
        live.set(command.notification_id, command.window_id)
        await emit({
          type: 'notification_posted',
          id: command.id,
          window_id: command.window_id,
          notification_id: command.notification_id,
          activatable: mode !== 'no-actions',
        })
        if (mode === 'activate' || mode === 'late')
          await activate(command.window_id, command.notification_id)
        if (mode === 'dismiss') {
          live.delete(command.notification_id)
          await activate(command.window_id, command.notification_id)
          await dismiss(command.window_id, command.notification_id, 'dismissed')
          // The server ended it: a later activation must not be delivered.
          await activate(command.window_id, command.notification_id)
        }
        if (mode === 'foreign') await activate(command.window_id, command.notification_id + 1)
        break
      }
      case 'withdraw_notification':
        if (live.get(command.notification_id) !== command.window_id) {
          await emit({
            type: 'error',
            id: command.id,
            code: 'invalid_handle',
            message: 'Headless outcome',
          })
          break
        }
        live.delete(command.notification_id)
        await emit({
          type: 'notification_withdrawn',
          id: command.id,
          window_id: command.window_id,
          notification_id: command.notification_id,
        })
        // An activation the server queued before the close reaches the client late.
        if (mode === 'late') await activate(command.window_id, command.notification_id)
        break
      case 'close':
        windows.delete(command.window_id)
        await emit({ type: 'ack', id: command.id })
        for (const [notification, owner] of live)
          if (owner === command.window_id) {
            live.delete(notification)
            if (mode === 'late') await activate(owner, notification)
          }
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected notification peer command')
    }
  }
