import { PassThrough } from 'node:stream'
import { NativeTransport } from '../../packages/runtime/src/native-transport.ts'
export interface Command {
  v: 1
  id: number
  op: string
  args: Record<string, unknown>
}
/** A protocol peer, not a CEF implementation. Native rendering is tested in CI. */
export async function nativePeer(options: { readonly desktopCapabilities?: unknown } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: Command[] = []
  let buffer = ''
  const documents = new Map<number, number>()
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
    if (value && typeof value === 'object') {
      const frame = value as Record<string, unknown>
      if (
        (frame['event'] === 'view.navigating' || frame['event'] === 'view.loaded') &&
        Number.isSafeInteger(frame['target']) &&
        frame['data'] &&
        typeof frame['data'] === 'object' &&
        typeof (frame['data'] as Record<string, unknown>)['url'] === 'string' &&
        (frame['data'] as Record<string, unknown>)['documentId'] === undefined
      ) {
        const target = Number(frame['target'])
        const generation = (documents.get(target) ?? 1) + 1
        documents.set(target, generation)
        ;(frame['data'] as Record<string, unknown>)['documentId'] = `native-${target}-${generation}`
      }
    }
    input.write(JSON.stringify(value) + '\n')
  }
  const desktopCapabilities = Object.hasOwn(options, 'desktopCapabilities')
    ? options.desktopCapabilities
    : { version: 1, capabilities: ['window.state', 'window.geometry', 'view.composition'] }
  send({ v: 1, event: 'ready', abi: 1, cef: '156.0.7', data: { desktopCapabilities } })
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
      if (
        command.op === 'view.create' &&
        value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as Record<string, unknown>)['id']) &&
        (value as Record<string, unknown>)['documentId'] === undefined
      ) {
        const id = Number((value as Record<string, unknown>)['id'])
        documents.set(id, 1)
        ;(value as Record<string, unknown>)['documentId'] = `native-${id}-1`
      }
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
