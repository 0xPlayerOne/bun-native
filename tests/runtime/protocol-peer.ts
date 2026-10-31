// A real subprocess that exercises channel failures. It does not render UI.
import { encodeFrame, FrameDecoder, parseCommand } from '@bun-native/protocol'

const mode = process.argv[2] ?? 'normal'
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
function emit(value: unknown): void {
  output.write(encodeFrame(value))
  output.flush()
}

for await (const chunk of Bun.stdin.stream()) {
  for (const value of decoder.push(chunk)) {
    const command = parseCommand(value)
    if (mode === 'silent') continue
    if (mode === 'exit') process.exit(23)
    if (command.type === 'hello') {
      if (mode === 'bad-json') {
        output.write('{bad json}\n')
        output.flush()
        continue
      }
      emit({ type: 'ready', protocol: mode === 'wrong-version' ? 2 : 1 })
      if (mode === 'duplicate-ready') {
        // A second ready is an invalid handshake transition.
        emit({ type: 'ready', protocol: 1 })
      }
      emit({
        type: mode === 'wrong-ack' ? 'opened' : 'ack',
        id: mode === 'wrong-id' ? 123 : command.id,
      })
    } else if (command.type === 'open') {
      emit({ type: 'opened', id: command.id })
      if (mode === 'flood') {
        for (let n = 0; n < 129; n += 1) emit({ type: 'click' })
      } else emit({ type: 'input', value: command.input })
    } else if (command.type === 'update') {
      if (command.text === 'reject')
        emit({
          type: 'error',
          id: command.id,
          code: 'invalid_state',
          message: 'Rejected by fixture',
        })
      else {
        emit({ type: 'ack', id: command.id })
        if (command.text === 'emit-click') emit({ type: 'click' })
      }
    } else if (command.type === 'close') {
      emit({ type: 'closed' })
      emit({ type: 'ack', id: command.id })
    } else {
      emit({ type: 'ack', id: command.id })
      await output.flush()
      process.exit(0)
    }
  }
}
decoder.finish()
