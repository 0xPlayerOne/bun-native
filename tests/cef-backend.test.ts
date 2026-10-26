import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend, type PolicyScope } from '../packages/runtime/src/cef.ts'
import type { SessionHandle, ViewHandle, WindowHandle } from '../packages/contracts/src/index.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'
const windowOptions = { title: 'fixture', bounds: { x: 0, y: 0, width: 800, height: 600 } }
async function fixture() {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(
      command,
      command.op.endsWith('.create')
        ? { id: ++next }
        : command.op === 'policy.scope'
          ? nativePolicyScope()
          : null
    )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'fixture' })
  const window = await backend.createWindow(windowOptions)
  const view = await backend.createView({
    session,
    window,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  return { ...peer, backend, session, window, view }
}
test('CEF resource disposal is idempotent and coalesces simultaneous native requests', async () => {
  const f = await fixture()
  try {
    await Promise.all([f.backend.disposeView(f.view), f.backend.disposeView(f.view)])
    await f.backend.disposeView(f.view)
    await Promise.all([f.backend.closeWindow(f.window), f.backend.closeWindow(f.window)])
    await f.backend.closeWindow(f.window)
    await Promise.all([f.backend.disposeSession(f.session), f.backend.disposeSession(f.session)])
    await f.backend.disposeSession(f.session)
    for (const op of ['view.dispose', 'window.close', 'session.dispose'])
      assert.equal(f.commands.filter((c) => c.op === op).length, 1)
    assert.deepEqual(f.backend.diagnostics(), {
      windows: 0,
      views: 0,
      sessions: 0,
      listeners: 0,
      listenerErrors: 0,
    })
  } finally {
    await f.backend.dispose()
  }
})
test('CEF foreign handles remain rejected even by idempotent disposal methods', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.backend.disposeView({ ...f.view } as ViewHandle), /foreign/)
    await assert.rejects(f.backend.closeWindow({ ...f.window } as WindowHandle), /foreign/)
    await assert.rejects(f.backend.disposeSession({ ...f.session } as SessionHandle), /foreign/)
  } finally {
    await f.backend.dispose()
  }
})
test('CEF shutdown cannot register resources from a late creation response', async () => {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  const created = backend.createWindow(windowOptions)
  const disposed = backend.dispose()
  peer.reply(peer.commands[0]!, { id: 1 })
  peer.reply(peer.commands[1]!)
  peer.send({ v: 1, event: 'shutdown' })
  await assert.rejects(created, /disposed/)
  await disposed
  assert.equal(backend.diagnostics().windows, 0)
})
test('CEF simultaneous dispose callers wait for the same shutdown completion', async () => {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  const first = backend.dispose()
  const second = backend.dispose()
  assert.strictEqual(first, second)
  let finished = false
  void second.then(() => {
    finished = true
  })
  await turn()
  assert.equal(finished, false)
  peer.reply(peer.commands[0]!)
  peer.send({ v: 1, event: 'shutdown' })
  await first
})
test('CEF parent identity is revoked before reentrant child-disposal listeners run', async () => {
  const f = await fixture()
  const attempts: Promise<unknown>[] = []
  try {
    f.backend.onEvent((event) => {
      if (event.type === 'disposed' && event.resource === f.view)
        attempts.push(
          f.backend
            .createView({
              window: f.window,
              session: f.session,
              url: 'app://ui/index.html',
              trust: { kind: 'remote' },
            })
            .catch((error) => error)
        )
    })
    f.send({ v: 1, event: 'window.closed', target: 2, data: null })
    await turn()
    assert.equal(attempts.length, 1)
    assert.match(String(await attempts[0]), /disposed/)
    assert.equal(f.commands.filter((c) => c.op === 'view.create').length, 1)
    await f.backend.closeWindow(f.window)
  } finally {
    await f.backend.dispose()
  }
})
test('CEF owner close racing a view creation cleans up the late child instead of publishing it', async () => {
  const f = await fixture()
  let create: Command | undefined
  let close: Command | undefined
  f.handle((command) => {
    if (command.op === 'view.create') create = command
    else if (command.op === 'window.close') close = command
    else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  const created = f.backend.createView({
    window: f.window,
    session: f.session,
    url: 'app://ui/index.html',
    trust: { kind: 'remote' },
  })
  const rejected = assert.rejects(created, /closing/)
  const closing = f.backend.closeWindow(f.window)
  await turn()
  f.reply(create!, { id: 4 })
  await rejected
  f.reply(close!)
  await closing
  assert.equal(f.commands.filter((c) => c.op === 'view.dispose' && c.args['id'] === 4).length, 1)
  assert.equal(f.backend.diagnostics().views, 0)
  await f.backend.dispose()
})
test('CEF close rejection permits retry while already-closed handles remain inert', async () => {
  const f = await fixture()
  let rejected = false
  f.handle((command) => {
    if (command.op === 'window.close' && !rejected) {
      rejected = true
      f.reject(command)
    } else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  await assert.rejects(f.backend.closeWindow(f.window), /rejection/)
  await f.backend.closeWindow(f.window)
  await f.backend.closeWindow(f.window)
  assert.equal(f.commands.filter((c) => c.op === 'window.close').length, 2)
  await f.backend.dispose()
})
test('CEF duplicate session creation and mismatched application grants fail before native calls', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      f.backend.createSession({ persistence: 'ephemeral', partition: 'fixture' }),
      /owner/
    )
    await assert.rejects(
      f.backend.createView({
        window: f.window,
        session: f.session,
        url: 'app://ui/index.html',
        trust: { kind: 'application', origin: 'app://other' },
      }),
      /origin/
    )
    assert.equal(f.commands.filter((c) => c.op === 'session.create').length, 1)
  } finally {
    await f.backend.dispose()
  }
})
test('CEF unexpected native exit rejects backend closure and clears retained state', async () => {
  const f = await fixture()
  f.backend.observe(() => {})
  f.backend.onEvent(() => {})
  f.input.end()
  await assert.rejects(f.backend.closed, /disconnected/)
  assert.deepEqual(f.backend.diagnostics(), {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
})
test('CEF returned navigation state is detached and stale events cannot revive disposed views', async () => {
  const f = await fixture()
  try {
    const result = await f.backend.navigate(f.view, 'app://ui/index.html')
    ;(result as { url: string }).url = 'https://invalid.example'
    assert.equal(f.backend.state(f.view).url, 'app://ui/index.html')
    await f.backend.disposeView(f.view)
    f.send({ v: 1, event: 'view.loaded', target: 3, data: { url: 'app://ui/next.html' } })
    await turn()
    assert.equal(f.backend.diagnostics().views, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('native close completion wins a late idempotent disposal rejection', async () => {
  const f = await fixture()
  let disposed = 0
  f.backend.onEvent((event) => {
    if (event.type === 'disposed' && event.resource === f.view) disposed++
  })
  f.handle((command) => {
    if (command.op === 'view.dispose') {
      f.send({ v: 1, event: 'view.closed', target: 3, data: null })
      f.reject(command)
    } else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  await f.backend.disposeView(f.view)
  await f.backend.disposeView(f.view)
  assert.equal(disposed, 1)
  assert.equal(f.backend.diagnostics().views, 0)
  await f.backend.dispose()
})
test('unsubscribed observers do not fire later in the same delivery snapshot', async () => {
  const f = await fixture()
  let calls = 0
  let detach = () => {}
  const first = f.backend.observe(() => detach())
  detach = f.backend.observe(() => {
    calls++
  })
  f.send({ v: 1, event: 'view.console', target: 3, data: { message: 'fixture' } })
  await turn()
  assert.equal(calls, 0)
  first()
  await f.backend.dispose()
})
test('focus and visibility operations reject disposed or closing owners', async () => {
  const f = await fixture()
  await f.backend.focusView(f.view)
  assert.equal(f.commands.at(-1)?.op, 'view.focus')
  let pending: Command | undefined
  f.handle((command) => {
    if (command.op === 'window.close') pending = command
    else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  const closing = f.backend.closeWindow(f.window)
  await turn()
  await assert.rejects(f.backend.showWindow(f.window, true), /closing/)
  await assert.rejects(f.backend.resizeWindow(f.window, 500, 300), /closing/)
  await assert.rejects(f.backend.focusView(f.view), /closing/)
  f.reply(pending!)
  await closing
  await assert.rejects(f.backend.focusView(f.view))
  await f.backend.dispose()
})

const nativePolicyScope = (generation = 1) => ({
  view: 3,
  session: 1,
  generation,
  mainFrame: 'main-frame',
  document: `native-3-${generation}`,
  origin: 'app://ui',
})

test('trusted capability API requires an opaque captured scope on the private pipe', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    assert.equal(Object.isFrozen(scope), true)
    assert.equal(f.commands.at(-1)?.op, 'policy.scope')
    const before = f.commands.length
    await assert.rejects(
      f.backend.grantNativeCapability({ ...scope } as PolicyScope, {
        name: 'clipboard-read',
      }),
      /foreign/
    )
    assert.equal(f.commands.length, before)

    const arguments_ = ['--literal', 'a;b']
    await f.backend.grantNativeCapability(scope, {
      name: 'process-execute',
      executable: '/fixture/tool',
      arguments: arguments_,
    })
    arguments_[1] = 'injected'
    const grant = f.commands.at(-1)!
    assert.equal(grant.op, 'policy.native.grant')
    assert.equal(grant.args['id'], 3)
    assert.deepEqual(grant.args['scope'], nativePolicyScope())
    assert.deepEqual(grant.args['capability'], {
      name: 'process-execute',
      executable: '/fixture/tool',
      arguments: ['--literal', 'a;b'],
    })

    await f.backend.recordBrowserUserDecision(scope, 'camera', 'granted')
    assert.deepEqual(f.commands.at(-1)?.args, {
      id: 3,
      scope: nativePolicyScope(),
      permission: 'camera',
      decision: 'granted',
      source: 'user-decision',
    })
    await f.backend.setBrowserApplicationPolicy(scope, 'camera', 'denied')
    assert.equal(f.commands.at(-1)?.args['source'], 'application-policy')
  } finally {
    await f.backend.dispose()
  }
})

test('policy scope capture and use reject document races, copies, and foreign backends', async () => {
  const f = await fixture()
  const other = await fixture()
  try {
    let capture: Command | undefined
    f.handle((command) => {
      if (command.op === 'policy.scope') capture = command
      else {
        f.reply(command)
        if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
      }
    })
    const raced = f.backend.capturePolicyScope(f.view)
    await turn()
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-2' },
    })
    f.reply(capture!, nativePolicyScope())
    await assert.rejects(raced, /changed|stale/)

    f.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-2' },
    })
    await turn()
    f.handle((command) => {
      f.reply(command, command.op === 'policy.scope' ? nativePolicyScope(2) : null)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    })
    const scope = await f.backend.capturePolicyScope(f.view)
    const before = f.commands.length
    await assert.rejects(
      other.backend.grantNativeCapability(scope, { name: 'dialog-open' }),
      /foreign/
    )
    await assert.rejects(
      f.backend.grantNativeCapability(Object.freeze({}) as PolicyScope, {
        name: 'dialog-open',
      }),
      /foreign/
    )
    assert.equal(f.commands.length, before)

    await f.backend.grantNativeCapability(scope, { name: 'dialog-open' })
    assert.deepEqual(f.commands.at(-1)?.args['scope'], nativePolicyScope(2))
    const afterGrant = f.commands.length

    f.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-3' },
    })
    await turn()
    await assert.rejects(
      f.backend.recordBrowserUserDecision(scope, 'camera', 'granted'),
      /changed|stale/
    )
    assert.equal(f.commands.length, afterGrant)
  } finally {
    await Promise.all([f.backend.dispose(), other.backend.dispose()])
  }
})

test('native policy gate remains explicitly unavailable for a valid current captured scope', async () => {
  const f = await fixture()
  f.handle((command) => {
    if (command.op === 'policy.scope') f.reply(command, nativePolicyScope())
    else if (command.op === 'policy.native.check') f.reply(command, { status: 'unavailable' })
    else {
      f.reply(command)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    }
  })
  const scope = await f.backend.capturePolicyScope(f.view)
  await f.backend.grantNativeCapability(scope, { name: 'dialog-open' })
  assert.equal(
    await f.backend.authorizeNativeOperation(scope, { name: 'dialog-open' }),
    'unavailable'
  )
  assert.deepEqual(f.commands.at(-1)?.args['scope'], nativePolicyScope())
  await f.backend.dispose()
})

test('policy captures and grants cannot cross a locally queued navigation', async () => {
  const f = await fixture()
  let capture: Command | undefined
  let navigation: Command | undefined
  try {
    const original = await f.backend.capturePolicyScope(f.view)
    f.handle((command) => {
      if (command.op === 'policy.scope') capture = command
      else if (command.op === 'view.navigate') navigation = command
      else {
        f.reply(command)
        if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
      }
    })
    const pendingCapture = f.backend.capturePolicyScope(f.view)
    const moved = f.backend.navigate(f.view, 'app://ui/next.html')
    f.reply(capture!, nativePolicyScope())
    await assert.rejects(pendingCapture, /changed/)
    await assert.rejects(
      f.backend.grantNativeCapability(original, { name: 'dialog-open' }),
      /stale/
    )
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-2' },
    })
    f.reply(navigation!, { url: 'app://ui/next.html', status: 200 })
    await moved
  } finally {
    await f.backend.dispose()
  }
})

test('policy scope must use the same native document identity as the view', async () => {
  const f = await fixture()
  try {
    f.handle((command) => {
      f.reply(
        command,
        command.op === 'policy.scope'
          ? { ...nativePolicyScope(), document: 'invented-document' }
          : null
      )
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    })
    await assert.rejects(f.backend.capturePolicyScope(f.view), /changed/)
  } finally {
    await f.backend.dispose()
  }
})

test('native renderer proof requires exact captured scope and bounded native-only PID reply', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    let response: unknown = { pid: 123 }
    f.handle((command) => {
      f.reply(command, command.op === 'rpc.qualification.renderer' ? response : null)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    })
    assert.equal(await f.backend.qualifyRendererProcess(scope), 123)
    assert.deepEqual(f.commands.at(-1)?.args, { id: 3, scope: nativePolicyScope() })
    const before = f.commands.length
    await assert.rejects(f.backend.qualifyRendererProcess({ ...scope } as PolicyScope), /foreign/)
    assert.equal(f.commands.length, before)
    for (const invalid of [
      {},
      { pid: true },
      { pid: '123' },
      { pid: 0 },
      { pid: 2 ** 31 },
      { pid: 1.5 },
      { pid: 123, extra: true },
    ]) {
      response = invalid
      await assert.rejects(f.backend.qualifyRendererProcess(scope), /renderer process proof/)
    }
  } finally {
    await f.backend.dispose()
  }
})
test('a native renderer process reply cannot survive navigation of its captured document', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    let pending: Command | undefined
    f.handle((command) => {
      if (command.op === 'rpc.qualification.renderer') pending = command
      else {
        f.reply(command)
        if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
      }
    })
    const proof = f.backend.qualifyRendererProcess(scope)
    void proof.catch(() => {})
    await turn()
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'https://example.test/', documentId: 'native-3-2' },
    })
    await turn()
    f.reply(pending!, { pid: 123 })
    await assert.rejects(proof, /stale|changed|ready|document/)
  } finally {
    await f.backend.dispose()
  }
})
