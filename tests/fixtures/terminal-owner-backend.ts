import { resolve } from 'node:path'
import type { BinaryStreamWriter, StreamOutcome } from '../../packages/contracts/src/streams.ts'
import { TerminalService } from '../../packages/runtime/src/terminal.ts'
import { NativeTerminalDriver } from '../../packages/runtime/src/terminal-owner.ts'

const [owner, python] = process.argv.slice(2)
if (!owner || !python || Bun.version !== '1.4.3')
  throw new Error('Pinned owner fixture arguments required')
let finish!: (value: StreamOutcome) => void
let output = ''
let sent = false
const writer: BinaryStreamWriter = {
  finished: new Promise<StreamOutcome>((resolve) => {
    finish = resolve
  }),
  async write(bytes) {
    output += Buffer.from(bytes).toString()
    if (!sent && output.includes('\n')) {
      const record = JSON.parse(output.slice(0, output.indexOf('\n')))
      sent = true
      console.log(JSON.stringify(record))
    }
  },
  async end() {
    finish({ ok: true })
  },
  cancel() {
    finish({ ok: false, code: 'CANCELLED' })
  },
}
const service = new TerminalService({ driver: new NativeTerminalDriver(owner) })
const handle = await service.create({}, writer, {
  executable: '/bin/sh',
  argv: [
    '-c',
    'trap "" HUP TERM; exec 9<&0; "$1" "$2" <&9 & wait $!',
    'bunly-owned-shell',
    python,
    resolve('tests/fixtures/terminal-owner-server.py'),
  ],
  cwd: process.cwd(),
  env: {},
})
const observation = service.observe(handle)
for await (const bytes of Bun.stdin.stream()) {
  const command = Buffer.from(bytes).toString().trim()
  if (command === 'exit-backend') process.exit(23)
  if (command === 'natural') {
    await service.write(handle, new TextEncoder().encode('exit\n'))
    await observation.released
    console.log(
      JSON.stringify({
        event: 'result',
        process: await observation.processExited,
        output: await observation.outputFinished,
        final: output.includes('FINAL-' + 'x'.repeat(8192)),
      })
    )
    break
  }
  if (command === 'close' || command === 'cancel') {
    const result = await service[command](handle)
    console.log(
      JSON.stringify({ event: 'result', result, process: await observation.processExited })
    )
    break
  }
}
await service.dispose()
