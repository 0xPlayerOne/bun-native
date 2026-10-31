// A real subprocess that exercises channel failures. It does not render UI.
import { encodeFrame, FrameDecoder, parseCommand } from '@bun-native/protocol'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trace } from './trace'

const mode = process.argv[2] ?? 'normal'
trace('peer', 'start', { mode, argv: process.argv, parent: process.ppid, revision: Bun.revision })
if (mode === 'pipe-holder') {
  const directory = process.argv[3]
  if (!directory) throw new Error('Pipe holder requires its private control directory')
  writeFileSync(join(directory, 'ready'), String(process.pid))
  trace('peer', 'holder-ready', { directory })
  const deadline = performance.now() + 10_000
  while (!existsSync(join(directory, 'release')) && performance.now() < deadline)
    await Bun.sleep(10)
  trace('peer', 'holder-stopped', { released: existsSync(join(directory, 'release')), directory })
  writeFileSync(join(directory, 'finished'), String(process.pid))
  process.exit(0)
}
if (mode === 'inherited-pipe-shutdown' || mode === 'inherited-pipe-exit') {
  const directory = process.argv[3]
  if (!directory) throw new Error('Inherited-pipe peer requires its private control directory')
  const holder = Bun.spawn([process.execPath, import.meta.path, 'pipe-holder', directory], {
    // A Windows child in the default libuv job is terminated when this peer
    // exits. Keep this self-expiring test helper outside that job so its
    // inherited pipe handles remain open until our private release handshake.
    detached: true,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  trace('peer', 'holder-spawned', { pid: holder.pid, directory })
  void holder.exited.then((code) => trace('peer', 'holder-exited', { pid: holder.pid, code }))
  const deadline = performance.now() + 5_000
  while (!existsSync(join(directory, 'ready'))) {
    if (performance.now() >= deadline) throw new Error('Pipe holder did not start')
    await Bun.sleep(10)
  }
}
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
async function emit(value: unknown): Promise<void> {
  trace('peer', 'emit-start', value)
  const bytes = encodeFrame(value)
  const written = output.write(bytes)
  trace('peer', 'emit-written', { written, bytes: bytes.byteLength })
  const flushed = output.flush()
  trace('peer', 'emit-flushing', { asynchronous: flushed instanceof Promise })
  const result = await flushed
  trace('peer', 'emit-flushed', { result })
}

for await (const chunk of Bun.stdin.stream()) {
  trace('peer', 'stdin-chunk', {
    bytes: chunk.byteLength,
    base64: Buffer.from(chunk).toString('base64'),
  })
  for (const value of decoder.push(chunk)) {
    const command = parseCommand(value)
    trace('peer', 'command', command)
    if (mode === 'silent') continue
    if (mode === 'exit') process.exit(23)
    if (command.type === 'hello') {
      if (mode === 'bad-json') {
        output.write('{bad json}\n')
        await output.flush()
        continue
      }
      await emit({ type: 'ready', protocol: mode === 'wrong-version' ? 2 : 1 })
      if (mode === 'duplicate-ready') {
        // A second ready is an invalid handshake transition.
        await emit({ type: 'ready', protocol: 1 })
      }
      await emit({
        type: mode === 'wrong-ack' ? 'opened' : 'ack',
        id: mode === 'wrong-id' ? 123 : command.id,
      })
    } else if (command.type === 'open') {
      await emit({ type: 'opened', id: command.id })
      if (mode === 'flood') {
        for (let n = 0; n < 129; n += 1) await emit({ type: 'click' })
      } else await emit({ type: 'input', value: command.input })
    } else if (command.type === 'update') {
      if (command.text === 'reject')
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_state',
          message: 'Rejected by fixture',
        })
      else {
        await emit({ type: 'ack', id: command.id })
        if (command.text === 'emit-click') await emit({ type: 'click' })
        if (mode === 'inherited-pipe-exit') setTimeout(() => process.exit(23), 25)
      }
    } else if (command.type === 'close') {
      await emit({ type: 'closed' })
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      trace('peer', 'exit', { code: 0 })
      process.exit(0)
    }
  }
}
decoder.finish()
