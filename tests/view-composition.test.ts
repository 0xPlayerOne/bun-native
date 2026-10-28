import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  normalizeViewPresentation,
  parseViewPresentationState,
  type ViewHandle,
  type ViewPresentationOptions,
  type WindowHandle,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { parseCompositionPage } from '../examples/view-composition/contract.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'

const bounds = { x: 20, y: 30, width: 300, height: 200 }
const presentation = { bounds, clip: null, visible: true, focusable: true, tabIndex: 0 }
const observed = {
  presentation,
  layer: 'content',
  viewport: { x: 20, y: 30, width: 280, height: 200 },
  visible: true,
  drawn: true,
  focused: false,
  focusable: true,
}
async function fixture(manual = true) {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) =>
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : observed)
  )
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({
    persistence: 'ephemeral',
    partition: 'composition',
  })
  const window = await backend.createWindow({
    title: 'Composition',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ...(manual ? { viewLayout: 'manual' as const } : {}),
  })
  const options = {
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application' as const, origin: 'app://ui' },
  }
  const view = await backend.createView({
    ...options,
    ...(manual ? { presentation: { bounds } } : {}),
  })
  return { ...peer, backend, window, view, session, options }
}

test('composition normalizes bounded integer DIPs and freezes its own copy', () => {
  const input = { bounds: { ...bounds }, clip: { x: 0, y: 0, width: 0, height: 0 } }
  const actual = normalizeViewPresentation(input)
  assert.deepEqual(actual, {
    bounds,
    clip: { x: 0, y: 0, width: 0, height: 0 },
    visible: true,
    focusable: true,
    tabIndex: 0,
  })
  input.bounds.width = 1
  assert.equal(actual.bounds.width, 300)
  assert.ok(
    Object.isFrozen(actual) && Object.isFrozen(actual.bounds) && Object.isFrozen(actual.clip)
  )
  for (const value of [
    null,
    [],
    {},
    { bounds, extra: 1 },
    { bounds, visible: 1 },
    { bounds, focusable: 'false' },
    { bounds, tabIndex: 128 },
    { bounds, tabIndex: -1 },
  ])
    assert.throws(() => normalizeViewPresentation(value))
  for (const value of [NaN, Infinity, 1.1, -1, 0, 32769, '300'])
    assert.throws(() => normalizeViewPresentation({ bounds: { ...bounds, width: value } }))
  for (const value of [NaN, Infinity, 1.1, -32769, 32769, '20'])
    assert.throws(() => normalizeViewPresentation({ bounds: { ...bounds, x: value } }))
  assert.throws(() => normalizeViewPresentation({ bounds, clip: { ...bounds, extra: 1 } }))
})

test('manual views send normalized placement; readback preserves actual native geometry', async () => {
  const f = await fixture()
  try {
    assert.equal(f.commands[1]?.args['viewLayout'], 'manual')
    assert.deepEqual(f.commands[2]?.args['presentation'], presentation)
    assert.equal(f.commands[2]?.args['layer'], 'content')
    const state = await f.backend.viewPresentation(f.view)
    assert.deepEqual(state, observed)
    assert.notEqual(state.viewport.width, state.presentation.bounds.width)
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.viewport))
    const update = {
      bounds: { ...bounds, width: 250 },
      visible: false,
      focusable: false,
      tabIndex: 4,
    }
    await f.backend.setViewPresentation(f.view, update)
    assert.equal(f.commands.at(-1)?.op, 'view.present')
    assert.deepEqual(f.commands.at(-1)?.args['presentation'], { ...update, clip: null })
  } finally {
    await f.stop()
  }
})

test('legacy windows preserve existing creation payloads and reject opt-in presentation', async () => {
  const f = await fixture(false)
  try {
    assert.equal(f.commands[1]?.args['viewLayout'], undefined)
    assert.equal(f.commands[2]?.args['presentation'], undefined)
    const count = f.commands.length
    await assert.rejects(
      f.backend.createView({ ...f.options, presentation: { bounds } }),
      /manual-layout/
    )
    await assert.rejects(f.backend.setViewPresentation(f.view, { bounds }), /view.composition/)
    await assert.rejects(f.backend.viewPresentation(f.view), /view.composition/)
    assert.equal(f.commands.length, count)
  } finally {
    await f.stop()
  }
})

test('overlays require application trust and invalid presentation never reaches native dispatch', async () => {
  const f = await fixture()
  try {
    const count = f.commands.length
    await assert.rejects(
      f.backend.createView({
        ...f.options,
        presentation: { bounds },
        layer: 'overlay',
        trust: { kind: 'remote' },
      }),
      /application-owned/
    )
    await assert.rejects(
      f.backend.createView({
        ...f.options,
        url: 'app://other/index.html',
        presentation: { bounds },
        layer: 'overlay',
        trust: { kind: 'application', origin: 'app://other' },
      }),
      /application-owned/
    )
    await assert.rejects(f.backend.createView({ ...f.options }), /presentation/)
    await assert.rejects(
      f.backend.setViewPresentation(f.view, { bounds: { ...bounds, width: 1.5 } }),
      /integer/
    )
    assert.equal(f.commands.length, count)
  } finally {
    await f.stop()
  }
})

test('overlay navigation rejects an external origin without retiring its application document', async () => {
  const f = await fixture()
  try {
    const overlay = await f.backend.createView({
      ...f.options,
      presentation: { bounds },
      layer: 'overlay',
    })
    const state = f.backend.state(overlay)
    const count = f.commands.length
    for (const url of ['https://example.invalid/', 'app://other/index.html', 'about:blank'])
      await assert.rejects(f.backend.navigate(overlay, url), /application-owned/)
    assert.equal(f.commands.length, count)
    assert.deepEqual(f.backend.state(overlay), state)
  } finally {
    await f.stop()
  }
})

test('readback rejects malformed native state rather than synthesizing success', async () => {
  for (const input of [
    null,
    [],
    {},
    { ...observed, extra: true },
    { ...observed, drawn: 1 },
    { ...observed, layer: 'dom' },
    { ...observed, viewport: { ...bounds, width: -1 } },
    { ...observed, presentation: { bounds } },
  ])
    assert.throws(() => parseViewPresentationState(input), /Malformed/)
  const f = await fixture()
  try {
    f.handle((command) => f.reply(command, null))
    await assert.rejects(f.backend.viewPresentation(f.view), /Malformed/)
    f.handle((command) => f.reject(command, 'Native placement failed'))
    await assert.rejects(
      f.backend.setViewPresentation(f.view, { bounds }),
      /Native placement failed/
    )
  } finally {
    await f.stop()
  }
})

test('foreign, forged, wrong-kind and closing resources reject before layout dispatch', async () => {
  const f = await fixture(),
    other = await fixture()
  try {
    const count = f.commands.length
    for (const handle of [{ ...f.view }, other.view, f.window, null]) {
      await assert.rejects(f.backend.viewPresentation(handle as ViewHandle))
      await assert.rejects(f.backend.setViewPresentation(handle as ViewHandle, { bounds }))
      await assert.rejects(f.backend.focusView(handle as ViewHandle))
    }
    for (const handle of [{ ...f.window }, other.window, f.view, null])
      await assert.rejects(f.backend.focusNextView(handle as WindowHandle))
    assert.equal(f.commands.length, count)
    f.handle(() => {})
    const closing = f.backend.closeWindow(f.window)
    await assert.rejects(f.backend.viewPresentation(f.view), /closing/)
    await assert.rejects(f.backend.focusNextView(f.window), /closing/)
    f.reply(f.commands.at(-1)!)
    await closing
    await assert.rejects(f.backend.viewPresentation(f.view), /disposed/)
  } finally {
    await f.stop()
    await other.stop()
  }
})

test('late geometry and focus receipts cannot resurrect a closed view', async () => {
  for (const operation of ['read', 'present', 'focus'] as const) {
    const f = await fixture()
    try {
      f.handle(() => {})
      const pending =
        operation === 'read'
          ? f.backend.viewPresentation(f.view)
          : operation === 'present'
            ? f.backend.setViewPresentation(f.view, { bounds })
            : f.backend.focusView(f.view)
      const rejection = assert.rejects(pending, /disposed/)
      f.send({ v: 1, event: 'view.closed', target: 3, data: null })
      f.reply(f.commands.at(-1)!, observed)
      await rejection
    } finally {
      await f.stop()
    }
  }
})

test('focus cycling resolves only a live native target in the same owned window', async () => {
  const f = await fixture()
  try {
    const secondWindow = await f.backend.createWindow({ title: 'Other', bounds })
    await f.backend.createView({ ...f.options, window: secondWindow })
    f.handle((command) => f.reply(command, { id: 3 }))
    assert.equal(await f.backend.focusNextView(f.window, true), f.view)
    assert.deepEqual(f.commands.at(-1)?.args, { id: 2, reverse: true })
    for (const id of [1, 4, 5, 999]) {
      f.handle((command) => f.reply(command, { id }))
      await assert.rejects(f.backend.focusNextView(f.window), /target|owner/)
    }
    f.handle((command) => f.reply(command, null))
    assert.equal(await f.backend.focusNextView(f.window), null)
    const count = f.commands.length
    await assert.rejects(
      f.backend.focusNextView(f.window, 'forward' as unknown as boolean),
      /direction/
    )
    assert.equal(f.commands.length, count)
  } finally {
    await f.stop()
  }
})

test('cancellation retains layout admission until native acknowledgment', async () => {
  const f = await fixture()
  try {
    f.handle(() => {})
    const aborted = new AbortController()
    aborted.abort()
    const count = f.commands.length
    await assert.rejects(
      f.backend.setViewPresentation(f.view, { bounds }, { signal: aborted.signal }),
      /abort/i
    )
    assert.equal(f.commands.length, count)
    const controller = new AbortController()
    const pending = f.backend.setViewPresentation(f.view, { bounds }, { signal: controller.signal })
    const rejection = assert.rejects(pending, /abort/i)
    controller.abort()
    await rejection
    assert.equal(f.transport.diagnostics().abandoned, 1)
    f.reply(f.commands.at(-1)!, observed)
    await turn()
    assert.equal(f.transport.diagnostics().abandoned, 0)
  } finally {
    await f.stop()
  }
})

test('mock never advertises or silently simulates native composition', async () => {
  const backend = new MockBackend()
  try {
    assert.ok(!backend.descriptor.capabilities.includes('view.composition'))
    await assert.rejects(
      backend.createWindow({ title: 'Mock', bounds, viewLayout: 'manual' }),
      /view.composition/
    )
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'mock' })
    const window = await backend.createWindow({ title: 'Mock', bounds })
    await assert.rejects(
      backend.createView({
        window,
        session,
        url: 'about:blank',
        trust: { kind: 'remote' },
        presentation: {} as ViewPresentationOptions,
      }),
      /view.composition/
    )
  } finally {
    await backend.dispose()
  }
})

test('managed composition retains placement across generations and revalidates native authority', async () => {
  const f = await fixture()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, f.backend)
  const scope = {
    view: 3,
    session: 1,
    generation: 1,
    mainFrame: 'main-frame',
    document: 'native-3-1',
    origin: 'app://ui',
  }
  f.handle((command) => f.reply(command, command.op === 'policy.scope' ? scope : observed))
  try {
    const authority = await desktop.captureAuthority(f.view)
    const resource = desktop.registerView('pane', f.view, {
      authority,
      permission: 'composition',
      operations: ['presentation', 'present'],
    })
    const commit = async () => {
      const generation = owner.begin('composition:1', ['composition'])
      for (const binding of Object.values(await desktop.prepare()))
        owner.attach(generation, binding.resource, binding.schema)
      owner.commit(generation, 'null')
      return generation
    }
    const first = await commit()
    assert.deepEqual(
      JSON.parse(await owner.invoke(first, resource, 'presentation', 'null')),
      observed
    )
    await owner.invoke(first, resource, 'present', JSON.stringify({ presentation: { bounds } }))
    assert.deepEqual(f.commands.at(-1)?.args['presentation'], presentation)
    const second = await commit()
    await assert.rejects(owner.invoke(first, resource, 'presentation', 'null'), /RETIRED/)
    assert.deepEqual(
      JSON.parse(await owner.invoke(second, resource, 'presentation', 'null')),
      observed
    )
    await assert.rejects(owner.invoke(second, resource, 'focus', 'null'), /DENIED/)
    await assert.rejects(
      owner.invoke(
        second,
        resource,
        'present',
        JSON.stringify({ presentation: { bounds }, extra: true })
      ),
      /INVALID_ARGUMENT/
    )
    const presentations = f.commands.filter((command) => command.op === 'view.present').length
    scope.mainFrame = 'stale-native-frame'
    await assert.rejects(
      owner.invoke(second, resource, 'present', JSON.stringify({ presentation: { bounds } })),
      /DENIED/
    )
    assert.equal(
      f.commands.filter((command) => command.op === 'view.present').length,
      presentations
    )
    assert.equal(f.commands.filter((command) => command.op === 'view.create').length, 1)
  } finally {
    await desktop.dispose()
    owner.dispose()
    await f.stop()
  }
})

test('composition renderer receipts validate bounded independent observations', () => {
  const page = {
    pane: 'left',
    sequence: 0,
    instance: '12345678-1234-1234-1234-123456789abc',
    width: 280,
    height: 220,
    visibility: 'visible',
    focused: false,
    form: 'retained',
    session: 'retained',
    devicePixelRatio: 2,
  }
  assert.deepEqual(parseCompositionPage(page), page)
  assert.ok(Object.isFrozen(parseCompositionPage(page)))
  for (const value of [
    null,
    [],
    { ...page, extra: 1 },
    { ...page, pane: 'unknown' },
    { ...page, sequence: 128 },
    { ...page, width: -1 },
    { ...page, height: 1.5 },
    { ...page, focused: 'true' },
    { ...page, instance: 'invalid' },
    { ...page, devicePixelRatio: Infinity },
    { ...page, form: 'x'.repeat(65) },
  ])
    assert.throws(() => parseCompositionPage(value), /Invalid/)
})
