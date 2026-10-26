import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import type { WindowHandle } from '../packages/contracts/src/index.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

const state = {
  visible: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
  active: false,
}
const options = { title: 'state', bounds: { x: 0, y: 0, width: 320, height: 240 } }
const operations = ['windowState', 'minimizeWindow', 'restoreWindow'] as const
async function fixture() {
  const peer = await nativePeer()
  let id = 0
  peer.handle((command) =>
    peer.reply(command, command.op.endsWith('.create') ? { id: ++id } : state)
  )
  const backend = new CefBackend(peer.transport)
  const window = await backend.createWindow(options)
  return { ...peer, backend, window }
}

test('CEF window actions return immutable actual readback, never requested intent', async () => {
  const f = await fixture()
  try {
    for (const method of operations) {
      const result = await f.backend[method](f.window)
      assert.deepEqual(result, state)
      assert.ok(Object.isFrozen(result))
    }
    assert.deepEqual(
      f.commands.slice(1).map((c) => [c.op, c.args]),
      [
        ['window.state', { id: 1 }],
        ['window.minimize', { id: 1 }],
        ['window.restore', { id: 1 }],
      ]
    )
  } finally {
    await f.stop()
  }
})

test('window state rejects forged, foreign, wrong-kind, closing and stale handles', async () => {
  const f = await fixture(),
    other = await fixture()
  try {
    const session = await f.backend.createSession({ persistence: 'ephemeral', partition: 'state' })
    for (const method of operations) {
      for (const handle of [{ ...f.window }, other.window, session, null]) {
        await assert.rejects(f.backend[method](handle as WindowHandle))
      }
    }
    const count = f.commands.length
    f.handle(() => {})
    const closing = f.backend.closeWindow(f.window)
    for (const method of operations) await assert.rejects(f.backend[method](f.window), /closing/)
    assert.equal(f.commands.length, count + 1)
    f.reply(f.commands.at(-1)!)
    await closing
    for (const method of operations) await assert.rejects(f.backend[method](f.window), /disposed/)
  } finally {
    await f.stop()
    await other.stop()
  }
})

test('malformed state and native action rejection cannot become successful observations', async () => {
  const f = await fixture()
  try {
    for (const value of [
      null,
      [],
      {},
      { ...state, minimized: 1 },
      { ...state, active: 'false' },
      { ...state, native: 1 },
    ]) {
      f.handle((command) => f.reply(command, value))
      for (const method of operations)
        await assert.rejects(f.backend[method](f.window), /Malformed/)
    }
    f.handle((command) => f.reject(command, 'Native action failed'))
    await assert.rejects(f.backend.minimizeWindow(f.window), /Native action failed/)
  } finally {
    await f.stop()
  }
})

test('window action cancellation retains native reservation until receipt and rejects pre-aborted calls', async () => {
  const f = await fixture()
  try {
    f.handle(() => {})
    const abort = new AbortController()
    abort.abort()
    const count = f.commands.length
    await assert.rejects(f.backend.minimizeWindow(f.window, { signal: abort.signal }), /abort/i)
    assert.equal(f.commands.length, count)
    const controller = new AbortController()
    const pending = f.backend.minimizeWindow(f.window, { signal: controller.signal })
    const rejection = assert.rejects(pending, /abort/i)
    controller.abort()
    await rejection
    assert.equal(f.transport.diagnostics().abandoned, 1)
    f.reply(f.commands.at(-1)!, state)
    await turn()
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})

test('late state cannot resurrect a window closed or disposed during native readback', async () => {
  for (const method of operations) {
    const f = await fixture()
    f.handle(() => {})
    const pending = f.backend[method](f.window)
    const rejected = assert.rejects(pending, /disposed|closing/)
    f.send({ v: 1, event: 'window.closed', target: 1, data: null })
    f.reply(f.commands.at(-1)!, state)
    await rejected
    await f.stop()
    await assert.rejects(f.backend[method](f.window), /disposed/)
  }
})
