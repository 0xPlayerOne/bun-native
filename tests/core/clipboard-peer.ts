// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a native clipboard selection was read or written.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type Command,
} from '@bun-native/protocol'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Clipboard peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
}
const windows = new Set<number>()
const pending = new Map<number, number>()
const tasks = new Set<Promise<void>>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let writing = Promise.resolve()
let text: string | undefined
let sequence = 0

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

async function cancel(window: number | undefined) {
  for (const [id, owner] of pending) {
    if (window !== undefined && owner !== window) continue
    pending.delete(id)
    await emit({
      type: 'error',
      id,
      code: window === undefined ? 'cancelled' : 'invalid_handle',
      message: 'Headless pending service revoked',
    })
  }
}

async function clipboard(
  command: Extract<Command, { type: 'clipboard_read' | 'clipboard_write' }>
) {
  const allowed = command.type === 'clipboard_read' ? policy.clipboard_read : policy.clipboard_write
  const code = !allowed
    ? 'permission_denied'
    : !windows.has(command.window_id)
      ? 'invalid_handle'
      : mode === 'unavailable'
        ? 'service_unavailable'
        : ['operation_timed_out', 'payload_too_large', 'native_failure'].includes(mode)
          ? mode
          : undefined
  if (code) {
    await emit({
      type: 'error',
      id: command.id,
      code,
      message: 'Explicit headless service outcome',
    })
    return
  }
  if (command.type === 'clipboard_write') {
    text = command.text
    await emit({ type: 'clipboard_written', id: command.id, window_id: command.window_id })
    return
  }
  pending.set(command.id, command.window_id)
  const deadline = performance.now() + 3_000
  while (
    mode.startsWith('hold') &&
    !existsSync(join(directory, 'release')) &&
    pending.has(command.id)
  ) {
    if (performance.now() >= deadline) throw new Error('Clipboard peer release deadline expired')
    await Bun.sleep(2)
  }
  if (!pending.delete(command.id)) return
  await emit({
    type: 'clipboard_text',
    id: command.id,
    window_id: command.window_id + (mode.includes('wrong-owner') ? 1 : 0),
    result:
      mode === 'lower-limit-response'
        ? { kind: 'text', text: 'Too long' }
        : text === undefined
          ? { kind: 'empty' }
          : { kind: 'text', text },
  })
}

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
              : [...REQUIRED_CAPABILITIES, 'clipboard_text_v1'],
          limits: mode.startsWith('lower-limit')
            ? { ...DEFAULT_LIMITS, max_clipboard_bytes: 4 }
            : DEFAULT_LIMITS,
          service_policy: {
            ...policy,
            ...(mode === 'wrong-policy' ? { clipboard_read: !policy.clipboard_read } : {}),
          },
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
      case 'batch':
        await emit({
          type: 'applied',
          id: command.id,
          window_id: command.window_id,
          tree_revision: command.base_revision + 1,
        })
        break
      case 'clipboard_read':
      case 'clipboard_write': {
        const task = clipboard(command).finally(() => tasks.delete(task))
        tasks.add(task)
        break
      }
      case 'close':
        windows.delete(command.window_id)
        await cancel(command.window_id)
        await emit({ type: 'ack', id: command.id })
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await cancel(undefined)
        await Promise.all(tasks)
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected clipboard peer command')
    }
  }
