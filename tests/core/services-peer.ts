// Deterministic, headless service responses. Actual GPUI execution is a separate fixture.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Service peer needs its owned control directory')
const mode = process.argv[3] ?? 'normal'
const allowed = process.argv.includes('--bun-native-allow-window-display')
const windows = new Set<number>()
const output = Bun.stdout.writer()
const decoder = new FrameDecoder()
let sequence = 0

async function emit(value: unknown) {
  output.write(encodeFrame(value))
  await output.flush()
}

for await (const chunk of Bun.stdin.stream()) {
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    appendFileSync(join(directory, 'requests.jsonl'), JSON.stringify(command) + '\n')
    switch (command.type) {
      case 'hello':
        await emit({
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          capabilities:
            mode === 'missing-service'
              ? REQUIRED_CAPABILITIES.filter((value) => value !== 'window_display_v1')
              : REQUIRED_CAPABILITIES,
          limits: DEFAULT_LIMITS,
          service_policy: { window_display: mode === 'wrong-policy' ? !allowed : allowed },
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
      case 'display_snapshot': {
        writeFileSync(join(directory, 'received'), String(command.id))
        if (mode === 'hold' || mode === 'hold-wrong-owner') {
          const deadline = performance.now() + 5_000
          while (!existsSync(join(directory, 'release'))) {
            if (performance.now() >= deadline)
              throw new Error('Service peer release deadline expired')
            await Bun.sleep(5)
          }
        }
        const code = !allowed
          ? 'permission_denied'
          : !windows.has(command.window_id)
            ? 'invalid_handle'
            : mode === 'unavailable'
              ? 'service_unavailable'
              : undefined
        if (code)
          await emit({
            type: 'error',
            id: command.id,
            code,
            message: 'Explicit headless service outcome',
          })
        else
          await emit({
            type: 'display_snapshot',
            id: command.id,
            window_id:
              command.window_id + (mode === 'wrong-owner' || mode === 'hold-wrong-owner' ? 1 : 0),
            snapshot: { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scale_factor: 1.5 },
          })
        break
      }
      case 'close':
        windows.delete(command.window_id)
        await emit({ type: 'ack', id: command.id })
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
    }
  }
}
