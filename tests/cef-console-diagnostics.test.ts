import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

test('console observation is opt-in, opaque-view scoped, bounded and retired with its owner', async () => {
  const peer = await nativePeer()
  let id = 0
  peer.handle((command) =>
    peer.reply(command, command.op.endsWith('.create') ? { id: ++id } : null)
  )
  const backend = new CefBackend(peer.transport)
  const mock = new MockBackend()
  try {
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'console' })
    const window = await backend.createWindow({
      title: 'console',
      bounds: { x: 0, y: 0, width: 320, height: 240 },
    })
    const view = await backend.createView({
      session,
      window,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const messages: string[] = []
    assert.throws(() => backend.onViewConsole({ ...view }, () => {}))
    const abort = new AbortController()
    backend.onViewConsole(view, (message) => messages.push(message), { signal: abort.signal })
    backend.onViewConsole(view, () => {
      throw new Error('listener failure')
    })
    peer.send({ v: 1, event: 'view.console', target: 3, data: { message: 'hello' } })
    await turn()
    assert.deepEqual(messages, ['hello'])
    assert.equal(backend.diagnostics().listenerErrors, 1)
    abort.abort()
    peer.send({ v: 1, event: 'view.console', target: 3, data: { message: 'ignored' } })
    await turn()
    assert.deepEqual(messages, ['hello'])
    await backend.disposeView(view)
    assert.equal(backend.diagnostics().listeners, 0)
    assert.throws(() => backend.onViewConsole(view, () => {}))
    const ms = await mock.createSession({ persistence: 'ephemeral', partition: 'mock' })
    const mw = await mock.createWindow({
      title: 'mock',
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    })
    const mv = await mock.createView({
      session: ms,
      window: mw,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    assert.throws(() => mock.onViewConsole(mv, () => {}), /does not implement/)
  } finally {
    await mock.dispose()
    await peer.stop()
  }
})
