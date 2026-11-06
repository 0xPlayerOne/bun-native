// Real subprocess transport for the overlay contract. It advertises the
// optional overlay capabilities only when asked and emits deterministic routed
// events; it does not render, trap focus or substitute for the native fixture.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { PeerTree } from './peer-tree.ts'

/** `target` is a button label or `overlay#N`, the Nth created overlay. */
type Spec = { type: 'key_down' | 'pointer_down'; target: string; key?: string; shift?: boolean }
const windows = new Map<number, PeerTree>()
const output = Bun.stdout.writer()
const decoder = new FrameDecoder()
const overlays = process.argv.includes('--overlays')
let sequence = 0
async function emit(value: unknown) {
  output.write(encodeFrame(value))
  await output.flush()
}

async function event(window_id: number, tree: PeerTree, spec: Spec) {
  const created = [...tree.nodes].filter(([, node]) => node.element.kind === 'overlay')
  const target = spec.target.startsWith('overlay#')
    ? created[Number(spec.target.slice(8))]
    : [...tree.nodes].find(
        ([, node]) => node.element.kind === 'button' && node.element.text === spec.target
      )
  if (!target) throw new Error('Unknown fixture event target')
  const modifiers = {
    control: false,
    alt: false,
    shift: spec.shift === true,
    platform: false,
    function: false,
  }
  const base = { type: spec.type, window_id, sequence: ++sequence, ...tree.route(target[0]) }
  if (spec.type === 'key_down') await emit({ ...base, key: spec.key ?? 'escape', modifiers })
  else await emit({ ...base, button: 'left', x: 4, y: 4, modifiers })
}

for await (const chunk of Bun.stdin.stream()) {
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    if (command.type === 'hello') {
      await emit({
        type: 'ready',
        service_policy: {
          window_display: false,
          clipboard_read: false,
          clipboard_write: false,
          global_shortcuts: false,
          notifications: false,
          filesystem_roots: [],
          processes: [],
        },
        protocol: PROTOCOL_VERSION,
        capabilities: [
          ...REQUIRED_CAPABILITIES,
          ...(overlays ? ['overlays_v1', 'scroll_anchor_v1'] : []),
        ],
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
      for (const operation of command.operations)
        if (
          operation.type === 'set' &&
          operation.element.kind === 'text' &&
          operation.element.text.startsWith('event:')
        )
          for (const spec of JSON.parse(operation.element.text.slice(6)) as Spec[])
            await event(command.window_id, tree, spec)
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
