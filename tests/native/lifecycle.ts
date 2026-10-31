import { NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// Explicit native integration entry point. Default unit tests never substitute
// a fake process for this target: CI supplies the host it just built.
const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the built native host')
const host = await NativeHost.launch({ executable: resolve(executable) })
const events = host[Symbol.asyncIterator]()
const cycles = 5

try {
  await assert.rejects(host.send({ type: 'close' }), /invalid_state/)
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await host.send({
      type: 'open',
      title: 'Bun Native lifecycle',
      text: `Cycle ${cycle}`,
      input: '',
    })
    await assert.rejects(
      host.send({ type: 'open', title: 'Duplicate', text: '', input: '' }),
      /invalid_state/
    )
    await host.send({ type: 'update', text: `Updated ${cycle}`, input: 'é🙂漢' })
    await host.send({ type: 'close' })
    assert.deepEqual(await events.next(), { done: false, value: { type: 'closed' } })
  }
} finally {
  await host.shutdown()
}

await host.shutdown()
assert.equal(await host.exited, 0)
console.log(JSON.stringify({ status: 'passed', nativeWindowCycles: cycles, nativeExitCode: 0 }))
