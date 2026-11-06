// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a native menu bar was shown or that a user selected it.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type AppMenuEntry,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('App menu peer requires its owned control directory')
const mode = process.argv[3] ?? 'hold'
const granted = process.argv.includes('--bun-native-allow-app-menu')
const policy = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  drag_drop: false,
  filesystem_roots: [],
  processes: [],
  // Omitted when denied, exactly like the native host.
  ...(granted ? { app_menu: true } : {}),
}
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let writing = Promise.resolve()
let sequence = 0
let previous: number | undefined

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

function firstItem(entries: readonly AppMenuEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind === 'item') return entry.id
    if (entry.kind === 'submenu') {
      const found = firstItem(entry.items)
      if (found) return found
    }
  }
  return undefined
}

const select = (menu_id: number, item_id: string) =>
  emit({ type: 'app_menu_item', sequence: ++sequence, menu_id, item_id })

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
            mode === 'unavailable' || mode === 'forged'
              ? REQUIRED_CAPABILITIES
              : [...REQUIRED_CAPABILITIES, 'app_menu_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: policy,
        })
        await emit({ type: 'ack', id: command.id })
        if (mode === 'forged') await select(1, 'forged')
        break
      case 'open':
        await emit({
          type: 'opened',
          id: command.id,
          window_id: command.window_id,
          root_id: command.root_id,
          tree_revision: 0,
        })
        break
      case 'close':
        await emit({ type: 'ack', id: command.id })
        await emit({ type: 'closed', sequence: ++sequence, window_id: command.window_id })
        break
      case 'set_app_menu': {
        const code = !granted
          ? 'permission_denied'
          : mode === 'fail'
            ? 'native_failure'
            : previous !== undefined && command.menu_id <= previous
              ? 'invalid_state'
              : undefined
        if (code) {
          await emit({ type: 'error', id: command.id, code, message: 'Headless outcome' })
          break
        }
        const stale = previous
        previous = command.menu_id
        await emit({ type: 'app_menu_set', id: command.id, menu_id: command.menu_id })
        const item = command.menus.map((menu) => firstItem(menu.items)).find(Boolean)
        if (mode === 'select' && item) await select(command.menu_id, item)
        // A selection AppKit queued for the previous bar arrives after the new one.
        if (mode === 'stale' && stale !== undefined) {
          await select(stale, 'stale')
          if (item) await select(command.menu_id, item)
        }
        if (mode === 'unallocated') await select(command.menu_id + 1, 'unallocated')
        break
      }
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected app menu peer command')
    }
  }
