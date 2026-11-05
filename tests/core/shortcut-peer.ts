// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that an OS key grab was acquired or delivered.
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
if (!directory) throw new Error('Shortcut peer requires its owned control directory')
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
const registrations = new Map<number, number>()
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

const press = (window_id: number, shortcut_id: number) =>
  emit({ type: 'global_shortcut', sequence: ++sequence, window_id, shortcut_id })

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
              : [...REQUIRED_CAPABILITIES, 'global_shortcuts_v1'],
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
      case 'register_global_shortcut': {
        const code = !policy.global_shortcuts
          ? 'permission_denied'
          : !windows.has(command.window_id)
            ? 'invalid_handle'
            : mode === 'unavailable'
              ? 'service_unavailable'
              : mode === 'conflict'
                ? 'conflict'
                : undefined
        if (code) {
          await emit({ type: 'error', id: command.id, code, message: 'Headless outcome' })
          break
        }
        registrations.set(command.shortcut_id, command.window_id)
        await emit({
          type: 'global_shortcut_registered',
          id: command.id,
          window_id: command.window_id,
          shortcut_id: command.shortcut_id,
        })
        if (mode === 'press' || mode === 'late') await press(command.window_id, command.shortcut_id)
        if (mode === 'foreign') await press(command.window_id, command.shortcut_id + 1)
        break
      }
      case 'unregister_global_shortcut':
        if (registrations.get(command.shortcut_id) !== command.window_id) {
          await emit({
            type: 'error',
            id: command.id,
            code: 'invalid_handle',
            message: 'Headless outcome',
          })
          break
        }
        registrations.delete(command.shortcut_id)
        await emit({
          type: 'global_shortcut_unregistered',
          id: command.id,
          window_id: command.window_id,
          shortcut_id: command.shortcut_id,
        })
        // A press the OS queued before the grab release reaches the client late.
        if (mode === 'late') await press(command.window_id, command.shortcut_id)
        break
      case 'close':
        windows.delete(command.window_id)
        await emit({ type: 'ack', id: command.id })
        for (const [shortcut, owner] of registrations)
          if (owner === command.window_id) {
            registrations.delete(shortcut)
            if (mode === 'late') await press(owner, shortcut)
          }
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected shortcut peer command')
    }
  }
