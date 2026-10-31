// Headless transport peer for public API lifecycle tests. It is not a renderer
// or a substitute for native transaction validation or GUI acceptance.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { PeerTree } from './peer-tree.ts'

const mode = process.argv[2] ?? 'normal'
const windows = new Map<number, PeerTree>()
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
    if (command.type === 'hello') {
      const limits =
        mode === 'small'
          ? {
              ...DEFAULT_LIMITS,
              max_windows: 2,
              max_nodes_per_window: 4,
              max_operations: 6,
              max_depth: 2,
              max_text_bytes: 32,
              max_text_bytes_per_window: 40,
            }
          : { ...DEFAULT_LIMITS }
      await emit({
        type: 'ready',
        service_policy: {
          window_display: process.argv.includes('--bun-native-allow-window-display'),
          clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
          clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
        },
        protocol: PROTOCOL_VERSION,
        capabilities: [...REQUIRED_CAPABILITIES],
        limits,
      })
      await emit({ type: 'ack', id: command.id })
    } else if (command.type === 'open') {
      windows.set(command.window_id, new PeerTree(command.root_id))
      await emit({
        type: 'opened',
        id: command.id,
        window_id: command.window_id,
        root_id: command.root_id,
        tree_revision: 0,
      })
    } else if (command.type === 'batch') {
      const tree = windows.get(command.window_id)!
      const nodes = tree.nodes
      const marker = command.operations.find(
        (operation) => operation.type === 'set' && operation.element.kind === 'text'
      )
      const text =
        marker?.type === 'set' && marker.element.kind === 'text' ? marker.element.text : ''
      if (text === 'reject transaction') {
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_state',
          message: 'Requested test rejection',
        })
        continue
      }
      const deleted = command.operations.find((operation) => operation.type === 'delete')
      const deletedRoute = deleted?.type === 'delete' ? tree.route(deleted.node_id) : undefined
      tree.apply(command.operations)
      if (text === 'input before acknowledgement') {
        const input = [...nodes].find(([, node]) => node.element.kind === 'input')!
        input[1].inputRevision += 1
        await emit({
          type: 'input',
          sequence: ++sequence,
          window_id: command.window_id,
          ...tree.route(input[0], command.base_revision),
          value: 'newer native edit',
          input_revision: input[1].inputRevision,
        })
        await Bun.sleep(10)
      }
      await emit({
        type: 'applied',
        id: command.id,
        window_id: command.window_id,
        tree_revision: command.base_revision + 1,
      })
      if (text === 'emit click') {
        const button = [...nodes].find(([, node]) => node.element.kind === 'button')!
        await emit({
          type: 'click',
          sequence: ++sequence,
          window_id: command.window_id,
          ...tree.route(button[0]),
        })
      }
      if (mode === 'late-event' && deletedRoute)
        await emit({
          type: 'click',
          sequence: ++sequence,
          window_id: command.window_id,
          ...deletedRoute,
        })
      if (mode === 'wrong-owner' && text === 'emit wrong owner') {
        const other = [...windows].find(([id]) => id !== command.window_id)!
        const button = [...other[1].nodes].find(([, node]) => node.element.kind === 'button')!
        await emit({
          type: 'click',
          sequence: ++sequence,
          window_id: command.window_id,
          node_id: button[0],
          path: [tree.rootId, button[0]],
          tree_revision: tree.revision,
        })
      }
    } else if (command.type === 'close') {
      windows.delete(command.window_id)
      await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
  }
}
decoder.finish()
