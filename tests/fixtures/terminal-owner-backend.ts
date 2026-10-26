import { OwnerTerminalConsumer, ownerFixtureExitInput } from './terminal-owner-consumer.ts'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { BinaryStreamWriter, StreamOutcome } from '../../packages/contracts/src/streams.ts'
import { TerminalService } from '../../packages/runtime/src/terminal.ts'
import { NativeTerminalDriver } from '../../packages/runtime/src/terminal-owner.ts'

const [owner, python] = process.argv.slice(2)
if (!owner || !python || Bun.version !== '1.4.3')
  throw new Error('Pinned owner fixture arguments required')
let finish!: (value: StreamOutcome) => void
const output = new OwnerTerminalConsumer((record) => {
  console.log(JSON.stringify({ ...record, backend: process.pid }))
})
const writer: BinaryStreamWriter = {
  finished: new Promise<StreamOutcome>((resolve) => {
    finish = resolve
  }),
  async write(bytes) {
    await output.consume(bytes)
  },
  async end() {
    finish({ ok: true })
  },
  cancel() {
    finish({ ok: false, code: 'CANCELLED' })
  },
}
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const gate = await input.next()
if (gate.value !== 'go') throw new Error('Native fixture admission missing')
const configuration = JSON.parse(process.env['BUNLY_FIXTURE_OWNER_CONFIG']!)
const service = new TerminalService({
  driver: new NativeTerminalDriver(configuration, 'non-detaching'),
})
if (process.env['BUNLY_FIXTURE_SCENARIO'] === 'spawn-failure') {
  for (let index = 0; index < 66; index++) {
    let rejected = false
    try {
      await service.create(
        {},
        {
          finished: new Promise<StreamOutcome>(() => {}),
          async write() {},
          async end() {},
          cancel() {},
        },
        { executable: resolve('never-present-bunly-command'), cwd: process.cwd() }
      )
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('Missing command unexpectedly launched')
    const deadline = performance.now() + 1000
    while (service.diagnostics().terminals !== 0 && performance.now() < deadline) await Bun.sleep(1)
    if (service.diagnostics().terminals !== 0) throw new Error('No-command reservation leaked')
  }
  console.log(JSON.stringify({ case: 'spawn-failure', attempts: 66, passed: true }))
  await service.dispose()
  process.exit(0)
}
const handle = await service.create({}, writer, {
  executable: process.platform === 'win32' ? process.env['ComSpec']! : '/bin/sh',
  argv:
    process.platform === 'win32'
      ? ['/d', '/s', '/c', resolve('tests/fixtures/terminal-owner-shell.cmd')]
      : [
          '-c',
          'trap "" HUP TERM; exec 9<&0; "$1" "$2" "$3" <&9 & wait $!',
          'bunly-owned-shell',
          python,
          resolve('tests/fixtures/terminal-owner-server.py'),
          '',
        ],
  cwd: process.cwd(),
  env: {
    BUNLY_FIXTURE_SOURCE_FD: String(configuration.hostFd),
    BUNLY_OWNER_FIXTURE_PYTHON: python,
    BUNLY_OWNER_FIXTURE_TERMINAL: '1',
  },
})
const observation = service.observe(handle)
for await (const command of input) {
  if (command === 'hang-backend') {
    console.log(JSON.stringify({ event: 'hung' }))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  if (command === 'exit-backend') process.exit(23)
  if (command === 'natural') {
    await service.write(handle, ownerFixtureExitInput(process.platform))
    await observation.released
    console.log(
      JSON.stringify({
        event: 'result',
        process: await observation.processExited,
        output: await observation.outputFinished,
        final: output.final,
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
output.dispose()
process.exit(0)
