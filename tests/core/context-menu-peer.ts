// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that an OS menu was shown or that a user chose an item.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('Context menu peer requires its owned control directory')
const mode = process.argv[3] ?? 'hold'
const policy = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  drag_drop: false,
  filesystem_roots: [],
  processes: [],
}
const windows = new Set<number>()
const live = new Map<number, number>()
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

const complete = (window_id: number, menu_id: number, item_id?: string) =>
  emit({
    type: 'context_menu_completed',
    sequence: ++sequence,
    window_id,
    menu_id,
    ...(item_id === undefined ? {} : { item_id }),
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
            mode === 'unsupported'
              ? [...REQUIRED_CAPABILITIES, 'overlays_v1', 'focus_v1']
              : [...REQUIRED_CAPABILITIES, 'overlays_v1', 'focus_v1', 'context_menus_v1'],
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
      case 'show_context_menu': {
        const { window_id, menu_id, items } = command
        const code = !windows.has(window_id)
          ? 'invalid_handle'
          : mode === 'unavailable'
            ? 'service_unavailable'
            : live.size > 0
              ? 'limit_exceeded'
              : undefined
        if (code) {
          await emit({ type: 'error', id: command.id, code, message: 'Headless outcome' })
          break
        }
        live.set(menu_id, window_id)
        await emit({ type: 'context_menu_opened', id: command.id, window_id, menu_id })
        const finish = async (item?: string) => {
          live.delete(menu_id)
          await complete(window_id, menu_id, item)
        }
        if (mode === 'choose-nested') {
          const submenu = items.find((item) => item.kind === 'submenu')
          const nested = submenu?.kind === 'submenu' ? submenu.items[0] : undefined
          await finish(nested?.kind === 'item' ? nested.id : undefined)
        }
        if (mode === 'dismiss') await finish()
        if (mode === 'foreign-item') await finish('not-given')
        if (mode === 'unallocated') await complete(window_id, menu_id + 1000, 'copy')
        break
      }
      case 'close_context_menu':
        if (live.get(command.menu_id) !== command.window_id) {
          await emit({ type: 'error', id: command.id, code: 'invalid_handle', message: 'gone' })
          break
        }
        live.delete(command.menu_id)
        await emit({
          type: 'context_menu_closed',
          id: command.id,
          window_id: command.window_id,
          menu_id: command.menu_id,
        })
        // A choice the OS queued before the close reaches the client late.
        if (mode === 'late') await complete(command.window_id, command.menu_id, 'copy')
        break
      case 'close':
        windows.delete(command.window_id)
        await emit({ type: 'ack', id: command.id })
        for (const [menu, owner] of live) if (owner === command.window_id) live.delete(menu)
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected context menu peer command')
    }
  }
