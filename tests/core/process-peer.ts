// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a child process ran, produced output or exited.
import {
  DEFAULT_LIMITS,
  filesystemRootsFromArguments,
  processesFromArguments,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Process peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
writeFileSync(join(directory, 'argv.json'), JSON.stringify(process.argv.slice(4)))
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  drag_drop: process.argv.includes('--bun-native-allow-drag-drop'),
  filesystem_roots: filesystemRootsFromArguments(process.argv),
  processes: processesFromArguments(process.argv),
}
const windows = new Set<number>()
const live = new Map<number, { window: number; terminal: boolean; chunk: number }>()
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

const text = (value: string) => new TextEncoder().encode(value).toBase64()

async function out(process_id: number, data: string, stream?: string) {
  const entry = live.get(process_id)!
  entry.chunk += mode === 'reorder' && entry.chunk === 0 ? 2 : 1
  await emit({
    type: 'process_output',
    sequence: ++sequence,
    window_id: entry.window,
    process_id,
    chunk: entry.chunk,
    stream: stream ?? (entry.terminal ? 'terminal' : 'stdout'),
    data: text(data),
  })
}

const exit = (process_id: number) =>
  emit({
    type: 'process_exited',
    sequence: ++sequence,
    window_id: live.get(process_id)!.window,
    process_id,
    exit: { code: 7 },
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
              : [...REQUIRED_CAPABILITIES, 'filesystem_grants_v1', 'processes_v1'],
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
      case 'open_file_grant':
        await emit({
          type: 'file_grant_opened',
          id: command.id,
          window_id: command.window_id,
          grant_id: command.grant_id,
        })
        break
      case 'spawn_process': {
        if (mode === 'unavailable' || mode === 'missing') {
          await emit({
            type: 'error',
            id: command.id,
            code: mode === 'missing' ? 'not_found' : 'service_unavailable',
            message: 'Headless outcome',
          })
          break
        }
        live.set(command.process_id, {
          window: command.window_id,
          terminal: command.launch.terminal !== undefined,
          chunk: 0,
        })
        await emit({
          type: 'process_spawned',
          id: command.id,
          window_id: command.window_id,
          process_id: command.process_id,
        })
        if (mode === 'quiet') break
        await out(command.process_id, 'hello ')
        if (mode === 'after-exit') {
          await exit(command.process_id)
          await out(command.process_id, 'late')
          break
        }
        await out(
          command.process_id,
          'world',
          live.get(command.process_id)!.terminal ? undefined : 'stderr'
        )
        break
      }
      case 'acknowledge_process_output':
        await emit({
          type: 'process_updated',
          id: command.id,
          window_id: command.window_id,
          process_id: command.process_id,
        })
        // The host reports the exit only after all output was delivered.
        if (command.chunk === 2 && mode !== 'quiet') await exit(command.process_id)
        break
      case 'write_process':
      case 'close_process_input':
      case 'resize_process':
      case 'signal_process':
        await emit({
          type: 'process_updated',
          id: command.id,
          window_id: command.window_id,
          process_id: command.process_id,
        })
        if (mode === 'quiet' && command.type === 'write_process')
          await out(command.process_id, 'echo')
        break
      case 'release_process':
        live.delete(command.process_id)
        await emit({
          type: 'process_released',
          id: command.id,
          window_id: command.window_id,
          process_id: command.process_id,
        })
        break
      case 'close':
        windows.delete(command.window_id)
        for (const [id, entry] of live) if (entry.window === command.window_id) live.delete(id)
        await emit({ type: 'ack', id: command.id })
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected process peer command')
    }
  }
