import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ViewHandle } from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

const ready = {
  windowVisible: true,
  windowMinimized: false,
  viewVisible: true,
  viewDrawn: true,
  viewEnabled: true,
  viewFocusable: true,
  positiveBounds: true,
  presentationAllowsFocus: true,
  overlayAllowsFocus: true,
  eligible: true,
}
async function fixture() {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) =>
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : ready)
  )
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'focus' })
  const window = await backend.createWindow({
    title: 'focus',
    bounds: { x: 0, y: 0, width: 320, height: 240 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  return { ...peer, backend, session, window, view }
}

test('native focus readback is immutable, exact and read-only for an opaque stack view', async () => {
  const f = await fixture()
  try {
    const state = await f.backend.nativeViewFocusState(f.view)
    assert.deepEqual(state, ready)
    assert.ok(Object.isFrozen(state))
    assert.deepEqual(
      f.commands.slice(3).map((command) => [command.op, command.args]),
      [['view.focus.state', { id: 3 }]]
    )
    for (const [key, value] of Object.entries(ready).filter(([key]) => key !== 'eligible')) {
      const unavailable = { ...ready, [key]: !value, eligible: false }
      f.handle((command) => f.reply(command, unavailable))
      assert.deepEqual(await f.backend.nativeViewFocusState(f.view), unavailable)
    }
    assert.equal(f.commands.filter((command) => command.op === 'view.focus').length, 0)
  } finally {
    await f.stop()
  }
})

test('focus state refuses forged, foreign, wrong-kind, closing and stale handles before dispatch', async () => {
  const f = await fixture(),
    other = await fixture()
  try {
    const count = f.commands.length
    for (const handle of [{ ...f.view }, other.view, f.window, f.session, null])
      await assert.rejects(f.backend.nativeViewFocusState(handle as ViewHandle))
    assert.equal(f.commands.length, count)
    f.handle(() => {})
    const closing = f.backend.closeWindow(f.window)
    await assert.rejects(f.backend.nativeViewFocusState(f.view), /closing/)
    assert.equal(f.commands.length, count + 1)
    f.reply(f.commands.at(-1)!)
    await closing
    await assert.rejects(f.backend.nativeViewFocusState(f.view), /disposed/)
    assert.equal(f.commands.length, count + 1)
  } finally {
    await f.stop()
    await other.stop()
  }
})

test('native focus state rejects malformed fields and inconsistent eligibility', async () => {
  const f = await fixture()
  try {
    for (const value of [
      null,
      [],
      {},
      { ...ready, viewDrawn: 1 },
      { ...ready, windowVisible: 'true' },
      { ...ready, extra: false },
      { ...ready, eligible: false },
      { ...ready, positiveBounds: false },
      { ...ready, overlayAllowsFocus: false },
    ]) {
      f.handle((command) => f.reply(command, value))
      await assert.rejects(f.backend.nativeViewFocusState(f.view), /Malformed|Inconsistent/)
    }
    f.handle((command) => f.reject(command, 'INVALID_HANDLE: view'))
    await assert.rejects(f.backend.nativeViewFocusState(f.view), /INVALID_HANDLE/)
  } finally {
    await f.stop()
  }
})

test('late native focus state cannot revive a view whose owner closed during readback', async () => {
  for (const event of ['view.closed', 'window.closed']) {
    const f = await fixture()
    try {
      f.handle(() => {})
      const pending = f.backend.nativeViewFocusState(f.view)
      const rejected = assert.rejects(pending, /disposed/)
      f.send({ v: 1, event, target: event === 'view.closed' ? 3 : 2, data: null })
      f.reply(f.commands.at(-1)!, ready)
      await rejected
    } finally {
      await f.stop()
    }
  }
})

test('focus readback cancellation keeps the native reservation until its receipt', async () => {
  const f = await fixture()
  try {
    f.handle(() => {})
    const preAborted = new AbortController()
    preAborted.abort()
    const before = f.commands.length
    await assert.rejects(
      f.backend.nativeViewFocusState(f.view, { signal: preAborted.signal }),
      /abort/i
    )
    assert.equal(f.commands.length, before)
    const controller = new AbortController()
    const pending = f.backend.nativeViewFocusState(f.view, { signal: controller.signal })
    const rejected = assert.rejects(pending, /abort/i)
    controller.abort()
    await rejected
    assert.equal(f.transport.diagnostics().abandoned, 1)
    f.reply(f.commands.at(-1)!, ready)
    await turn()
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})
