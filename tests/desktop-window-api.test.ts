import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import {
  BunlyError,
  CONTRACT_VERSION,
  type Bounds,
  type BrowserBackend,
  type WindowEvent,
  type WindowHandle,
} from '../packages/contracts/src/index.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

const options = { title: 'portable desktop', bounds: { x: 10, y: 20, width: 640, height: 480 } }
const state = {
  visible: true,
  active: false,
  minimized: false,
  maximized: false,
  fullscreen: false,
}
const actual = { x: 12, y: 22, width: 638, height: 478 }
const hasCode = (code: string) => (error: unknown) =>
  error instanceof BunlyError && error.code === code

async function fixture() {
  const peer = await nativePeer()
  let id = 0
  peer.handle((command) =>
    peer.reply(
      command,
      command.op.endsWith('.create')
        ? { id: ++id }
        : command.op === 'window.bounds' || command.op === 'window.bounds.set'
          ? actual
          : state
    )
  )
  const backend = new CefBackend(peer.transport)
  const window = await backend.createWindow(options)
  return { ...peer, backend, window }
}

test('portable window controls return real adapter readback instead of requested intent', async () => {
  const f = await fixture()
  try {
    const backend: BrowserBackend = f.backend
    assert.equal(backend.descriptor.contractVersion, CONTRACT_VERSION)
    assert.ok(backend.descriptor.capabilities.includes('window.state'))
    assert.ok(backend.descriptor.capabilities.includes('window.geometry'))
    assert.deepEqual(await backend.maximizeWindow(f.window), state)
    assert.deepEqual(await backend.setWindowFullscreen(f.window, true), state)
    assert.deepEqual(await backend.setWindowBounds(f.window, options.bounds), actual)
    const bounds = await backend.windowBounds(f.window)
    assert.ok(Object.isFrozen(bounds))
    assert.deepEqual(bounds, actual)
    assert.deepEqual(
      f.commands.slice(1).map((command) => [command.op, command.args]),
      [
        ['window.maximize', { id: 1 }],
        ['window.fullscreen', { id: 1, fullscreen: true }],
        ['window.bounds.set', { id: 1, ...options.bounds }],
        ['window.bounds', { id: 1 }],
      ]
    )
  } finally {
    await f.stop()
  }
})

test('legacy ABI 1 hosts retain existing controls without advertising or admitting new desktop APIs', async () => {
  const peer = await nativePeer({ desktopCapabilities: undefined })
  const backend = new CefBackend(peer.transport)
  peer.handle((command) => peer.reply(command, command.op === 'window.create' ? { id: 1 } : state))
  try {
    const window = await backend.createWindow(options)
    assert.deepEqual(peer.transport.desktopCapabilities, [])
    assert.ok(!backend.descriptor.capabilities.includes('window.state'))
    assert.ok(!backend.descriptor.capabilities.includes('window.geometry'))
    assert.deepEqual(await backend.windowState(window), state)
    assert.deepEqual(await backend.minimizeWindow(window), state)
    assert.deepEqual(await backend.restoreWindow(window), state)
    assert.deepEqual(await backend.activateWindow(window), state)
    await backend.showWindow(window, true)
    await backend.resizeWindow(window, 400, 300)
    const admitted = peer.commands.length
    for (const operation of [
      () => backend.maximizeWindow(window),
      () => backend.setWindowFullscreen(window, true),
      () => backend.windowBounds(window),
      () => backend.setWindowBounds(window, actual),
    ])
      await assert.rejects(operation(), hasCode('UNSUPPORTED_CAPABILITY'))
    assert.throws(() => backend.onWindowEvent(window, () => {}), hasCode('UNSUPPORTED_CAPABILITY'))
    assert.equal(peer.commands.length, admitted)
  } finally {
    await peer.stop()
  }
})

test('backend descriptors expose immutable snapshots of actual readiness capabilities', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = new NativeTransport(input, output)
  const backend = new CefBackend(transport)
  const before = backend.descriptor
  try {
    assert.ok(!before.capabilities.includes('window.state'))
    assert.ok(Object.isFrozen(before))
    assert.ok(Object.isFrozen(before.capabilities))
    input.write(
      JSON.stringify({
        v: 1,
        event: 'ready',
        abi: 1,
        data: { desktopCapabilities: { version: 1, capabilities: ['window.state'] } },
      }) + '\n'
    )
    await transport.ready
    assert.ok(backend.descriptor.capabilities.includes('window.state'))
    assert.ok(!backend.descriptor.capabilities.includes('window.geometry'))
    assert.ok(!before.capabilities.includes('window.state'))
    assert.ok(Object.isFrozen(backend.descriptor))
    assert.ok(Object.isFrozen(backend.descriptor.capabilities))
  } finally {
    input.write('{"v":1,"event":"shutdown"}\n')
    await backend.closed
  }
})

test('window geometry rejects fractional, overflowing and malformed inputs before native admission', async () => {
  const f = await fixture()
  try {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...actual, width: 0 },
      { ...actual, height: 32769 },
      { ...actual, x: 32769 },
      { ...actual, y: -32769 },
      { ...actual, x: 0.5 },
      { ...actual, width: 12.5 },
      { ...actual, height: Infinity },
      { ...actual, x: NaN },
      { ...actual, width: '5' },
    ]
    const count = f.commands.length
    for (const bounds of invalid) {
      await assert.rejects(
        f.backend.setWindowBounds(f.window, bounds as Bounds),
        hasCode('INVALID_ARGUMENT')
      )
      await assert.rejects(
        f.backend.createWindow({ ...options, bounds: bounds as Bounds }),
        hasCode('INVALID_ARGUMENT')
      )
    }
    await assert.rejects(f.backend.resizeWindow(f.window, 0.5, 5), hasCode('INVALID_ARGUMENT'))
    await assert.rejects(
      f.backend.setWindowFullscreen(f.window, 1 as unknown as boolean),
      hasCode('INVALID_ARGUMENT')
    )
    assert.equal(f.commands.length, count)
    await f.backend.setWindowBounds(f.window, { x: -32768, y: 32768, width: 1, height: 32768 })
  } finally {
    await f.stop()
  }
})

test('native bounds readback is strict and may honestly describe an empty transitional rectangle', async () => {
  const f = await fixture()
  try {
    for (const value of [
      null,
      [],
      {},
      { ...actual, extra: true },
      { ...actual, width: -1 },
      { ...actual, x: 2147483648 },
      { ...actual, height: 1.5 },
    ]) {
      f.handle((command) => f.reply(command, value))
      await assert.rejects(f.backend.windowBounds(f.window), /Malformed native/)
    }
    f.handle((command) => f.reply(command, { x: -2147483648, y: 2147483647, width: 0, height: 0 }))
    assert.deepEqual(await f.backend.windowBounds(f.window), {
      x: -2147483648,
      y: 2147483647,
      width: 0,
      height: 0,
    })
  } finally {
    await f.stop()
  }
})

test('window subscriptions bind exact live handles, freeze values and preserve fullscreen completion', async () => {
  const f = await fixture()
  try {
    const other = await f.backend.createWindow(options)
    const events: WindowEvent[] = [],
      otherEvents: WindowEvent[] = []
    f.backend.onWindowEvent(f.window, (event) => events.push(event))
    f.backend.onWindowEvent(other, (event) => otherEvents.push(event))
    assert.throws(
      () => f.backend.onWindowEvent({ ...f.window } as WindowHandle, () => {}),
      hasCode('INVALID_HANDLE')
    )
    f.send({ v: 1, event: 'window.state-changed', target: 1, data: state })
    f.send({ v: 1, event: 'window.bounds-changed', target: 1, data: actual })
    f.send({
      v: 1,
      event: 'window.fullscreen-transition',
      target: 1,
      data: { completed: false, state: { ...state, fullscreen: true } },
    })
    f.send({
      v: 1,
      event: 'window.fullscreen-transition',
      target: 1,
      data: { completed: true, state: { ...state, fullscreen: true } },
    })
    f.send({ v: 1, event: 'window.state-changed', target: 999, data: state })
    await turn()
    assert.deepEqual(events, [
      { type: 'state-changed', state },
      { type: 'bounds-changed', bounds: actual },
      { type: 'fullscreen-transition', completed: false, state: { ...state, fullscreen: true } },
      { type: 'fullscreen-transition', completed: true, state: { ...state, fullscreen: true } },
    ])
    assert.deepEqual(otherEvents, [])
    for (const event of events) {
      assert.ok(Object.isFrozen(event))
      if ('state' in event) assert.ok(Object.isFrozen(event.state))
      if ('bounds' in event) assert.ok(Object.isFrozen(event.bounds))
    }
    f.send({ v: 1, event: 'window.closed', target: 1, data: null })
    f.send({ v: 1, event: 'window.state-changed', target: 1, data: state })
    await turn()
    assert.deepEqual(events.at(-1), { type: 'closed' })
    assert.equal(events.length, 5)
    assert.equal(f.backend.diagnostics().listeners, 1)
    assert.throws(() => f.backend.onWindowEvent(f.window, () => {}), hasCode('DISPOSED'))
  } finally {
    await f.stop()
  }
})

test('window subscription retirement is bounded, reentrant and releases on backend shutdown', async () => {
  const f = await fixture()
  try {
    const abort = new AbortController()
    let retired = 0,
      late = 0,
      current = 0
    const stop = f.backend.onWindowEvent(f.window, () => {
      current++
      abort.abort()
      f.backend.onWindowEvent(f.window, () => late++)
    })
    f.backend.onWindowEvent(f.window, () => retired++, { signal: abort.signal })
    f.send({ v: 1, event: 'window.state-changed', target: 1, data: state })
    await turn()
    assert.equal(current, 1)
    assert.equal(retired, 0)
    assert.equal(late, 0)
    stop()
    stop()
    assert.throws(
      () => f.backend.onWindowEvent(f.window, () => {}, { signal: abort.signal }),
      /abort/i
    )
    const removals: (() => void)[] = []
    while (f.backend.diagnostics().listeners < 128)
      removals.push(f.backend.onWindowEvent(f.window, () => {}))
    assert.throws(() => f.backend.onWindowEvent(f.window, () => {}), hasCode('RESOURCE_IN_USE'))
    removals.pop()!()
    const off = f.backend.onWindowEvent(f.window, () => {})
    off()
    await f.stop()
    await f.backend.closed
    assert.equal(f.backend.diagnostics().listeners, 0)
    for (const remove of removals) remove()
  } finally {
    await f.stop()
  }
})

test('malformed fullscreen notifications fail closed without delivering an invented transition', async () => {
  for (const data of [
    { completed: 1, state },
    { completed: true, state, extra: true },
    { completed: true, state: { ...state, active: 'yes' } },
  ]) {
    const f = await fixture()
    const events: WindowEvent[] = []
    f.backend.onWindowEvent(f.window, (event) => events.push(event))
    f.send({ v: 1, event: 'window.fullscreen-transition', target: 1, data })
    await assert.rejects(f.backend.closed, /Malformed native/)
    assert.deepEqual(events, [])
    assert.equal(f.backend.diagnostics().listeners, 0)
    assert.ok(f.input.destroyed)
    assert.ok(f.output.destroyed)
  }
})

test('late geometry cannot resurrect a closed window and cancellation retains the dispatched reservation', async () => {
  const f = await fixture()
  try {
    f.handle(() => {})
    const controller = new AbortController()
    const request = f.backend.setWindowBounds(f.window, actual, { signal: controller.signal })
    const rejected = assert.rejects(request, /abort/i)
    controller.abort()
    await rejected
    assert.equal(f.transport.diagnostics().abandoned, 1)
    f.reply(f.commands.at(-1)!, actual)
    await turn()
    assert.equal(f.transport.diagnostics().abandoned, 0)
    const pending = f.backend.windowBounds(f.window)
    const closed = assert.rejects(pending, hasCode('DISPOSED'))
    f.send({ v: 1, event: 'window.closed', target: 1, data: null })
    f.reply(f.commands.at(-1)!, actual)
    await closed
  } finally {
    await f.stop()
  }
})

test('the mock reports desktop capabilities as unsupported instead of inventing OS observations', async () => {
  const backend: BrowserBackend = new MockBackend()
  const window = await backend.createWindow(options)
  try {
    assert.ok(!backend.descriptor.capabilities.includes('window.state'))
    assert.ok(!backend.descriptor.capabilities.includes('window.geometry'))
    for (const operation of [
      () => backend.windowState(window),
      () => backend.minimizeWindow(window),
      () => backend.restoreWindow(window),
      () => backend.activateWindow(window),
      () => backend.maximizeWindow(window),
      () => backend.setWindowFullscreen(window, true),
      () => backend.showWindow(window, true),
      () => backend.resizeWindow(window, 10, 10),
      () => backend.windowBounds(window),
      () => backend.setWindowBounds(window, actual),
    ])
      await assert.rejects(operation(), hasCode('UNSUPPORTED_CAPABILITY'))
    assert.throws(() => backend.onWindowEvent(window, () => {}), hasCode('UNSUPPORTED_CAPABILITY'))
    await backend.closeWindow(window)
    await assert.rejects(backend.windowState(window), hasCode('DISPOSED'))
  } finally {
    await backend.dispose()
  }
})
