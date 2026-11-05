// A real subprocess that exercises channel failures. It does not render UI.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { publishHolderIdentity } from './pipe-holder-identity.ts'

const mode = process.argv[2] ?? 'normal'
if (mode === 'pipe-holder') {
  const directory = process.argv[3]
  if (!directory) throw new Error('Pipe holder requires its private control directory')
  // Readiness belongs to the test's explicit setup barrier, not to hello.
  // Publish identity first so a failed negotiation can still release this child.
  publishHolderIdentity(directory, 'started')
  const deadline = performance.now() + 10_000
  if (process.argv[4] === 'delay-holder') await Bun.sleep(400)
  while (
    !existsSync(join(directory, 'arm')) &&
    !existsSync(join(directory, 'release')) &&
    performance.now() < deadline
  )
    await Bun.sleep(10)
  if (existsSync(join(directory, 'arm')) && !existsSync(join(directory, 'release'))) {
    publishHolderIdentity(directory, 'ready')
    while (!existsSync(join(directory, 'release')) && performance.now() < deadline)
      await Bun.sleep(10)
  }
  publishHolderIdentity(directory, 'finished')
  process.exit(0)
}
if (mode === 'inherited-pipe-shutdown' || mode === 'inherited-pipe-exit') {
  const directory = process.argv[3]
  if (!directory) throw new Error('Inherited-pipe peer requires its private control directory')
  Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      'pipe-holder',
      directory,
      ...(process.argv[4] === 'delay-holder' ? ['delay-holder'] : []),
    ],
    {
      // Keep this bounded helper outside the peer's Windows process job so its
      // inherited output handles remain open after the direct peer exits.
      detached: true,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )
  // Do not put a nested process startup inside NativeHost's hello deadline.
  // The test arms and verifies this helper after protocol negotiation succeeds.
}
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let sequence = 0
const roots = new Map<number, number>()
async function emit(value: unknown): Promise<void> {
  output.write(encodeFrame(value))
  await output.flush()
}

for await (const chunk of Bun.stdin.stream()) {
  for (const value of decoder.push(chunk)) {
    const command = parseCommand(value)
    if (mode === 'silent') continue
    if (mode === 'exit') process.exit(23)
    if (command.type === 'hello') {
      if (mode === 'bad-json') {
        output.write('{bad json}\n')
        await output.flush()
        continue
      }
      const ready = {
        type: 'ready',
        service_policy: {
          window_display: process.argv.includes('--bun-native-allow-window-display'),
          clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
          clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
        },
        protocol:
          mode === 'wrong-version'
            ? PROTOCOL_VERSION + 1
            : mode === 'obsolete-version'
              ? 4
              : PROTOCOL_VERSION,
        capabilities:
          mode === 'missing-capability'
            ? ['tree']
            : mode === 'missing-layout'
              ? ['tree', 'input_revisions']
              : mode === 'missing-interactions'
                ? ['tree', 'input_revisions', 'layout_v1']
                : REQUIRED_CAPABILITIES,
        limits: DEFAULT_LIMITS,
      }
      await emit(ready)
      if (mode === 'duplicate-ready') {
        // A second ready is an invalid handshake transition.
        await emit(ready)
      }
      if (mode === 'wrong-ack')
        await emit({
          type: 'opened',
          id: command.id,
          window_id: 1,
          root_id: 1,
          tree_revision: 0,
        })
      else await emit({ type: 'ack', id: mode === 'wrong-id' ? 123 : command.id })
    } else if (command.type === 'open') {
      if (mode === 'diagnostic-open-timeout') {
        const diagnostic = Bun.stderr.writer()
        diagnostic.write('x'.repeat(5_000) + '\nOwned diagnostic peer is waiting at open\n')
        await diagnostic.flush()
        continue
      }
      roots.set(command.window_id, command.root_id)
      await emit({
        type: 'opened',
        id: command.id,
        window_id: command.window_id + (mode === 'wrong-window' ? 1 : 0),
        root_id: command.root_id + (mode === 'wrong-root' ? 1 : 0),
        tree_revision: mode === 'wrong-initial-revision' ? 1 : 0,
      })
    } else if (command.type === 'batch') {
      const rejected = command.operations.some(
        (operation) =>
          operation.type === 'create' &&
          operation.element.kind === 'text' &&
          operation.element.text === 'reject'
      )
      if (rejected)
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_state',
          message: 'Rejected by fixture',
        })
      else {
        await emit({
          type: 'applied',
          id: command.id,
          window_id: command.window_id + (mode === 'wrong-batch-window' ? 1 : 0),
          tree_revision: command.base_revision + (mode === 'wrong-revision' ? 2 : 1),
        })
        for (const operation of command.operations) {
          if (operation.type !== 'create') continue
          if (operation.element.kind === 'input')
            await emit({
              type: 'input',
              sequence: ++sequence,
              window_id: command.window_id,
              node_id: operation.node_id,
              tree_revision: command.base_revision + 1,
              path: [roots.get(command.window_id), operation.node_id],
              value: operation.element.value,
              input_revision: 1,
            })
          if (operation.element.kind === 'button') {
            const count =
              mode === 'flood'
                ? 129
                : mode === 'wrong-sequence'
                  ? 2
                  : mode === 'out-of-order-sequence'
                    ? 4
                    : 1
            for (let n = 0; n < count; n += 1) {
              const actual = ++sequence
              await emit({
                type: 'click',
                sequence:
                  mode === 'wrong-sequence'
                    ? 1
                    : mode === 'out-of-order-sequence'
                      ? [1, 3, 2][n]
                      : actual,
                window_id: command.window_id,
                node_id: operation.node_id,
                tree_revision: command.base_revision + 1,
                path: [roots.get(command.window_id), operation.node_id],
              })
            }
          }
        }
        if (mode === 'inherited-pipe-exit') setTimeout(() => process.exit(23), 25)
      }
    } else if (command.type === 'close') {
      await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
  }
}
decoder.finish()
