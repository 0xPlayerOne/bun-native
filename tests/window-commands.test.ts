import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  BunlyError,
  normalizeWindowCommands,
  validateWindowMenuPoint,
  type PolicyScope,
  type WindowCommandsDefinition,
  type WindowCommandsEvent,
  type WindowCommandsHandle,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const definition: WindowCommandsDefinition = {
  commands: [
    { id: 'open', label: 'Open panel', shortcut: { key: 'K', control: true, shift: true } },
    { id: 'disabled', label: 'Disabled', enabled: false },
  ],
  menu: [
    { type: 'command', command: 'open' },
    { type: 'separator' },
    { type: 'submenu', label: 'More', items: [{ type: 'command', command: 'disabled' }] },
  ],
}
const code = (code: string) => (error: unknown) =>
  error instanceof BunlyError && error.code === code
async function fixture(capabilities?: unknown) {
  const peer =
    capabilities === undefined
      ? await nativePeer()
      : await nativePeer({ desktopCapabilities: capabilities })
  const backend = new CefBackend(peer.transport)
  let next = 0
  const scopeWire = {
    view: 3,
    session: 1,
    generation: 1,
    mainFrame: 'main',
    document: 'native-3-1',
    origin: 'app://ui',
  }
  const registrations = new Set<string>()
  let intercept: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (intercept?.(command)) return
    if (command.op === 'commands.create') registrations.add(String(command.args['registration']))
    if (command.op === 'commands.dispose')
      registrations.delete(String(command.args['registration']))
    peer.reply(
      command,
      command.op === 'commands.create'
        ? null
        : command.op.endsWith('.create')
          ? { id: ++next }
          : command.op === 'policy.scope'
            ? scopeWire
            : command.op === 'commands.cancel'
              ? { pending: false }
              : command.op === 'commands.qualification.snapshot'
                ? { registrations: registrations.size, shortcuts: registrations.size, popups: 0 }
                : null
    )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'commands' })
  const window = await backend.createWindow({
    title: 'commands',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
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
    view,
    window,
    scope,
    scopeWire,
    intercept(callback?: (command: Command) => boolean) {
      intercept = callback
    },
    emit(
      handle: WindowCommandsHandle,
      sequence: number,
      data: Record<string, unknown>,
      target = 3
    ) {
      peer.send({
        v: 1,
        event: 'window.commands',
        target,
        data: { registration: handle.id, sequence, ...data },
      })
    },
    cleanup: () => backend.dispose(),
  }
}

test('command definitions snapshot bounded Unicode labels, chords and menu trees', () => {
  const source = structuredClone(definition)
  const normalized = normalizeWindowCommands(source)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.commands[0]))
  assert.ok(Object.isFrozen(normalized.commands[0]?.shortcut))
  assert.ok(Object.isFrozen(normalized.menu))
  assert.equal(normalized.commands[0]?.enabled, true)
  assert.equal(normalized.commands[0]?.shortcut?.alt, false)
  const single = {
    commands: [{ id: 'a', label: '😀'.repeat(32) }],
    menu: [{ type: 'command', command: 'a' }],
  }
  normalizeWindowCommands(single)
  for (const label of ['', ' ', 'A&B', 'A\nB', '\0', '\ud800', '\udc00', '😀'.repeat(33)])
    assert.throws(
      () => normalizeWindowCommands({ ...single, commands: [{ id: 'a', label }] }),
      code('INVALID_ARGUMENT')
    )
  for (const extra of [{ role: 'quit' }, { execute: 'rm' }, { url: 'file:///etc/passwd' }])
    assert.throws(
      () => normalizeWindowCommands({ ...single, commands: [{ id: 'a', label: 'A', ...extra }] }),
      code('INVALID_ARGUMENT')
    )
  const deep = {
    type: 'submenu',
    label: '1',
    items: [
      { type: 'submenu', label: '2', items: [{ type: 'submenu', label: '3', items: single.menu }] },
    ],
  }
  for (const menu of [
    [deep],
    [{ type: 'separator' }],
    [...single.menu, ...single.menu],
    [{ type: 'command', command: 'missing' }],
    Array(65).fill({ type: 'separator' }),
  ])
    assert.throws(() => normalizeWindowCommands({ ...single, menu }), code('INVALID_ARGUMENT'))
})

test('shortcuts reject aliases, bare character capture, duplicates and extra modifiers', () => {
  for (const shortcut of [
    { key: 'a', control: true },
    { key: 'K' },
    { key: 'K', shift: true },
    { key: 'K', meta: true },
    { key: 'F13' },
    { key: 'K', control: 1 },
    null,
  ])
    assert.throws(
      () => normalizeWindowCommands({ commands: [{ id: 'a', label: 'A', shortcut }], menu: [] }),
      code('INVALID_ARGUMENT')
    )
  assert.throws(
    () =>
      normalizeWindowCommands({
        commands: [
          { id: 'a', label: 'A', shortcut: { key: 'K', control: true } },
          { id: 'b', label: 'B', shortcut: { key: 'K', control: true, alt: false } },
        ],
        menu: [],
      }),
    code('INVALID_ARGUMENT')
  )
  normalizeWindowCommands({
    commands: [{ id: 'function', label: 'Function', shortcut: { key: 'F12' } }],
    menu: [],
  })
  for (const point of [
    { x: NaN, y: 0 },
    { x: 0.5, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 16384 },
    { x: 0, y: 0, screen: true },
  ])
    assert.throws(() => validateWindowMenuPoint(point), code('INVALID_ARGUMENT'))
})

test('old host and mock do not advertise or invoke native commands', async () => {
  const f = await fixture({ version: 1, capabilities: ['window.state'] })
  try {
    assert.equal(f.backend.descriptor.capabilities.includes('window.commands'), false)
    await assert.rejects(
      f.backend.createWindowCommands(f.scope, definition),
      code('UNSUPPORTED_CAPABILITY')
    )
    assert.equal(f.commands.filter((command) => command.op.startsWith('commands.')).length, 0)
    const mock = new MockBackend()
    await assert.rejects(
      mock.createWindowCommands(f.scope, definition),
      code('UNSUPPORTED_CAPABILITY')
    )
    await mock.dispose()
  } finally {
    await f.cleanup()
  }
})

test('opaque registrations carry exact native scope and bounded definitions', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      f.backend.createWindowCommands({} as PolicyScope, definition),
      code('PERMISSION_DENIED')
    )
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const create = f.commands.find((command) => command.op === 'commands.create')!
    assert.deepEqual(create.args['scope'], f.scopeWire)
    assert.equal(create.args['registration'], handle.id)
    assert.ok(Object.isFrozen(handle))
    assert.throws(
      () => f.backend.onWindowCommandsEvent({ ...handle } as WindowCommandsHandle, () => {}),
      code('INVALID_HANDLE')
    )
    await assert.rejects(
      f.backend.createWindowCommands(f.scope, definition),
      code('RESOURCE_IN_USE')
    )
    await f.backend.disposeWindowCommands(handle)
    await f.backend.disposeWindowCommands(handle)
    assert.equal(f.commands.filter((command) => command.op === 'commands.dispose').length, 1)
    assert.deepEqual(f.backend.windowCommandsDiagnostics(), {
      registrations: 0,
      listeners: 0,
      popups: 0,
    })
  } finally {
    await f.cleanup()
  }
})

test('native denied grants do not leave an admitted registration', async () => {
  const f = await fixture()
  try {
    f.intercept((command) => {
      if (command.op !== 'commands.create') return false
      f.reject(command, 'PERMISSION_DENIED: missing window-commands document grant')
      return true
    })
    await assert.rejects(
      f.backend.createWindowCommands(f.scope, definition),
      code('PERMISSION_DENIED')
    )
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
  } finally {
    await f.cleanup()
  }
})

test('cancellation during definition and point snapshot never starts the native operation', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    const changing = {
      get commands() {
        controller.abort(new Error('cancelled during validation'))
        return definition.commands
      },
      menu: definition.menu,
    }
    await assert.rejects(
      f.backend.createWindowCommands(f.scope, changing, { signal: controller.signal }),
      /cancelled during validation/
    )
    assert.equal(f.commands.filter((command) => command.op === 'commands.create').length, 0)
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const popup = new AbortController()
    await assert.rejects(
      f.backend.showWindowMenu(
        handle,
        {
          get x() {
            popup.abort(new Error('cancelled during point'))
            return 0
          },
          y: 0,
        },
        { signal: popup.signal }
      ),
      /cancelled during point/
    )
    assert.equal(f.commands.filter((command) => command.op === 'commands.show').length, 0)
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('shutdown intent fences callbacks while retaining native ownership until the actual receipt', async () => {
  const f = await fixture()
  const handle = await f.backend.createWindowCommands(f.scope, definition)
  let quit: Command | undefined
  f.intercept((command) => {
    if (command.op !== 'quit') return false
    quit = command
    return true
  })
  const stopped = f.backend.dispose()
  const released = f.backend.disposeWindowCommands(handle)
  let settled = false
  void released.then(() => {
    settled = true
  })
  await turn()
  assert.equal(settled, false)
  assert.equal(f.backend.windowCommandsDiagnostics().registrations, 1)
  f.reply(quit!)
  f.send({ v: 1, event: 'shutdown', data: { failed: false } })
  await Promise.all([stopped, released])
  assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
})

test('aborted creation remains charged until reply and disposes the late native resource', async () => {
  const f = await fixture()
  try {
    let create: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'commands.create') return false
      create = command
      return true
    })
    const controller = new AbortController()
    const created = f.backend.createWindowCommands(f.scope, definition, {
      signal: controller.signal,
    })
    controller.abort(new Error('owner retired'))
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 1)
    assert.equal(f.transport.diagnostics().requests, 1)
    f.reply(create!)
    await assert.rejects(created, /owner retired/)
    assert.equal(f.commands.filter((command) => command.op === 'commands.dispose').length, 1)
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
    assert.equal(f.transport.diagnostics().requests, 0)
  } finally {
    await f.cleanup()
  }
})

test('a lost creation reply retains unknown native ownership after control failure', async () => {
  const f = await fixture()
  f.intercept((command) => command.op === 'commands.create')
  const created = f.backend.createWindowCommands(f.scope, definition)
  assert.equal(f.backend.windowCommandsDiagnostics().registrations, 1)
  assert.equal(f.commands.filter((command) => command.op === 'commands.create').length, 1)
  f.transport.fail(new Error('lost native creation reply'))
  await assert.rejects(created, /lost native creation reply/)
  await assert.rejects(f.backend.closed, /lost native creation reply/)
  assert.deepEqual(f.backend.windowCommandsDiagnostics(), {
    registrations: 1,
    listeners: 0,
    popups: 0,
  })
  await assert.rejects(f.backend.createWindowCommands(f.scope, definition), code('DISPOSED'))
  await assert.rejects(f.backend.dispose(), /lost native creation reply/)
})

test('registration abort fences listeners synchronously and releases shortcuts', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    const handle = await f.backend.createWindowCommands(f.scope, definition, {
      signal: controller.signal,
    })
    const events: string[] = []
    f.backend.onWindowCommandsEvent(handle, () => {
      events.push('first')
      controller.abort()
    })
    f.backend.onWindowCommandsEvent(handle, () => events.push('second'))
    f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' })
    f.emit(handle, 2, { type: 'command', command: 'open', source: 'shortcut' })
    await turn()
    assert.deepEqual(events, ['first'])
    assert.deepEqual(f.backend.windowCommandsDiagnostics(), {
      registrations: 0,
      listeners: 0,
      popups: 0,
    })
  } finally {
    await f.cleanup()
  }
})

test('listener signals and capacity have independent bounded ownership', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const controller = new AbortController()
    const events: WindowCommandsEvent[] = []
    const stop = f.backend.onWindowCommandsEvent(handle, (event) => events.push(event), {
      signal: controller.signal,
    })
    controller.abort()
    stop()
    f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' })
    await turn()
    assert.equal(events.length, 0)
    const stops = Array.from({ length: 16 }, () =>
      f.backend.onWindowCommandsEvent(handle, () => {})
    )
    assert.equal(f.backend.diagnostics().listeners, 16)
    assert.throws(() => f.backend.onWindowCommandsEvent(handle, () => {}), code('RESOURCE_IN_USE'))
    for (const stop of stops) stop()
    assert.equal(f.backend.windowCommandsDiagnostics().listeners, 0)
    assert.equal(f.backend.diagnostics().listeners, 0)
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('popup admission and actual native shown/closed are distinct and cancellation remains charged', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const controller = new AbortController()
    const events: WindowCommandsEvent[] = []
    f.backend.onWindowCommandsEvent(handle, (event) => events.push(event))
    await f.backend.showWindowMenu(handle, { x: 12, y: 34 }, { signal: controller.signal })
    assert.equal(events.length, 0)
    f.emit(handle, 1, { type: 'menu-shown', popup: 1 })
    f.intercept((command) => {
      if (command.op !== 'commands.cancel') return false
      f.reply(command, { pending: true })
      return true
    })
    controller.abort()
    await turn()
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 1)
    await assert.rejects(f.backend.showWindowMenu(handle, { x: 0, y: 0 }), code('RESOURCE_IN_USE'))
    f.emit(handle, 2, { type: 'command', command: 'open', source: 'menu', popup: 1 })
    f.emit(handle, 3, { type: 'menu-closed', popup: 1 })
    await turn()
    assert.deepEqual(
      events.map((event) => event.type),
      ['menu-shown', 'menu-closed']
    )
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 0)
    await f.backend.showWindowMenu(handle, { x: 0, y: 0 })
    f.emit(handle, 4, { type: 'menu-closed', popup: 1 })
    await turn()
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 1)
    f.emit(handle, 5, { type: 'menu-shown', popup: 2 })
    f.emit(handle, 6, { type: 'command', command: 'open', source: 'menu', popup: 2 })
    f.emit(handle, 7, { type: 'menu-closed', popup: 2 })
    await turn()
    assert.deepEqual(
      events.map((event) => event.type),
      ['menu-shown', 'menu-closed', 'menu-shown', 'command', 'menu-closed']
    )
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('native callback in the same pipe turn as show reply is observed', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const events: string[] = []
    f.backend.onWindowCommandsEvent(handle, (event) => events.push(event.type))
    f.intercept((command) => {
      if (command.op !== 'commands.show') return false
      f.reply(command)
      f.emit(handle, 1, { type: 'menu-shown', popup: command.args['popup'] })
      return true
    })
    await f.backend.showWindowMenu(handle, { x: 0, y: 0 })
    await turn()
    assert.deepEqual(events, ['menu-shown'])
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('abort before the menu admission reply queues exact cleanup and waits for native closure', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    let showing: Command | undefined
    f.intercept((command) => {
      if (command.op === 'commands.show') {
        showing = command
        return true
      }
      if (command.op === 'commands.cancel') {
        f.reply(command, { pending: true })
        return true
      }
      return false
    })
    const owner = new AbortController()
    const shown = f.backend.showWindowMenu(handle, { x: 0, y: 0 }, { signal: owner.signal })
    void shown.catch(() => {})
    owner.abort(new Error('early menu cancellation'))
    await turn()
    assert.ok(showing)
    const cleanup = f.commands.find((command) => command.op === 'commands.cancel')!
    assert.deepEqual(cleanup.args, {
      registration: handle.id,
      scope: f.scopeWire,
      popup: 1,
    })
    assert.ok(f.commands.indexOf(showing) < f.commands.indexOf(cleanup))
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 1)
    f.reply(showing)
    await assert.rejects(shown, /early menu cancellation/)
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 1)
    f.emit(handle, 1, { type: 'menu-shown', popup: 1 })
    f.emit(handle, 2, { type: 'menu-closed', popup: 1 })
    await turn()
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 0)
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('navigation and view or window close queue scoped popup cleanup before native lifecycle work', async () => {
  for (const operation of ['view.navigate', 'view.dispose', 'window.close']) {
    const f = await fixture()
    try {
      const handle = await f.backend.createWindowCommands(f.scope, definition)
      await f.backend.showWindowMenu(handle, { x: 0, y: 0 })
      f.emit(handle, 1, { type: 'menu-shown', popup: 1 })
      let disposal: Command | undefined
      f.intercept((command) => {
        if (command.op !== 'commands.dispose') return false
        disposal = command
        return true
      })
      const closing =
        operation === 'view.navigate'
          ? f.backend.navigate(f.view, 'app://ui/index.html?next=1')
          : operation === 'view.dispose'
            ? f.backend.disposeView(f.view)
            : f.backend.closeWindow(f.window)
      await turn()
      assert.ok(disposal)
      const lifecycle = f.commands.find((command) => command.op === operation)!
      assert.ok(lifecycle)
      assert.ok(f.commands.indexOf(disposal) < f.commands.indexOf(lifecycle))
      assert.deepEqual(disposal.args, { registration: handle.id, scope: f.scopeWire })
      assert.equal(f.backend.windowCommandsDiagnostics().registrations, 1)
      f.reply(disposal)
      await closing
      await turn()
      assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
    } finally {
      await f.cleanup()
    }
  }
})

test('native failure to open is distinct from a closed visible menu and releases the popup', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const events: string[] = []
    f.backend.onWindowCommandsEvent(handle, (event) => events.push(event.type))
    await f.backend.showWindowMenu(handle, { x: 1, y: 1 })
    f.emit(handle, 1, { type: 'menu-failed', popup: 1 })
    await turn()
    assert.deepEqual(events, ['menu-failed'])
    assert.equal(f.backend.windowCommandsDiagnostics().popups, 0)
    await f.backend.disposeWindowCommands(handle)
  } finally {
    await f.cleanup()
  }
})

test('disposal fences events while retaining resource until native completion', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    let disposal: Command | undefined,
      observed = 0
    f.backend.onWindowCommandsEvent(handle, () => observed++)
    f.intercept((command) => {
      if (command.op !== 'commands.dispose') return false
      disposal = command
      return true
    })
    const pending = f.backend.disposeWindowCommands(handle)
    f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' })
    await turn()
    assert.equal(observed, 0)
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 1)
    assert.equal(f.backend.disposeWindowCommands(handle), pending)
    f.reply(disposal!)
    await pending
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
  } finally {
    await f.cleanup()
  }
})

test('navigation retires command authority before the native navigation reply', async () => {
  const f = await fixture()
  try {
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    let observed = 0
    f.backend.onWindowCommandsEvent(handle, () => observed++)
    const navigation = f.backend.navigate(f.view, 'app://ui/index.html?next=1')
    f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' })
    await navigation
    await turn()
    assert.equal(observed, 0)
    await assert.rejects(f.backend.showWindowMenu(handle, { x: 0, y: 0 }), code('DISPOSED'))
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
  } finally {
    await f.cleanup()
  }
})

test('malformed or cross-document native command callback fails the connection closed', async () => {
  for (const malformed of [
    { type: 'command', command: 'disabled', source: 'shortcut' },
    { type: 'command', command: 'not-declared', source: 'shortcut' },
    { type: 'command', command: 'open', source: 'renderer' },
    { type: 'command', command: 'open', source: 'shortcut', extra: true },
  ]) {
    const f = await fixture()
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    f.emit(handle, 1, malformed)
    await assert.rejects(f.backend.closed, /callback/)
    assert.deepEqual(f.backend.windowCommandsDiagnostics(), {
      registrations: 1,
      listeners: 0,
      popups: 0,
    })
    await assert.rejects(f.backend.disposeWindowCommands(handle), /callback/)
  }
  const f = await fixture()
  const handle = await f.backend.createWindowCommands(f.scope, definition)
  f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' }, 4)
  await assert.rejects(f.backend.closed, /identity/)
})

test('managed generations retain the registration and consume a bounded authorized journal', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend, { maxEvents: 2 })
  try {
    const authority = await desktop.captureAuthority(f.view)
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    const resource = desktop.registerWindowCommands('commands', handle, {
      authority,
      permission: 'commands',
      operations: ['show', 'cancel', 'events', 'ack-events'],
    })
    const bindings = await desktop.prepare()
    const first = owner.begin('commands:1', ['commands'])
    owner.attach(first, resource, bindings['commands']!.schema)
    owner.commit(first, '{}')
    const firstScope = owner.scope(first)
    f.emit(handle, 1, { type: 'command', command: 'open', source: 'shortcut' })
    const events = JSON.parse(await firstScope.invoke(resource, 'events', 'null')) as {
      sequence: number
      state: { source: string }
    }[]
    assert.equal(events[0]?.state.source, 'shortcut')
    const second = owner.begin('commands:1', ['commands'])
    owner.attach(second, resource, bindings['commands']!.schema)
    owner.commit(second, '{}')
    const secondScope = owner.scope(second)
    await assert.rejects(firstScope.invoke(resource, 'ack-events', '{"through":1}'), /RETIRED/)
    assert.equal(JSON.parse(await secondScope.invoke(resource, 'events', 'null')).length, 1)
    await secondScope.invoke(resource, 'ack-events', '{"through":1}')
    assert.equal(desktop.diagnostics().queuedEvents, 0)
    assert.equal(f.commands.filter((command) => command.op === 'commands.create').length, 1)
    f.emit(handle, 2, { type: 'command', command: 'open', source: 'shortcut' })
    f.emit(handle, 3, { type: 'command', command: 'open', source: 'shortcut' })
    f.emit(handle, 4, { type: 'command', command: 'open', source: 'shortcut' })
    await assert.rejects(secondScope.invoke(resource, 'events', 'null'), /CAPACITY/)
    await desktop.close('commands')
    assert.equal(f.backend.windowCommandsDiagnostics().registrations, 0)
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.cleanup()
  }
})

test('managed preparation rejects a command resource disposed outside its owner', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend)
  try {
    const authority = await desktop.captureAuthority(f.view)
    const handle = await f.backend.createWindowCommands(f.scope, definition)
    desktop.registerWindowCommands('commands', handle, {
      authority,
      permission: 'commands',
      operations: ['events'],
    })
    await desktop.prepare()
    await f.backend.disposeWindowCommands(handle)
    await assert.rejects(desktop.prepare(), /DENIED/)
    await desktop.close('commands')
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.cleanup()
  }
})
