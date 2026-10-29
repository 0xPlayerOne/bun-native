import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  normalizeStatusItem,
  type PolicyScope,
  type StatusItemHandle,
  type ViewHandle,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const code = (expected: string) => (error: unknown) =>
  error instanceof Error &&
  error.name === 'BunlyError' &&
  'code' in error &&
  error.code === expected
async function fixture(supported = true) {
  const peer = await nativePeer({
    desktopCapabilities: {
      version: 1,
      capabilities: supported ? ['status.item', 'app.lifecycle'] : ['app.lifecycle'],
    },
  })
  const backend = new CefBackend(peer.transport)
  const grants = new Set<number>()
  const registrations = new Map<string, number>()
  let next = 0
  let intercept: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (intercept?.(command)) return
    if (command.op === 'policy.scope') {
      const id = Number(command.args['id'])
      peer.reply(command, {
        view: id,
        session: 1,
        generation: 1,
        mainFrame: 'frame-' + id,
        document: 'native-' + id + '-1',
        origin: 'app://ui',
      })
    } else if (command.op === 'policy.native.grant') {
      const scope = command.args['scope'] as { view: number }
      if ((command.args['capability'] as { name: string }).name === 'status-item')
        grants.add(scope.view)
      peer.reply(command)
    } else if (command.op === 'status.create') {
      const scope = command.args['scope'] as { view: number }
      if (!grants.has(scope.view))
        peer.reject(command, 'PERMISSION_DENIED: status-item document grant missing')
      else {
        registrations.set(String(command.args['registration']), scope.view)
        peer.reply(command)
      }
    } else if (command.op === 'status.dispose') {
      registrations.delete(String(command.args['registration']))
      peer.reply(command)
    } else
      peer.reply(
        command,
        ['window.create', 'view.create', 'session.create'].includes(command.op)
          ? { id: ++next }
          : null
      )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'status' })
  const window = await backend.createWindow({
    title: 'status',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const createView = () =>
    backend.createView({
      session,
      window,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
  const view = await createView()
  const scope = await backend.capturePolicyScope(view)
  const grant = async (view: ViewHandle) => {
    const scope = await backend.capturePolicyScope(view)
    await backend.grantNativeCapability(scope, { name: 'status-item' })
    return scope
  }
  return {
    ...peer,
    backend,
    view,
    scope,
    createView,
    grant,
    intercept(callback?: (command: Command) => boolean) {
      intercept = callback
    },
    emit(
      handle: StatusItemHandle,
      sequence: number,
      type = 'click',
      extra: object = {},
      target = registrations.get(handle.id) ?? 3
    ) {
      peer.send({
        v: 1,
        event: 'status.item',
        target,
        data: { registration: handle.id, sequence, type, ...extra },
      })
    },
    cleanup: () => backend.dispose(),
  }
}

test('status item definitions snapshot exact bounded Unicode text without icon or menu fields', () => {
  const input = { title: 'Ready Ω', tooltip: 'Details' }
  const result = normalizeStatusItem(input)
  input.title = 'Changed'
  assert.deepEqual(result, { title: 'Ready Ω', tooltip: 'Details' })
  assert.ok(Object.isFrozen(result))
  assert.equal(
    normalizeStatusItem({ title: '😀'.repeat(16), tooltip: 'Ω'.repeat(128) }).title.length,
    32
  )
  for (const value of [
    null,
    [],
    {},
    { title: '' },
    { title: ' ' },
    { title: 'a'.repeat(65) },
    { title: '😀'.repeat(17) },
    { title: '\ud800' },
    { title: 'line\nbreak' },
    { title: 'Ready\u0085' },
    { title: 'Ready', tooltip: '\u009f' },
    { title: 'Ready', tooltip: null },
    { title: 'Ready', tooltip: 'a'.repeat(257) },
    { title: 'Ready', icon: '/private/path' },
    { title: 'Ready', menu: [] },
  ])
    assert.throws(() => normalizeStatusItem(value), code('INVALID_ARGUMENT'))
})

test('status items require a distinct native grant and authentic scope and handle identities', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      f.backend.createStatusItem(f.scope, { title: 'Ready' }),
      code('PERMISSION_DENIED')
    )
    assert.equal(f.backend.statusItemDiagnostics().items, 0)
    const scope = await f.grant(f.view)
    const item = await f.backend.createStatusItem(scope, { title: 'Ready' })
    assert.ok(Object.isFrozen(item))
    await assert.rejects(
      f.backend.updateStatusItem({ ...item } as StatusItemHandle, { title: 'Forged' }),
      code('INVALID_HANDLE')
    )
    await assert.rejects(
      f.backend.createStatusItem({} as PolicyScope, { title: 'Forged' }),
      code('PERMISSION_DENIED')
    )
    const other = await fixture()
    try {
      await assert.rejects(
        other.backend.updateStatusItem(item, { title: 'Foreign' }),
        code('INVALID_HANDLE')
      )
    } finally {
      await other.cleanup()
    }
    await f.backend.updateStatusItem(item, { title: 'Updated Ω', tooltip: 'Owned' })
    await f.backend.disposeStatusItem(item)
    await f.backend.disposeStatusItem(item)
    assert.deepEqual(f.backend.statusItemDiagnostics(), { items: 0, listeners: 0 })
  } finally {
    await f.cleanup()
  }
})

test('status capacity charges four global owners and one owner per view through native disposal', async () => {
  const f = await fixture()
  try {
    const first = await f.backend.createStatusItem(await f.grant(f.view), { title: 'First' })
    await assert.rejects(
      f.backend.createStatusItem(f.scope, { title: 'Duplicate' }),
      code('RESOURCE_IN_USE')
    )
    for (let index = 0; index < 3; index++) {
      const view = await f.createView()
      await f.backend.createStatusItem(await f.grant(view), { title: 'Other' })
    }
    const fifth = await f.createView()
    const fifthScope = await f.grant(fifth)
    await assert.rejects(
      f.backend.createStatusItem(fifthScope, { title: 'Fifth' }),
      code('RESOURCE_IN_USE')
    )
    let disposal: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'status.dispose') return false
      disposal = command
      return true
    })
    const closing = f.backend.disposeStatusItem(first)
    assert.equal(f.backend.disposeStatusItem(first), closing)
    await assert.rejects(
      f.backend.createStatusItem(fifthScope, { title: 'Too early' }),
      code('RESOURCE_IN_USE')
    )
    assert.equal(f.backend.statusItemDiagnostics().items, 4)
    f.reply(disposal!)
    await closing
    f.intercept()
    await f.backend.createStatusItem(fifthScope, { title: 'Replacement' })
    assert.equal(f.backend.statusItemDiagnostics().items, 4)
  } finally {
    await f.cleanup()
  }
})

test('an aborted pending creation retains its reservation until the actual native removal reply', async () => {
  const f = await fixture()
  try {
    const scope = await f.grant(f.view)
    let creation: Command | undefined, disposal: Command | undefined
    f.intercept((command) => {
      if (command.op === 'status.create') {
        creation = command
        return true
      }
      if (command.op === 'status.dispose') {
        disposal = command
        return true
      }
      return false
    })
    const controller = new AbortController()
    const creating = f.backend.createStatusItem(
      scope,
      { title: 'Pending' },
      { signal: controller.signal }
    )
    const rejected = assert.rejects(creating, /AbortError|aborted/)
    controller.abort()
    assert.equal(f.backend.statusItemDiagnostics().items, 1)
    f.reply(creation!)
    await turn()
    assert.ok(disposal)
    assert.equal(f.backend.statusItemDiagnostics().items, 1)
    f.reply(disposal)
    await rejected
    assert.deepEqual(f.backend.statusItemDiagnostics(), { items: 0, listeners: 0 })
  } finally {
    await f.cleanup()
  }
})

test('status listeners have a global bound, support abort, and recheck authority between callbacks', async () => {
  const f = await fixture()
  try {
    const item = await f.backend.createStatusItem(await f.grant(f.view), { title: 'Ready' })
    const controller = new AbortController()
    for (let index = 0; index < 16; index++)
      f.backend.onStatusItemEvent(item, () => {}, { signal: controller.signal })
    assert.throws(() => f.backend.onStatusItemEvent(item, () => {}), code('RESOURCE_IN_USE'))
    controller.abort()
    assert.equal(f.backend.statusItemDiagnostics().listeners, 0)
    let later = 0
    let navigation: ReturnType<CefBackend['navigate']> | undefined
    f.backend.onStatusItemEvent(item, () => {
      navigation = f.backend.navigate(f.view, 'app://ui/index.html?next=1')
    })
    f.backend.onStatusItemEvent(item, () => {
      later++
    })
    f.emit(item, 1)
    await turn()
    await navigation
    assert.equal(later, 0)
    await assert.rejects(f.backend.updateStatusItem(item, { title: 'Stale' }), code('DISPOSED'))
    assert.equal(f.backend.statusItemDiagnostics().items, 0)
  } finally {
    await f.cleanup()
  }
})

test('native revocation and explicit disposal fence later status callbacks', async () => {
  for (const reason of ['native', 'dispose', 'view-close'] as const) {
    const f = await fixture()
    try {
      const item = await f.backend.createStatusItem(await f.grant(f.view), { title: 'Ready' })
      const events: string[] = []
      f.backend.onStatusItemEvent(item, (event) => events.push(event.type))
      if (reason === 'native') f.emit(item, 1, 'revoked')
      else if (reason === 'dispose') await f.backend.disposeStatusItem(item)
      else await f.backend.disposeView(f.view)
      f.emit(item, 2)
      await turn()
      assert.deepEqual(events, reason === 'native' ? ['revoked'] : [])
      assert.deepEqual(f.backend.statusItemDiagnostics(), { items: 0, listeners: 0 })
    } finally {
      await f.cleanup()
    }
  }
})

test('failed native disposal remains owned and can be retried without permitting more input', async () => {
  const f = await fixture()
  try {
    const item = await f.backend.createStatusItem(await f.grant(f.view), { title: 'Ready' })
    f.intercept((command) => {
      if (command.op !== 'status.dispose') return false
      f.reject(command, 'RESOURCE_IN_USE: native owner remains')
      return true
    })
    await assert.rejects(f.backend.disposeStatusItem(item), code('RESOURCE_IN_USE'))
    assert.equal(f.backend.statusItemDiagnostics().items, 1)
    await assert.rejects(f.backend.updateStatusItem(item, { title: 'Retired' }), code('DISPOSED'))
    f.intercept()
    await f.backend.disposeStatusItem(item)
    assert.equal(f.backend.statusItemDiagnostics().items, 0)
  } finally {
    await f.cleanup()
  }
})

test('malformed native creation and callbacks fail closed without claiming native ownership was released', async () => {
  for (const malformed of ['creation', 'target', 'duplicate', 'fields', 'token-newline'] as const) {
    const f = await fixture()
    await f.grant(f.view)
    if (malformed === 'creation') {
      f.intercept((command) => {
        if (command.op !== 'status.create') return false
        f.reply(command, { ignored: true })
        return true
      })
      await assert.rejects(f.backend.createStatusItem(f.scope, { title: 'Ready' }), /Malformed/)
    } else {
      const item = await f.backend.createStatusItem(f.scope, { title: 'Ready' })
      f.emit(item, 1)
      await turn()
      if (malformed === 'target') f.emit(item, 2, 'click', {}, 99)
      else if (malformed === 'duplicate') f.emit(item, 1)
      else if (malformed === 'token-newline')
        f.emit(item, 2, 'click', { registration: item.id + '\n' })
      else f.emit(item, 2, 'click', { title: 'Untrusted diagnostic' })
    }
    await assert.rejects(f.backend.closed, /native status item/)
    assert.deepEqual(f.backend.statusItemDiagnostics(), { items: 1, listeners: 0 })
    await assert.rejects(f.cleanup())
  }
})

test('unsupported hosts and mock report status items unavailable without native creation', async () => {
  const f = await fixture(false)
  try {
    await assert.rejects(
      f.backend.createStatusItem(f.scope, { title: 'Unavailable' }),
      code('UNSUPPORTED_CAPABILITY')
    )
    assert.equal(
      f.commands.some((command) => command.op.startsWith('status.')),
      false
    )
    const mock = new MockBackend()
    await assert.rejects(
      mock.createStatusItem({} as PolicyScope, { title: 'Unavailable' }),
      code('UNSUPPORTED_CAPABILITY')
    )
    await mock.dispose()
  } finally {
    await f.cleanup()
  }
})

test('managed status items survive generations while click journals require a current read before ack', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend, { maxEvents: 2 })
  try {
    const authority = await desktop.captureAuthority(f.view)
    const item = await f.backend.createStatusItem(await f.grant(f.view), { title: 'Managed' })
    const resource = desktop.registerStatusItem('status', item, {
      authority,
      permission: 'status',
      operations: ['update', 'events', 'ack-events'],
    })
    const bindings = await desktop.prepare()
    const first = owner.begin('status:1', ['status'])
    owner.attach(first, resource, bindings['status']!.schema)
    owner.commit(first, '{}')
    const firstScope = owner.scope(first)
    f.emit(item, 1)
    assert.equal(JSON.parse(await firstScope.invoke(resource, 'events', 'null')).length, 1)
    const second = owner.begin('status:1', ['status'])
    owner.attach(second, resource, bindings['status']!.schema)
    owner.commit(second, '{}')
    const secondScope = owner.scope(second)
    assert.throws(() => owner.scope(first), /RETIRED/)
    await assert.rejects(firstScope.invoke(resource, 'ack-events', '{"through":1}'), /RETIRED/)
    await assert.rejects(
      secondScope.invoke(resource, 'ack-events', '{"through":1}'),
      /INVALID_ARGUMENT/
    )
    assert.equal(JSON.parse(await secondScope.invoke(resource, 'events', 'null')).length, 1)
    await secondScope.invoke(resource, 'ack-events', '{"through":1}')
    await secondScope.invoke(resource, 'update', '{"title":"Generation two"}')
    assert.equal(f.commands.filter((command) => command.op === 'status.create').length, 1)
    for (let sequence = 2; sequence <= 4; sequence++) f.emit(item, sequence)
    await assert.rejects(secondScope.invoke(resource, 'events', 'null'), /CAPACITY/)
    await f.backend.disposeStatusItem(item)
    await assert.rejects(desktop.prepare(), /DENIED/)
    await desktop.close('status')
    assert.equal(f.backend.statusItemDiagnostics().items, 0)
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.cleanup()
  }
})
