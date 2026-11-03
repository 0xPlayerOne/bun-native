// Real subprocess transport with deterministic synthetic events. This does not
// render, inject OS input or substitute for the native interaction fixtures.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { PeerTree } from './peer-tree.ts'

type Spec = { type: string; target: string; variant?: string }
const windows = new Map<number, PeerTree>()
const output = Bun.stdout.writer()
const decoder = new FrameDecoder()
let sequence = 0
async function emit(value: unknown) {
  output.write(encodeFrame(value))
  await output.flush()
}

async function event(window_id: number, tree: PeerTree, spec: Spec) {
  const target = [...tree.nodes].find(([, node]) =>
    node.element.kind === 'button'
      ? node.element.text === spec.target
      : node.element.kind === 'input' && node.element.placeholder === spec.target
  )
  if (!target) throw new Error('Unknown fixture event target')
  const [nodeId, node] = target
  const route = tree.route(nodeId)
  if (spec.variant === 'future') route.tree_revision++
  if (spec.variant === 'wrong-root') route.path = [nodeId]
  if (spec.variant === 'wrong-ancestry') route.path = [tree.rootId, nodeId]
  if (spec.variant === 'foreign-ancestor') {
    const other = [...windows].find(([id]) => id !== window_id)![1]
    route.path = [tree.rootId, other.rootId, nodeId]
  }
  const base = { type: spec.type, window_id, sequence: ++sequence, ...route }
  const modifiers = { control: true, alt: false, shift: true, platform: false, function: false }
  if (spec.type === 'key_down' || spec.type === 'key_up')
    await emit({ ...base, key: 'enter', key_char: '\r', modifiers })
  else if (spec.type === 'pointer_down' || spec.type === 'pointer_up')
    await emit({ ...base, button: 'right', x: 12.5, y: -4.25, modifiers })
  else if (spec.type === 'input') {
    if (node.element.kind !== 'input') throw new Error('Fixture input requires an input')
    if (spec.variant !== 'replayed-input') node.inputRevision++
    node.element = { ...node.element, value: 'native edit' }
    await emit({ ...base, value: node.element.value, input_revision: node.inputRevision })
  } else await emit(base)
}

for await (const chunk of Bun.stdin.stream()) {
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    if (command.type === 'hello') {
      await emit({
        type: 'ready',
        service_policy: {
          window_display: process.argv.includes('--bun-native-allow-window-display'),
        },
        protocol: PROTOCOL_VERSION,
        capabilities: [...REQUIRED_CAPABILITIES],
        limits: { ...DEFAULT_LIMITS },
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
      tree.apply(command.operations)
      await emit({
        type: 'applied',
        id: command.id,
        window_id: command.window_id,
        tree_revision: tree.revision,
      })
      for (const operation of command.operations) {
        if (
          operation.type === 'set' &&
          operation.element.kind === 'text' &&
          operation.element.text.startsWith('event:')
        )
          await event(command.window_id, tree, JSON.parse(operation.element.text.slice(6)) as Spec)
      }
    } else if (command.type === 'close') {
      windows.delete(command.window_id)
      await emit({ type: 'closed', window_id: command.window_id, sequence: ++sequence })
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
  }
}
decoder.finish()
