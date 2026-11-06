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
// `<mode>:<code>` answers one command type with that error code.
const [base, code] = mode.split(':') as [string, string | undefined]
// Modes that start no output on spawn; the test drives every event.
const QUIET = new Set([
  'quiet',
  'call-error',
  'release-error',
  'late-release',
  'late-close',
  'hold',
  'foreign',
  'wrong-stream',
  'unallocated',
])
writeFileSync(join(directory, 'argv.json'), JSON.stringify(process.argv.slice(4)))
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  drag_drop: process.argv.includes('--bun-native-allow-drag-drop'),
  filesystem_roots: filesystemRootsFromArguments(process.argv),
  processes:
    mode === 'policy'
      ? processesFromArguments(process.argv).map((entry) => ({
          ...entry,
          executable: '/bin/false',
        }))
      : processesFromArguments(process.argv),
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
const fail = (id: number, error: string) =>
  emit({ type: 'error', id, code: error, message: 'Headless outcome' })
const held: { id: number; window_id: number; process_id: number }[] = []

async function out(process_id: number, data: string, stream?: string) {
  const entry = live.get(process_id)!
  entry.chunk += mode === 'reorder' && entry.chunk === 0 ? 2 : 1
  await emit({
    type: 'process_output',
    sequence: ++sequence,
    // `foreign` names the session's other window as the owner.
    window_id: mode === 'foreign' ? (entry.window === 1 ? 2 : 1) : entry.window,
    process_id: mode === 'unallocated' ? process_id + 100 : process_id,
    chunk: entry.chunk,
    stream: stream ?? (entry.terminal === (mode !== 'wrong-stream') ? 'terminal' : 'stdout'),
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
      case 'close_file_grant':
        await emit({
          type: 'file_grant_closed',
          id: command.id,
          window_id: command.window_id,
          grant_id: command.grant_id,
        })
        break
      case 'spawn_process': {
        if (base === 'spawn-error') {
          await fail(command.id, code!)
          break
        }
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
        if (QUIET.has(base)) {
          // These modes deliver one chunk to a pipes process so the test can
          // check what the core does with it; `quiet` delivers nothing.
          if (['foreign', 'wrong-stream', 'unallocated'].includes(mode))
            await out(command.process_id, 'stray')
          break
        }
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
        if (mode === 'ack-error') await fail(command.id, 'invalid_handle')
        else if (mode === 'ack-failure') await fail(command.id, 'native_failure')
        else
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
        if (mode === 'call-error') {
          // The host's answers for a finished, closed or unread process.
          const codes = {
            write_process: 'limit_exceeded',
            close_process_input: 'invalid_state',
            resize_process: 'wrong_kind',
            signal_process: 'invalid_handle',
          } as const
          await fail(command.id, codes[command.type])
          break
        }
        if (mode === 'hold' && command.type === 'write_process') {
          // Answer only once the core has the whole service bound in flight.
          held.push({
            id: command.id,
            window_id: command.window_id,
            process_id: command.process_id,
          })
          if (held.length < 8) break
          for (const item of held.splice(0)) await emit({ type: 'process_updated', ...item })
          break
        }
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
        if (base === 'release-error') {
          await fail(command.id, code!)
          break
        }
        if (mode === 'late-release') {
          // Output and exit the host had already queued when the release arrived.
          await out(command.process_id, 'late')
          await exit(command.process_id)
        }
        live.delete(command.process_id)
        await emit({
          type: 'process_released',
          id: command.id,
          window_id: command.window_id,
          process_id: command.process_id,
        })
        break
      case 'close':
        // A control still held when the close reaches the host names a closed window.
        for (const item of held.splice(0)) await fail(item.id, 'invalid_handle')
        if (mode === 'late-close')
          for (const [id, entry] of live)
            if (entry.window === command.window_id) {
              await out(id, 'late')
              await exit(id)
            }
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
