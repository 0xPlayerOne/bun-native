// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a drag happened or that a path was resolved. A text node
// whose text starts with `drop:` scripts the drop events emitted after that
// commit, so tests can deliver late, foreign or malformed identities.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  filesystemRootsFromArguments,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { PeerTree } from './peer-tree.ts'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Drop peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  drag_drop: process.argv.includes('--bun-native-allow-drag-drop'),
  filesystem_roots: filesystemRootsFromArguments(process.argv),
}
const windows = new Map<number, PeerTree>()
const targets = new Map<number, number>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let sequence = 0
let writing = Promise.resolve()

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

const error = (id: number, code: string, message: string) =>
  emit({ type: 'error', id, code, message })

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
              : [...REQUIRED_CAPABILITIES, 'drag_drop_files_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: policy,
        })
        await emit({ type: 'ack', id: command.id })
        break
      case 'open':
        windows.set(command.window_id, new PeerTree(command.root_id))
        await emit({
          type: 'opened',
          id: command.id,
          window_id: command.window_id,
          root_id: command.root_id,
          tree_revision: 0,
        })
        break
      case 'batch': {
        const tree = windows.get(command.window_id)!
        tree.apply(command.operations)
        for (const [target, node] of targets) if (!tree.nodes.has(node)) targets.delete(target)
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
            operation.element.text.startsWith('drop:')
          )
            for (const event of JSON.parse(operation.element.text.slice(5)) as object[])
              await emit({ sequence: ++sequence, window_id: command.window_id, ...event })
        break
      }
      case 'register_drop_target':
        if (mode === 'unavailable') {
          await error(command.id, 'service_unavailable', 'No drag-and-drop backend')
          break
        }
        if (!policy.drag_drop) {
          await error(command.id, 'permission_denied', 'Drag and drop is not allowed')
          break
        }
        if (!windows.get(command.window_id)?.nodes.has(command.node_id)) {
          await error(command.id, 'invalid_handle', 'Unknown node')
          break
        }
        targets.set(command.target_id, command.node_id)
        await emit({
          type: 'drop_target_registered',
          id: command.id,
          window_id: command.window_id,
          target_id: command.target_id,
        })
        break
      case 'unregister_drop_target':
        if (!targets.delete(command.target_id)) {
          await error(command.id, 'invalid_handle', 'Unknown drop target')
          break
        }
        await emit({
          type: 'drop_target_unregistered',
          id: command.id,
          window_id: command.window_id,
          target_id: command.target_id,
        })
        break
      case 'resolve_dropped_item': {
        const answer = () =>
          command.root === 'work'
            ? emit({
                type: 'dropped_item_resolved',
                id: command.id,
                window_id: command.window_id,
                target_id: command.target_id,
                drop_id: command.drop_id,
                item: command.item,
                root: command.root,
                path: mode === 'absolute' ? '/etc/passwd' : 'a.txt',
              })
            : error(command.id, 'path_denied', 'Not beneath that root')
        if (mode === 'slow') setTimeout(() => void answer(), 100)
        else await answer()
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
      default:
        throw new Error('Unexpected drop peer command')
    }
  }
