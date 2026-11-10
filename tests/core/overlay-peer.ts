// Real subprocess transport for the overlay and split contracts. It advertises
// the optional capabilities only when asked and emits deterministic routed
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

/**
 * `target` is a button label, an input placeholder (for `input`), `overlay#N`
 * or `split#N`, the Nth created one.
 * `activate` clicks the button the last focus request moved to, as Enter does
 * natively.
 */
type Spec = {
  type: 'key_down' | 'pointer_down' | 'dismiss' | 'click' | 'activate' | 'split_resize' | 'input'
  target?: string
  key?: string
  shift?: boolean
  /** Explicit modifier flags, merged over the all-false default. */
  modifiers?: Partial<Record<'control' | 'alt' | 'shift' | 'platform' | 'function', boolean>>
  control?: boolean
  ratio?: number
  source?: 'pointer' | 'keyboard'
}
const windows = new Map<number, PeerTree>()
const focused = new Map<number, number>()
const output = Bun.stdout.writer()
const decoder = new FrameDecoder()
const overlays = process.argv.includes('--overlays')
const keyboard = process.argv.includes('--keyboard')
const popups = process.argv.includes('--popups')
const splits = process.argv.includes('--splits')
const splitResize = process.argv.includes('--split-resize')
const inputStates = process.argv.includes('--input-states')
const decoration = process.argv.includes('--decoration')
let sequence = 0
async function emit(value: unknown) {
  output.write(encodeFrame(value))
  await output.flush()
}

async function event(window_id: number, tree: PeerTree, spec: Spec) {
  if (spec.type === 'activate') {
    const node_id = focused.get(window_id)
    if (node_id === undefined || !tree.nodes.has(node_id)) throw new Error('Nothing is focused')
    await emit({ type: 'click', window_id, sequence: ++sequence, ...tree.route(node_id) })
    return
  }
  if (spec.target === undefined) throw new Error('Fixture event needs a target')
  const kind = spec.target.split('#')[0]
  const created = [...tree.nodes].filter(([, node]) => node.element.kind === kind)
  const target = spec.target.includes('#')
    ? created[Number(spec.target.split('#')[1])]
    : [...tree.nodes].find(([, node]) =>
        spec.type === 'input'
          ? node.element.kind === 'input' && node.element.placeholder === spec.target
          : (node.element.kind === 'button' && node.element.text === spec.target) ||
            // A key press may also target an input by its placeholder.
            (spec.type === 'key_down' &&
              node.element.kind === 'input' &&
              node.element.placeholder === spec.target)
      )
  if (!target) throw new Error('Unknown fixture event target')
  const modifiers = {
    control: spec.control === true,
    alt: false,
    shift: spec.shift === true,
    platform: false,
    function: false,
    ...spec.modifiers,
  }
  const base = { type: spec.type, window_id, sequence: ++sequence, ...tree.route(target[0]) }
  if (spec.type === 'input') {
    const node = target[1]
    if (node.element.kind !== 'input') throw new Error('Fixture input requires an input')
    node.inputRevision++
    node.element = { ...node.element, value: 'native edit' }
    await emit({ ...base, value: node.element.value, input_revision: node.inputRevision })
  } else if (spec.type === 'dismiss') await emit({ ...base, reason: 'window_blur' })
  else if (spec.type === 'click') await emit(base)
  else if (spec.type === 'split_resize')
    await emit({ ...base, ratio: spec.ratio, source: spec.source })
  else if (spec.type === 'key_down') await emit({ ...base, key: spec.key ?? 'escape', modifiers })
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
          drag_drop: false,
          filesystem_roots: [],
          processes: [],
        },
        protocol: PROTOCOL_VERSION,
        capabilities: [
          ...REQUIRED_CAPABILITIES,
          ...(overlays ? ['overlays_v1', 'scroll_anchor_v1'] : []),
          ...(keyboard ? ['focus_v1', 'scroll_control_v1', 'overlay_keyboard_v1'] : []),
          ...(popups ? ['popup_windows_v1'] : []),
          ...(splits ? ['split_v1'] : []),
          ...(splitResize ? ['split_resize_v1', 'accessibility_v1'] : []),
          ...(inputStates ? ['input_states_v1'] : []),
          ...(decoration ? ['style_decoration_v1'] : []),
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
      // A host reports a requested focus move as an ordinary focus event; the
      // peer gives scroll requests no observable effect.
      for (const operation of command.operations)
        if (operation.type === 'focus') {
          focused.set(command.window_id, operation.node_id)
          await emit({
            type: 'focus',
            window_id: command.window_id,
            sequence: ++sequence,
            ...tree.route(operation.node_id),
          })
        }
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
