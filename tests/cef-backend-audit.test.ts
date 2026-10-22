import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

const bounds = { x: 0, y: 0, width: 800, height: 600 }
const windowOptions = { title: 'audit', bounds }
async function fixture() {
  const peer = await nativePeer()
  let sequence = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++sequence } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  return { ...peer, backend: new CefBackend(peer.transport) }
}

test('CEF session reservation uses the submitted partition, not a later caller mutation', async () => {
  const f = await fixture()
  try {
    const options = { persistence: 'ephemeral' as const, partition: 'original' }
    const pending = f.backend.createSession(options)
    options.partition = 'mutated'
    const session = await pending
    await f.backend.disposeSession(session)
    await f.backend.createSession({ persistence: 'ephemeral', partition: 'original' })
  } finally {
    await f.backend.dispose()
  }
})

test('CEF view ownership remains bound to submitted handles across asynchronous creation', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({ persistence: 'ephemeral', partition: 'view' })
    const first = await f.backend.createWindow(windowOptions)
    const second = await f.backend.createWindow(windowOptions)
    const options = {
      window: first,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'remote' as const },
    }
    const pending = f.backend.createView(options)
    options.window = second
    await pending
    await f.backend.closeWindow(first)
    assert.equal(f.backend.diagnostics().views, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('coalesced native creation and navigation frames do not lose the initial navigation', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({
      persistence: 'ephemeral',
      partition: 'initial',
    })
    const window = await f.backend.createWindow(windowOptions)
    f.handle((command) => {
      if (command.op === 'view.create') {
        f.input.write(
          JSON.stringify({ v: 1, id: command.id, ok: true, value: { id: 3 } }) +
            '\n' +
            JSON.stringify({
              v: 1,
              event: 'view.loaded',
              target: 3,
              data: { url: 'app://ui/next.html' },
            }) +
            '\n'
        )
      } else {
        f.reply(command)
        if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
      }
    })
    const view = await f.backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await turn()
    assert.equal(f.backend.state(view).url, 'app://ui/next.html')
  } finally {
    await f.backend.dispose()
  }
})

test('mock window cleanup tolerates a listener disposing a sibling during the close cascade', async () => {
  const backend = new MockBackend()
  try {
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'reentrant',
    })
    const window = await backend.createWindow(windowOptions)
    const options = {
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'remote' as const },
    }
    const first = await backend.createView(options)
    const second = await backend.createView(options)
    let sibling: Promise<void> | undefined
    backend.onEvent((event) => {
      if (event.type === 'disposed' && event.resource === first)
        sibling = backend.disposeView(second)
    })
    await backend.closeWindow(window)
    await sibling
    assert.equal(backend.diagnostics().views, 0)
  } finally {
    await backend.dispose()
  }
})

test('coalesced window creation and native closure cannot leave a ghost handle', async () => {
  const f = await fixture()
  f.handle((command) => {
    if (command.op === 'window.create') {
      f.input.write(
        JSON.stringify({ v: 1, id: command.id, ok: true, value: { id: 1 } }) +
          '\n' +
          JSON.stringify({ v: 1, event: 'window.closed', target: 1 }) +
          '\n'
      )
    } else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  try {
    const window = await f.backend.createWindow(windowOptions)
    await turn()
    assert.equal(f.backend.diagnostics().windows, 0)
    await f.backend.closeWindow(window)
    assert.equal(f.commands.filter((c) => c.op === 'window.close').length, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('CEF duplicate live native identities fail closed instead of aliasing owners', async () => {
  const f = await fixture()
  await f.backend.createWindow(windowOptions)
  f.handle((command) => f.reply(command, { id: 1 }))
  await assert.rejects(f.backend.createWindow(windowOptions), /Duplicate live/)
  await assert.rejects(f.backend.closed, /Duplicate live/)
  assert.equal(f.backend.diagnostics().windows, 0)
})

test('invalid native creation identity retires the host rather than retaining an unowned object', async () => {
  const f = await fixture()
  f.handle((command) => f.reply(command, { id: -1 }))
  await assert.rejects(f.backend.createWindow(windowOptions), /identity/)
  await assert.rejects(f.backend.closed, /identity/)
  assert.equal(f.transport.diagnostics().closed, true)
})

test('invalid native navigation cannot silently retain the previous application trust', async () => {
  const f = await fixture()
  const session = await f.backend.createSession({
    persistence: 'ephemeral',
    partition: 'invalid-url',
  })
  const window = await f.backend.createWindow(windowOptions)
  await f.backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  f.send({ v: 1, event: 'view.loaded', target: 3, data: { url: 'javascript:alert(1)' } })
  await assert.rejects(f.backend.closed)
  assert.equal(f.backend.diagnostics().views, 0)
})

test('CEF owner indexes release only the selected window and session relationships', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({
      persistence: 'ephemeral',
      partition: 'indexed',
    })
    const first = await f.backend.createWindow(windowOptions)
    const second = await f.backend.createWindow(windowOptions)
    const view = await f.backend.createView({
      window: first,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'remote' },
    })
    const other = await f.backend.createView({
      window: second,
      session,
      url: 'app://ui/next.html',
      trust: { kind: 'remote' },
    })
    await f.backend.closeWindow(first)
    await assert.rejects(f.backend.disposeSession(session), /live views/)
    assert.equal(f.backend.diagnostics().views, 1)
    assert.equal(f.backend.state(other).url, 'app://ui/next.html')
    assert.throws(() => f.backend.state(view), /disposed/)
    await f.backend.disposeView(other)
    await f.backend.disposeSession(session)
    assert.equal(f.backend.diagnostics().sessions, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('missing navigation metadata cannot be ignored while an application grant remains live', async () => {
  const f = await fixture()
  const session = await f.backend.createSession({
    persistence: 'ephemeral',
    partition: 'missing-url',
  })
  const window = await f.backend.createWindow(windowOptions)
  await f.backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  f.send({ v: 1, event: 'view.navigating', target: 3 })
  await assert.rejects(f.backend.closed, /Missing native navigation URL/)
  assert.equal(f.backend.diagnostics().views, 0)
})

test('navigation subscribers cannot alter another subscriber’s snapshot', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({
      persistence: 'ephemeral',
      partition: 'immutable',
    })
    const window = await f.backend.createWindow(windowOptions)
    const view = await f.backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const received: string[] = []
    f.backend.onEvent((event) => {
      if (event.type === 'navigated')
        (event.state as { url: string }).url = 'https://changed.invalid'
    })
    f.backend.onEvent((event) => {
      if (event.type === 'navigated') received.push(event.state.url)
    })
    f.send({ v: 1, event: 'view.loaded', target: 3, data: { url: 'app://ui/next.html' } })
    await turn()
    assert.deepEqual(received, ['app://ui/next.html'])
    assert.equal(f.backend.state(view).url, 'app://ui/next.html')
    assert.equal(f.backend.diagnostics().listenerErrors, 1)
  } finally {
    await f.backend.dispose()
  }
})
