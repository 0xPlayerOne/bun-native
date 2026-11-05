// Real pipe/process lifecycle, deliberately headless responses. This peer is
// never evidence that a file was read, written or confined.
import {
  DEFAULT_LIMITS,
  filesystemRootsFromArguments,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? ''
if (!directory) throw new Error('File peer requires its owned control directory')
const mode = process.argv[3] ?? 'normal'
const roots = filesystemRootsFromArguments(process.argv)
const policy = {
  window_display: process.argv.includes('--bun-native-allow-window-display'),
  clipboard_read: process.argv.includes('--bun-native-allow-clipboard-read'),
  clipboard_write: process.argv.includes('--bun-native-allow-clipboard-write'),
  global_shortcuts: process.argv.includes('--bun-native-allow-global-shortcuts'),
  notifications: process.argv.includes('--bun-native-allow-notifications'),
  filesystem_roots:
    mode === 'policy' ? roots.map((root) => ({ ...root, access: 'read_write' })) : roots,
}
const grants = new Map<number, number>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let writing = Promise.resolve()

function emit(value: unknown): Promise<void> {
  writing = writing.then(async () => {
    output.write(encodeFrame(value))
    await output.flush()
  })
  return writing
}

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
              : [...REQUIRED_CAPABILITIES, 'filesystem_grants_v1'],
          limits: DEFAULT_LIMITS,
          service_policy: policy,
        })
        await emit({ type: 'ack', id: command.id })
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
      case 'open_file_grant':
        grants.set(command.grant_id, command.window_id)
        await emit({
          type: 'file_grant_opened',
          id: command.id,
          window_id: command.window_id,
          grant_id: command.grant_id,
        })
        break
      case 'close_file_grant':
        grants.delete(command.grant_id)
        await emit({
          type: 'file_grant_closed',
          id: command.id,
          window_id: command.window_id,
          grant_id: command.grant_id,
        })
        break
      case 'file_request': {
        const answer = () =>
          emit({
            type: 'file_result',
            id: command.id,
            window_id: command.window_id,
            grant_id: command.grant_id,
            result:
              mode === 'mismatch'
                ? { kind: 'done' }
                : command.operation.kind === 'read'
                  ? { kind: 'read', data: 'aGk=', end_of_file: true }
                  : command.operation.kind === 'stat'
                    ? { kind: 'stat', file_kind: 'file', size: 2, modified_ms: 7 }
                    : command.operation.kind === 'write'
                      ? { kind: 'written', bytes: 2 }
                      : command.operation.kind === 'list'
                        ? {
                            kind: 'list',
                            entries: [{ name: 'a', kind: 'file' }],
                            complete: true,
                            omitted: 1,
                          }
                        : { kind: 'done' },
          })
        if (mode === 'slow') setTimeout(() => void answer(), 100)
        else await answer()
        break
      }
      case 'close':
        for (const [grant, owner] of grants) if (owner === command.window_id) grants.delete(grant)
        await emit({ type: 'ack', id: command.id })
        await emit({ type: 'closed', sequence: 1, window_id: command.window_id })
        break
      case 'shutdown':
        await emit({ type: 'ack', id: command.id })
        process.exit(0)
      default:
        throw new Error('Unexpected file peer command')
    }
  }
