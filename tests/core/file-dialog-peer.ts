// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that an OS file dialog was shown or that a user chose a file.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('File dialog peer requires its owned control directory')
const mode = process.argv[3] ?? 'hold'
const granted = process.argv.includes('--bun-native-allow-file-dialogs')
const policy = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  filesystem_roots: [],
  // Omitted when denied, exactly like the native host.
  ...(granted ? { file_dialogs: true } : {}),
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

const complete = (window_id: number, dialog_id: number, result: unknown) =>
  emit({
    type: 'file_dialog_completed',
    sequence: ++sequence,
    window_id,
    dialog_id,
    result,
  })

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
              : [...REQUIRED_CAPABILITIES, 'file_dialogs_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: mode === 'forged-grant' ? { ...policy, file_dialogs: true } : policy,
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
      case 'show_file_dialog': {
        const { window_id, dialog_id, options } = command
        const code = !granted
          ? 'permission_denied'
          : !windows.has(window_id)
            ? 'invalid_handle'
            : mode === 'unavailable' || mode === 'no-portal'
              ? 'service_unavailable'
              : [...live.values()].includes(window_id)
                ? 'limit_exceeded'
                : undefined
        if (code) {
          await emit({
            type: 'error',
            id: command.id,
            code,
            message: 'Headless outcome',
          })
          break
        }
        live.set(dialog_id, window_id)
        await emit({
          type: 'file_dialog_opened',
          id: command.id,
          window_id,
          dialog_id,
        })
        const several = options.mode === 'open_files' || mode === 'several'
        if (mode === 'select') {
          live.delete(dialog_id)
          await complete(window_id, dialog_id, {
            kind: 'selected',
            paths: several ? ['/data/a.txt', '/data/b c.txt'] : ['/data/ü.txt'],
          })
        }
        if (mode === 'several') {
          live.delete(dialog_id)
          await complete(window_id, dialog_id, {
            kind: 'selected',
            paths: ['/a', '/b'],
          })
        }
        if (mode === 'cancel') {
          live.delete(dialog_id)
          await complete(window_id, dialog_id, { kind: 'cancelled' })
        }
        if (mode === 'too-large') {
          live.delete(dialog_id)
          await complete(window_id, dialog_id, {
            kind: 'failed',
            code: 'payload_too_large',
          })
        }
        if (mode === 'foreign') await complete(window_id, dialog_id + 1, { kind: 'cancelled' })
        break
      }
      case 'close_file_dialog':
        if (live.get(command.dialog_id) !== command.window_id) {
          await emit({
            type: 'error',
            id: command.id,
            code: 'invalid_handle',
            message: 'Headless outcome',
          })
          break
        }
        live.delete(command.dialog_id)
        await emit({
          type: 'file_dialog_closed',
          id: command.id,
          window_id: command.window_id,
          dialog_id: command.dialog_id,
        })
        // A response the portal queued before the close reaches the client late.
        if (mode === 'late')
          await complete(command.window_id, command.dialog_id, {
            kind: 'selected',
            paths: ['/late'],
          })
        break
      case 'close':
        windows.delete(command.window_id)
        await emit({ type: 'ack', id: command.id })
        for (const [dialog, owner] of live)
          if (owner === command.window_id) {
            live.delete(dialog)
            if (mode === 'late') await complete(owner, dialog, { kind: 'cancelled' })
          }
        await emit({
          type: 'closed',
          sequence: ++sequence,
          window_id: command.window_id,
        })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected file dialog peer command')
    }
  }
