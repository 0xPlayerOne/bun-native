import { PassThrough } from 'node:stream'
import { NativeTransport } from '../../packages/runtime/src/native-transport.ts'
export interface Command {
  v: 1
  id: number
  op: string
  args: Record<string, unknown>
}
/** A protocol peer, not a CEF implementation. Native rendering is tested in CI. */
export async function nativePeer() {
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: Command[] = []
  let buffer = ''
  let handler: ((command: Command) => void) | undefined
  output.on('data', (bytes: Buffer) => {
    buffer += bytes.toString()
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const command = JSON.parse(buffer.slice(0, end)) as Command
      buffer = buffer.slice(end + 1)
      commands.push(command)
      handler?.(command)
    }
  })
  const transport = new NativeTransport(input, output)
  const send = (value: unknown) => {
    input.write(JSON.stringify(value) + '\n')
  }
  send({ v: 1, event: 'ready', abi: 1, cef: '154.0.34' })
  await transport.ready
  return {
    transport,
    input,
    output,
    commands,
    send,
    handle(callback: (command: Command) => void) {
      handler = callback
    },
    reply(command: Command, value: unknown = null) {
      send({ v: 1, id: command.id, ok: true, value })
    },
    reject(command: Command, error = 'Native fixture rejection') {
      send({ v: 1, id: command.id, ok: false, error })
    },
    stop() {
      if (!input.destroyed) send({ v: 1, event: 'shutdown' })
      return transport.closed
    },
  }
}
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
