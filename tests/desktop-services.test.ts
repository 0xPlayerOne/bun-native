import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'
import { ApplicationLifecycle } from '../packages/runtime/src/application-lifecycle.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import {
  BunlyError,
  validateClipboardText,
  type ApplicationEvent,
  type PolicyScope,
} from '../packages/contracts/src/index.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const hasCode = (code: string) => (error: unknown) =>
  error instanceof BunlyError && error.code === code

async function fixture(desktopCapabilities?: unknown) {
  const peer =
    desktopCapabilities === undefined
      ? await nativePeer()
      : await nativePeer({ desktopCapabilities })
  const backend = new CefBackend(peer.transport)
  const nativeScope = {
    view: 3,
    session: 1,
    generation: 1,
    mainFrame: 'main',
    document: 'native-3-1',
    origin: 'app://ui',
  }
  let next = 0,
    text: string | null = null
  let intercept: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (intercept?.(command)) return
    if (command.op === 'clipboard.write') text = String(command.args['text'])
    if (command.op === 'clipboard.clear') text = null
    peer.reply(
      command,
      command.op.endsWith('.create')
        ? { id: ++next }
        : command.op === 'policy.scope'
          ? nativeScope
          : command.op === 'clipboard.read'
            ? text
            : command.op === 'clipboard.qualification.empty'
              ? text === null
              : null
    )
    if (command.op === 'quit') {
      peer.send({ v: 1, event: 'app.quitting', data: { reason: 'requested' } })
      peer.send({ v: 1, event: 'shutdown', data: { failed: false } })
    }
  })
  const session = await backend.createSession({
    partition: 'desktop-services',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'services',
    bounds: { x: 0, y: 0, width: 600, height: 400 },
  })
  const view = await backend.createView({
    session,
    window,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const scope = await backend.capturePolicyScope(view)
  return {
    ...peer,
    backend,
    scope,
    nativeScope,
    window,
    view,
    intercept(handler?: (command: Command) => boolean) {
      intercept = handler
    },
  }
}

test('clipboard text uses exact captured scope, bounded Unicode and actual native return values', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.backend.readClipboardText(f.scope), null)
    await f.backend.writeClipboardText(f.scope, 'A🐙\nλ')
    assert.equal(await f.backend.readClipboardText(f.scope), 'A🐙\nλ')
    await f.backend.writeClipboardText(f.scope, '')
    assert.equal(await f.backend.readClipboardText(f.scope), '')
    assert.equal(await f.backend.qualifyClipboardEmpty(f.scope), false)
    await f.backend.clearClipboard(f.scope)
    assert.equal(await f.backend.readClipboardText(f.scope), null)
    assert.equal(await f.backend.qualifyClipboardEmpty(f.scope), true)
    assert.deepEqual(f.commands.find((command) => command.op === 'clipboard.clear')?.args, {
      id: 3,
      scope: f.nativeScope,
    })
    assert.deepEqual(f.commands.find((command) => command.op === 'clipboard.write')?.args, {
      id: 3,
      scope: f.nativeScope,
      text: 'A🐙\nλ',
    })
    const admitted = f.commands.length
    for (const text of [
      'x'.repeat(8193),
      '🐙'.repeat(2049),
      '\0',
      '\ud800',
      '\udc00',
      '\ud800x',
      1,
      null,
    ]) {
      await assert.rejects(
        f.backend.writeClipboardText(f.scope, text as string),
        hasCode('INVALID_ARGUMENT')
      )
    }
    assert.equal(f.commands.length, admitted)
    validateClipboardText('🐙'.repeat(2048))
    validateClipboardText('x'.repeat(8192))
    await assert.rejects(
      f.backend.readClipboardText({ ...f.scope } as PolicyScope),
      hasCode('PERMISSION_DENIED')
    )
    f.intercept((command) => {
      if (!command.op.startsWith('clipboard.')) return false
      f.reject(command, 'PERMISSION_DENIED: clipboard capability scope mismatch')
      return true
    })
    await assert.rejects(f.backend.readClipboardText(f.scope), hasCode('PERMISSION_DENIED'))
    await assert.rejects(f.backend.clearClipboard(f.scope), hasCode('PERMISSION_DENIED'))
  } finally {
    await f.stop()
  }
})

test('clipboard read results cannot cross native document changes, cancellation or local disposal', async () => {
  const f = await fixture()
  try {
    f.intercept((command) => command.op.startsWith('clipboard.'))
    const aborted = new AbortController()
    const pending = f.backend.readClipboardText(f.scope, { signal: aborted.signal })
    const rejected = assert.rejects(pending, /abort/i)
    aborted.abort()
    await rejected
    assert.equal(f.transport.diagnostics().abandoned, 1)
    f.reply(f.commands.at(-1)!, 'late text')
    await turn()
    assert.equal(f.transport.diagnostics().abandoned, 0)
    const changed = f.backend.readClipboardText(f.scope)
    const stale = assert.rejects(changed, hasCode('PERMISSION_DENIED'))
    f.send({ v: 1, event: 'view.navigating', target: 3, data: { url: 'app://ui/index.html' } })
    f.reply(f.commands.at(-1)!, 'old document text')
    await stale
  } finally {
    await f.stop()
  }
  const disposed = await fixture()
  disposed.intercept((command) => command.op === 'clipboard.read' || command.op === 'quit')
  const pending = disposed.backend.readClipboardText(disposed.scope)
  const rejected = assert.rejects(pending, hasCode('DISPOSED'))
  const closing = disposed.backend.dispose()
  disposed.reply(
    disposed.commands.find((command) => command.op === 'clipboard.read')!,
    'stale'
  )
  await rejected
  disposed.reply(disposed.commands.at(-1)!)
  disposed.send({ v: 1, event: 'shutdown', data: { failed: false } })
  await closing
})

test('clipboard malformed readback and unsupported platforms cannot masquerade as usable text', async () => {
  const f = await fixture()
  try {
    for (const value of [1, {}, '\0', '\ud800', 'x'.repeat(8193)]) {
      f.intercept((command) => {
        if (command.op !== 'clipboard.read') return false
        f.reply(command, value)
        return true
      })
      await assert.rejects(f.backend.readClipboardText(f.scope), /Malformed native clipboard text/)
    }
  } finally {
    await f.stop()
  }
  const linux = await fixture({
    version: 1,
    capabilities: ['window.state', 'window.geometry', 'app.lifecycle'],
  })
  try {
    assert.ok(!linux.backend.descriptor.capabilities.includes('clipboard.text'))
    const admitted = linux.commands.length
    await assert.rejects(
      linux.backend.readClipboardText(linux.scope),
      hasCode('UNSUPPORTED_CAPABILITY')
    )
    await assert.rejects(
      linux.backend.writeClipboardText(linux.scope, 'text'),
      hasCode('UNSUPPORTED_CAPABILITY')
    )
    await assert.rejects(
      linux.backend.clearClipboard(linux.scope),
      hasCode('UNSUPPORTED_CAPABILITY')
    )
    assert.equal(linux.commands.length, admitted)
  } finally {
    await linux.stop()
  }
})

test('application quit intent remains separate from native observations and cleanup completion', async () => {
  const f = await fixture()
  const events: ApplicationEvent[] = []
  f.backend.onApplicationEvent((event) => {
    assert.ok(Object.isFrozen(event))
    events.push(event)
  })
  assert.deepEqual(await f.backend.whenApplicationReady(), {
    phase: 'running',
    quitRequested: false,
    quitReason: null,
    outcome: 'pending',
  })
  f.intercept((command) => command.op === 'quit')
  const quit = f.backend.quit()
  const duplicate = f.backend.quit()
  assert.equal(quit, duplicate)
  assert.equal(f.commands.filter((command) => command.op === 'quit').length, 1)
  assert.equal(f.backend.applicationState().phase, 'running')
  assert.equal(f.backend.applicationState().quitRequested, true)
  assert.deepEqual(events, [{ type: 'quit-requested' }])
  f.reply(f.commands.at(-1)!)
  f.send({ v: 1, event: 'app.quitting', data: { reason: 'requested' } })
  await turn()
  assert.equal(f.backend.applicationState().phase, 'quitting')
  f.send({ v: 1, event: 'shutdown', data: { failed: false } })
  await quit
  assert.deepEqual(events, [
    { type: 'quit-requested' },
    { type: 'quitting', reason: 'requested' },
    { type: 'closed', outcome: 'orderly' },
  ])
  assert.equal(f.backend.applicationState().outcome, 'orderly')
  assert.equal(f.backend.diagnostics().listeners, 0)
})

test('native-initiated shutdown, late native failure and abrupt transport failure remain distinct', async () => {
  for (const kind of ['last-window', 'native-failure', 'observed-failure', 'abrupt'] as const) {
    const f = await fixture()
    const events: ApplicationEvent[] = []
    f.backend.onApplicationEvent((event) => events.push(event))
    if (kind === 'abrupt') f.transport.fail(new Error('injected disconnected host'))
    else {
      f.send({
        v: 1,
        event: 'app.quitting',
        data: { reason: kind === 'observed-failure' ? 'failure' : 'last-window' },
      })
      f.send({ v: 1, event: 'shutdown', data: { failed: kind === 'native-failure' } })
    }
    if (kind === 'last-window') await f.backend.closed
    else await assert.rejects(f.backend.closed, /failed shutdown|shutdown failed|disconnected host/)
    assert.equal(f.backend.applicationState().quitRequested, false)
    assert.equal(
      f.backend.applicationState().outcome,
      kind === 'last-window' ? 'orderly' : 'failed'
    )
    assert.equal(
      events.filter((event) => event.type === 'quitting').length,
      kind === 'abrupt' ? 0 : 1
    )
    assert.equal(events.at(-1)?.type, 'closed')
  }
})

test('a pre-readiness disposal race retains intent while preserving the existing failed startup shutdown', async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  const transport = new NativeTransport(input, output),
    backend = new CefBackend(transport)
  const ready = backend.whenApplicationReady()
  const closed = assert.rejects(backend.dispose(), /Native transport is not ready/)
  input.write(
    JSON.stringify({
      v: 1,
      event: 'ready',
      abi: 1,
      data: { desktopCapabilities: { version: 1, capabilities: ['app.lifecycle'] } },
    }) + '\n'
  )
  assert.deepEqual(await ready, {
    phase: 'running',
    quitRequested: true,
    quitReason: null,
    outcome: 'pending',
  })
  await turn()
  await closed
  assert.equal(output.read(), null)
  assert.deepEqual(backend.applicationState(), {
    phase: 'closed',
    quitRequested: true,
    quitReason: null,
    outcome: 'failed',
  })
})

test('readiness waiters and lifecycle subscriptions are bounded, abortable and generation-owned', async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  const transport = new NativeTransport(input, output),
    backend = new CefBackend(transport)
  const controllers = Array.from({ length: 64 }, () => new AbortController())
  const waits = controllers.map((controller) =>
    backend.whenApplicationReady({ signal: controller.signal })
  )
  await assert.rejects(backend.whenApplicationReady(), hasCode('RESOURCE_IN_USE'))
  const cancelled = assert.rejects(waits[0]!, /abort/i)
  controllers[0]!.abort()
  await cancelled
  const replacement = backend.whenApplicationReady()
  input.write(
    JSON.stringify({
      v: 1,
      event: 'ready',
      abi: 1,
      data: { desktopCapabilities: { version: 1, capabilities: ['app.lifecycle'] } },
    }) + '\n'
  )
  for (const wait of [...waits.slice(1), replacement]) assert.equal((await wait).phase, 'running')
  assert.equal(backend.diagnostics().listeners, 0)
  const owner = new ManagedGenerationOwner()
  const generation = owner.begin('lifecycle:1', [])
  owner.commit(generation, '{}')
  const events: ApplicationEvent[] = []
  let stop = () => {}
  const work = owner.own(generation, 'listener', () => stop())
  stop = backend.onApplicationEvent(
    (event) => {
      owner.callback(generation, work, () => {
        events.push(event)
        return undefined
      })()
    },
    { signal: owner.scope(generation).signal }
  )
  const successor = owner.begin('lifecycle:1', [])
  owner.commit(successor, '{}')
  assert.equal(backend.diagnostics().listeners, 0)
  input.write('{"v":1,"event":"app.quitting","data":{"reason":"native"}}\n')
  input.write('{"v":1,"event":"shutdown","data":{"failed":false}}\n')
  await backend.closed
  assert.deepEqual(events, [])
  owner.dispose()
  const lifecycle = new ApplicationLifecycle()
  lifecycle.ready(true)
  const removals = Array.from({ length: 64 }, () => lifecycle.subscribe(() => {}))
  assert.throws(() => lifecycle.subscribe(() => {}), hasCode('RESOURCE_IN_USE'))
  removals[0]!()
  lifecycle.subscribe(() => {
    throw new Error('listener')
  })
  lifecycle.closed(false)
  assert.equal(lifecycle.diagnostics().listeners, 0)
  assert.equal(lifecycle.diagnostics().listenerErrors, 1)
})

test('legacy hosts and mock implementations report lifecycle and clipboard as unsupported', async () => {
  const peer = await nativePeer({ desktopCapabilities: undefined })
  const backend = new CefBackend(peer.transport)
  try {
    await assert.rejects(backend.whenApplicationReady(), hasCode('UNSUPPORTED_CAPABILITY'))
    await assert.rejects(backend.quit(), hasCode('UNSUPPORTED_CAPABILITY'))
    assert.throws(() => backend.applicationState(), hasCode('UNSUPPORTED_CAPABILITY'))
    assert.throws(() => backend.onApplicationEvent(() => {}), hasCode('UNSUPPORTED_CAPABILITY'))
  } finally {
    await peer.stop()
  }
  const mock = new MockBackend()
  await assert.rejects(mock.readClipboardText({} as PolicyScope), hasCode('UNSUPPORTED_CAPABILITY'))
  await assert.rejects(
    mock.writeClipboardText({} as PolicyScope, 'text'),
    hasCode('UNSUPPORTED_CAPABILITY')
  )
  await assert.rejects(mock.clearClipboard({} as PolicyScope), hasCode('UNSUPPORTED_CAPABILITY'))
  await assert.rejects(mock.whenApplicationReady(), hasCode('UNSUPPORTED_CAPABILITY'))
  await assert.rejects(mock.quit(), hasCode('UNSUPPORTED_CAPABILITY'))
  await mock.dispose()
})

test('malformed or duplicate native lifecycle receipts fail closed and retire observers', async () => {
  for (const frame of [
    { v: 1, event: 'app.quitting', data: { reason: 'invented' } },
    { v: 1, event: 'app.quitting', target: 3, data: { reason: 'native' } },
    { v: 1, event: 'shutdown', data: { failed: 'false' } },
    { v: 1, event: 'shutdown', data: { failed: false, extra: true } },
  ]) {
    const f = await fixture()
    const events: ApplicationEvent[] = []
    f.backend.onApplicationEvent((event) => events.push(event))
    f.send(frame)
    await assert.rejects(f.backend.closed, /Malformed native/)
    assert.equal(f.backend.applicationState().outcome, 'failed')
    assert.equal(f.backend.diagnostics().listeners, 0)
    assert.deepEqual(events, [{ type: 'closed', outcome: 'failed' }])
  }
  const f = await fixture()
  f.send({ v: 1, event: 'app.quitting', data: { reason: 'native' } })
  await turn()
  const admitted = f.commands.length
  await assert.rejects(f.backend.readClipboardText(f.scope), hasCode('DISPOSED'))
  assert.equal(f.commands.length, admitted)
  f.send({ v: 1, event: 'app.quitting', data: { reason: 'native' } })
  await assert.rejects(f.backend.closed, /Duplicate native application quitting/)
})

test('managed clipboard calls preserve generation authority without owning or clearing user clipboard data', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend)
  try {
    const authority = await desktop.captureAuthority(f.view)
    const resource = desktop.registerClipboard('clipboard', {
      authority,
      permission: 'clipboard',
      operations: ['read-text', 'write-text'],
    })
    const generation = owner.begin('clipboard:1', ['clipboard'])
    owner.attach(generation, resource, 'bunly.clipboard:1')
    owner.commit(generation, '{}')
    await owner.invoke(
      generation,
      resource,
      'write-text',
      JSON.stringify({ text: 'retained clipboard content' })
    )
    const successor = owner.begin('clipboard:1', ['clipboard'])
    owner.attach(successor, resource, 'bunly.clipboard:1')
    owner.commit(successor, '{}')
    await assert.rejects(
      owner.invoke(generation, resource, 'write-text', '{"text":"stale"}'),
      /RETIRED/
    )
    assert.equal(
      await owner.invoke(successor, resource, 'read-text', 'null'),
      JSON.stringify('retained clipboard content')
    )
    await assert.rejects(owner.invoke(successor, resource, 'clear', 'null'), /DENIED/)
    await desktop.dispose()
    assert.equal(await f.backend.readClipboardText(f.scope), 'retained clipboard content')
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.stop()
  }
})

test('managed clipboard clear requires its own allowed operation and retains no global data ownership', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend)
  try {
    const authority = await desktop.captureAuthority(f.view)
    const resource = desktop.registerClipboard('clipboard-clear', {
      authority,
      permission: 'clipboard',
      operations: ['clear'],
    })
    const generation = owner.begin('clipboard:1', ['clipboard'])
    owner.attach(generation, resource, 'bunly.clipboard:1')
    owner.commit(generation, '{}')
    await f.backend.writeClipboardText(f.scope, 'owned test content')
    await assert.rejects(owner.invoke(generation, resource, 'clear', '{}'), /INVALID_ARGUMENT/)
    assert.equal(await f.backend.readClipboardText(f.scope), 'owned test content')
    assert.equal(await owner.invoke(generation, resource, 'clear', 'null'), 'null')
    assert.equal(await f.backend.readClipboardText(f.scope), null)
    const clears = f.commands.filter((command) => command.op === 'clipboard.clear').length
    await desktop.dispose()
    assert.equal(f.commands.filter((command) => command.op === 'clipboard.clear').length, clears)
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.stop()
  }
})
