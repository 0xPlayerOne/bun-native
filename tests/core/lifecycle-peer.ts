// Deterministic headless process peer for callback-lifecycle regressions. It
// exercises real pipes and event ordering; it does not render or validate GPUI.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type NativeEvent,
} from '@bun-native/protocol'
import { PeerTree, type PeerNode } from './peer-tree.ts'

const windows = new Map<number, PeerTree>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let sequence = 0

async function emit(event: NativeEvent): Promise<void> {
  output.write(encodeFrame(event))
  await output.flush()
}

function buttons(nodes: Map<number, PeerNode>): number[] {
  return [...nodes].filter(([, node]) => node.element.kind === 'button').map(([id]) => id)
}

async function click(
  window_id: number,
  node_id: number,
  tree = windows.get(window_id)!
): Promise<void> {
  await emit({ type: 'click', window_id, ...tree.route(node_id), sequence: ++sequence })
}

async function marker(window_id: number, value: string, tree: PeerTree): Promise<void> {
  const nodes = tree.nodes
  const ids = buttons(nodes)
  if (value === 'edge:click') {
    if (ids[0] === undefined) throw new Error('Test marker requires a button')
    await click(window_id, ids[0])
  } else if (value === 'edge:second-button') {
    if (ids[1] === undefined) throw new Error('Test marker requires two buttons')
    await click(window_id, ids[1])
  } else if (value.startsWith('edge:burst:')) {
    const count = Number(value.slice('edge:burst:'.length))
    if (![2, 4, 63, 64].includes(count) || ids[0] === undefined)
      throw new Error('Invalid bounded test burst')
    for (let index = 0; index < count; index++) await click(window_id, ids[0])
  } else if (value === 'edge:input') {
    const entry = [...nodes].find(([, node]) => node.element.kind === 'input')
    if (!entry) throw new Error('Test marker requires an input')
    const [node_id, node] = entry
    if (node.element.kind !== 'input') throw new Error('Test marker requires an input')
    node.inputRevision += 1
    node.element = { ...node.element, kind: 'input', value: 'sibling native edit' }
    await emit({
      type: 'input',
      window_id,
      ...tree.route(node_id),
      sequence: ++sequence,
      value: 'sibling native edit',
      input_revision: node.inputRevision,
    })
  } else if (value === 'edge:os-close') {
    windows.delete(window_id)
    await emit({ type: 'closed', window_id, sequence: ++sequence })
    // A previously buffered frame may outlive native window revocation.
    if (ids[0] !== undefined) await click(window_id, ids[0], tree)
  }
}

for await (const chunk of Bun.stdin.stream()) {
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    if (command.type === 'hello') {
      await emit({
        type: 'ready',
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
      const tree = windows.get(command.window_id)
      if (!tree) {
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_handle',
          message: 'Test window already closed',
        })
        continue
      }
      const markers = command.operations.flatMap((operation) =>
        operation.type === 'set' &&
        operation.element.kind === 'text' &&
        operation.element.text.startsWith('edge:')
          ? [operation.element.text]
          : []
      )
      const lateRoutes = command.operations.flatMap((operation) =>
        operation.type === 'delete' && tree.nodes.get(operation.node_id)?.element.kind === 'button'
          ? [tree.route(operation.node_id)]
          : []
      )
      tree.apply(command.operations)

      await emit({
        type: 'applied',
        id: command.id,
        window_id: command.window_id,
        tree_revision: command.base_revision + 1,
      })
      for (const value of markers) await marker(command.window_id, value, tree)
      for (const route of lateRoutes)
        await emit({ type: 'click', window_id: command.window_id, sequence: ++sequence, ...route })
    } else if (command.type === 'close') {
      const tree = windows.get(command.window_id)
      if (!tree) {
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_handle',
          message: 'Test window already closed',
        })
        continue
      }
      windows.delete(command.window_id)
      // Enough to distinguish synchronous revocation from acknowledgement-time
      // cleanup without relying on a test guessing when a native reply arrived.
      await Bun.sleep(25)
      await emit({ type: 'closed', window_id: command.window_id, sequence: ++sequence })
      const first = buttons(tree.nodes)[0]
      if (first !== undefined) await click(command.window_id, first, tree)
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
  }
}
decoder.finish()
