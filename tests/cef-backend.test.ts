import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend, type PolicyScope } from '../packages/runtime/src/cef.ts'
import { NativeShutdownError } from '../packages/runtime/src/native-transport.ts'
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
test.each(['before-shutdown', 'during-shutdown', 'after-shutdown'] as const)(
  'CEF disposal after last-window closure is idempotent %s',
  async (timing) => {
    const peer = await nativePeer()
    const backend = new CefBackend(peer.transport)
    peer.handle((command) => {
      if (command.op === 'window.create') peer.reply(command, { id: 1 })
      else if (command.op === 'window.close') peer.reply(command)
      // A host already finishing its last window need not acknowledge the later quit.
    })
    const window = await backend.createWindow(windowOptions)
    await backend.closeWindow(window)
    const unrelated = assert.rejects(peer.transport.call('diagnostics'), NativeShutdownError)
    let disposed: Promise<void> | undefined
    if (timing === 'before-shutdown') disposed = backend.dispose()
    if (timing === 'during-shutdown')
      backend.observe((event) => {
        if (event.event === 'shutdown') disposed = backend.dispose()
      })
    peer.send({ v: 1, event: 'shutdown' })
    if (timing === 'after-shutdown') {
      await backend.closed
      disposed = backend.dispose()
    }
    await backend.closed
    assert.ok(disposed)
    assert.strictEqual(disposed, backend.dispose())
    await Promise.all([disposed, unrelated])
    await turn()
    assert.equal(peer.transport.failure, null)
    assert.equal(peer.transport.diagnostics().requests, 0)
    assert.equal(peer.transport.diagnostics().queuedBytes, 0)
    assert.equal(backend.diagnostics().windows, 0)
    assert.equal(
      peer.commands.filter((command) => command.op === 'quit').length,
      timing === 'after-shutdown' ? 0 : 1
    )
  }
)
test.each([
  'transport-failure',
  'tagged-transport-failure',
  'quit-rejected',
  'quit-rejected-then-shutdown',
] as const)(
  'CEF disposal preserves %s instead of treating it as normal shutdown',
  async (outcome) => {
    const peer = await nativePeer()
    const backend = new CefBackend(peer.transport)
    // An explicit native error with identical text must not impersonate shutdown cancellation.
    const failure =
      outcome === 'tagged-transport-failure'
        ? new NativeShutdownError()
        : new Error('Native host shut down')
    peer.handle((command) => {
      if (command.op !== 'quit') return
      if (outcome === 'transport-failure' || outcome === 'tagged-transport-failure')
        peer.transport.fail(failure)
      else if (outcome === 'quit-rejected') peer.reject(command, failure.message)
      else
        peer.input.write(
          JSON.stringify({ v: 1, id: command.id, ok: false, error: failure.message }) +
            '\n' +
            JSON.stringify({ v: 1, event: 'shutdown' }) +
            '\n'
        )
    })
    const disposed = backend.dispose()
    await assert.rejects(disposed, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, failure.message)
      assert.equal(error instanceof NativeShutdownError, outcome === 'tagged-transport-failure')
      return true
    })
    assert.strictEqual(backend.dispose(), disposed)
    if (outcome === 'quit-rejected-then-shutdown') {
      await backend.closed
      assert.equal(peer.transport.failure, null)
    } else {
      await assert.rejects(backend.closed, { message: failure.message })
      assert.ok(peer.transport.failure)
    }
    assert.equal(peer.transport.diagnostics().requests, 0)
  }
)
test('CEF disposal preserves another native request deadline failure', async () => {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  const request = peer.transport.call('diagnostics', {}, undefined, 10)
  const disposed = backend.dispose()
  await Promise.all([
    assert.rejects(request, /Native request deadline: diagnostics/),
    assert.rejects(disposed, /Native request deadline: diagnostics/),
    assert.rejects(backend.closed, /Native request deadline: diagnostics/),
  ])
  assert.ok(peer.transport.failure)
  assert.equal(peer.transport.diagnostics().requests, 0)
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
  await assert.rejects(f.backend.dispose(), /disconnected/)
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
test('native diagnostic observers do not await callbacks and count rejected promises and thenables', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<void>()
  let deliveries = 0,
    assimilations = 0
  const removePromise = f.backend.observe(() => pending.promise)
  const removeThenable = f.backend.observe(() => ({
    // Exercise a callback's PromiseLike result through the native-event dispatcher.
    // oxlint-disable-next-line unicorn/no-thenable
    then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      assimilations++
      reject(new Error('Native diagnostic thenable failed'))
    },
  }))
  const removeHealthy = f.backend.observe(() => {
    deliveries++
  })
  try {
    for (let index = 0; index < 2; index++)
      f.send({ v: 1, event: 'view.console', target: 3, data: { message: 'fixture' } })
    await turn()
    assert.equal(deliveries, 2, 'A pending observer cannot delay later native-event delivery')
    assert.equal(assimilations, 2)
    assert.equal(f.backend.diagnostics().listenerErrors, 2)
    removePromise()
    removeThenable()
    pending.reject(new Error('Native diagnostic promise failed after unsubscribe'))
    await turn()
    assert.equal(f.backend.diagnostics().listenerErrors, 4, 'Each rejected invocation is counted')
    assert.equal(f.transport.failure, null, 'Observer failure does not fail the native transport')
  } finally {
    removePromise()
    removeThenable()
    removeHealthy()
    pending.resolve()
    await f.backend.dispose()
  }
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

test('renderer fault injection has a fixed native operation and cannot accept a forged scope', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    let result: unknown = null
    f.handle((command) => {
      f.reply(command, command.op === 'rpc.qualification.renderer.crash' ? result : null)
      if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
    })
    await f.backend.qualifyRendererCrash(scope)
    assert.equal(f.commands.at(-1)?.op, 'rpc.qualification.renderer.crash')
    assert.deepEqual(f.commands.at(-1)?.args, { id: 3, scope: nativePolicyScope() })
    const before = f.commands.length
    await assert.rejects(f.backend.qualifyRendererCrash({ ...scope } as PolicyScope), /foreign/)
    assert.equal(f.commands.length, before)
    for (result of [true, 1, {}, { pid: 1 }, { accepted: true }])
      await assert.rejects(f.backend.qualifyRendererCrash(scope), /injection receipt/)
  } finally {
    await f.backend.dispose()
  }
})

test('renderer fault injection rejects a scope retired before dispatch without issuing a native command', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'https://example.test/', documentId: 'native-3-2' },
    })
    await turn()
    const before = f.commands.length
    await assert.rejects(f.backend.qualifyRendererCrash(scope), /stale|changed|ready|document/)
    assert.equal(f.commands.length, before)
  } finally {
    await f.backend.dispose()
  }
})
