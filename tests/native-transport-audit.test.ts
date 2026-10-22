import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { nativePeer, turn } from './helpers/native-peer.ts'

// These use actual streams and timers, but are protocol tests, not native browser acceptance.
test('native cancellation retains its original acknowledgement deadline', async () => {
  const f = await nativePeer()
  try {
    const abort = new AbortController()
    const call = f.transport.call('view.navigate', {}, abort.signal, 20)
    const rejected = assert.rejects(call, /abort/i)
    abort.abort()
    await rejected
    await Promise.race([
      f.transport.closed,
      Bun.sleep(250).then(() => {
        throw new Error('Unacknowledged cancellation never retired')
      }),
    ])
    assert.match(String(f.transport.failure), /deadline/)
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})

test('a late cancellation reply cancels the retained deadline', async () => {
  const f = await nativePeer()
  try {
    const abort = new AbortController()
    const call = f.transport.call('view.navigate', {}, abort.signal, 25)
    const rejected = assert.rejects(call, /abort/i)
    abort.abort()
    await rejected
    f.reply(f.commands[0]!)
    await turn()
    await Bun.sleep(40)
    assert.equal(f.transport.diagnostics().closed, false)
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})

test('cancelled and pending native requests share one capacity budget', async () => {
  const f = await nativePeer()
  try {
    for (let n = 0; n < 64; n++) {
      const abort = new AbortController()
      const call = f.transport.call('view.navigate', {}, abort.signal)
      const rejected = assert.rejects(call, /abort/i)
      abort.abort()
      await rejected
    }
    const calls = Array.from({ length: 64 }, () => f.transport.call('diagnostics'))
    const settled = Promise.allSettled(calls)
    await assert.rejects(f.transport.call('diagnostics'), /capacity/)
    assert.equal(f.commands.length, 128)
    for (const command of f.commands) f.reply(command)
    assert.ok((await settled).every((value) => value.status === 'fulfilled'))
  } finally {
    await f.stop()
  }
})

test('abort during argument serialization never writes a native request', async () => {
  const f = await nativePeer()
  try {
    const abort = new AbortController()
    await assert.rejects(
      f.transport.call(
        'diagnostics',
        {
          toJSON() {
            abort.abort()
            return {}
          },
        },
        abort.signal
      ),
      /abort/i
    )
    assert.equal(f.commands.length, 0)
  } finally {
    await f.stop()
  }
})

test('reentrant serialization cannot duplicate or replace pending request identities', async () => {
  const f = await nativePeer()
  try {
    let nested: Promise<unknown> | undefined
    const outer = f.transport.call('diagnostics', {
      toJSON() {
        nested = f.transport.call('diagnostics')
        return { snapshot: true }
      },
    })
    assert.deepEqual(
      f.commands.map((command) => command.id),
      [1, 2]
    )
    f.reply(f.commands[1]!, 'outer')
    f.reply(f.commands[0]!, 'nested')
    assert.equal(await outer, 'outer')
    assert.equal(await nested, 'nested')
  } finally {
    await f.stop()
  }
})

test('transport closure during serialization does not admit a new pending request', async () => {
  const f = await nativePeer()
  try {
    await assert.rejects(
      f.transport.call('diagnostics', {
        toJSON() {
          f.transport.fail(new Error('fixture close'))
          return {}
        },
      }),
      /not ready/
    )
    assert.equal(f.commands.length, 0)
    assert.equal(f.transport.diagnostics().requests, 0)
  } finally {
    await f.stop()
  }
})

test('native delivery snapshots listeners and keeps protocol metadata immutable', async () => {
  const f = await nativePeer()
  const calls: string[] = []
  let remove = () => {}
  let once = false
  const immutable: boolean[] = []
  f.transport.onEvent((event) => {
    if (event.event !== 'view.loaded') return
    calls.push('first')
    remove()
    if (!once) {
      once = true
      f.transport.onEvent((next) => {
        if (next.event === 'view.loaded') calls.push('new')
      })
    }
    immutable.push(Object.isFrozen(event), Object.isFrozen(event.data))
  })
  remove = f.transport.onEvent(() => calls.push('removed'))
  try {
    f.send({ v: 1, event: 'view.loaded', target: 1, data: { url: 'app://ui/index.html' } })
    await turn()
    assert.deepEqual(calls, ['first'])
    f.send({ v: 1, event: 'view.loaded', target: 1, data: { url: 'app://ui/index.html' } })
    await turn()
    assert.deepEqual(calls, ['first', 'first', 'new'])
    assert.deepEqual(immutable, [true, true, true, true])
  } finally {
    await f.stop()
  }
})
