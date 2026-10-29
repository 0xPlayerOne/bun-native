import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import type { RpcContext } from '../packages/runtime/src/rpc.ts'
import { rpcLimits, type RpcEnvelope } from '../packages/contracts/src/rpc.ts'
import { encodeRpc, decodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import {
  normalizeViewPresentation,
  type ViewHandle,
  type ViewPresentationState,
} from '../packages/contracts/src/index.ts'
import {
  parseWorkbenchCommand,
  parseWorkbenchSnapshot,
  workbenchSchema,
} from '../examples/hardware-workbench/contract.ts'
import {
  WorkbenchAuthority,
  HardwareWorkbench,
  numericLoopbackOrigin,
} from '../examples/hardware-workbench/controller.ts'
import { equipmentRecordTemplate, hardwareCases } from '../examples/hardware-workbench/cases.ts'
import { previewResponse } from '../examples/hardware-workbench/server.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const present = {
  action: 'present',
  pane: 'left',
  visible: true,
  focusable: true,
  clip: 'partial',
  width: 400,
  height: 500,
} as const

test('workbench commands reject arbitrary authority, operation names and unbounded geometry', () => {
  for (const command of [
    present,
    { action: 'focus', pane: 'right' },
    { action: 'traverse', reverse: true },
    { action: 'overlay', state: 'closed' },
    { action: 'window', operation: 'hide-briefly' },
    { action: 'resize-window', size: 'compact' },
    { action: 'quit' },
    { action: 'native-menu' },
    { action: 'open-dialog' },
  ])
    assert.deepEqual(parseWorkbenchCommand(command), command)
  for (const value of [
    null,
    [],
    {},
    'quit',
    { action: 'quit', viewId: 'copied' },
    { action: 'clipboard.read' },
    { action: 'open-dialog', directory: '/tmp' },
    { action: 'native-menu', id: 'forged' },
    { action: 'focus', pane: 'controls' },
    { action: 'focus', pane: 'left', url: 'https://example.invalid' },
    { action: 'window', operation: 'open-external' },
    { action: 'window', operation: 'quit', arguments: [] },
    { action: 'overlay', state: 'yes' },
    { action: 'traverse', reverse: 1 },
    { ...present, visible: 1 },
    { ...present, focusable: 'true' },
    { ...present, clip: 'crop' },
    ...[0, 239, 721, 400.5, NaN, Infinity, '400'].map((width) => ({ ...present, width })),
    ...[0, 179, 681, 200.1, NaN, Infinity, '500'].map((height) => ({ ...present, height })),
  ])
    assert.throws(() => parseWorkbenchCommand(value))
  const input = { ...present }
  const parsed = parseWorkbenchCommand(input)
  assert.ok(Object.isFrozen(parsed))
})

test('only canonical numeric-loopback fixture origins and fixed read-only routes are admitted', async () => {
  assert.equal(numericLoopbackOrigin('http://127.0.0.1:41234'), 'http://127.0.0.1:41234')
  for (const value of [
    'https://example.com',
    'http://localhost:8000',
    'http://127.1:8000',
    'http://127.0.0.1:08000',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:80',
    'http://127.0.0.1:8000/',
    'http://127.0.0.1:8000?x',
    'http://user@127.0.0.1:8000',
  ])
    assert.throws(() => numericLoopbackOrigin(value))
  const origin = 'http://127.0.0.1:41234'
  const assets = new Map([
    [
      '/left.html',
      { body: new TextEncoder().encode('controlled'), type: 'text/html; charset=utf-8' },
    ],
  ])
  const request = (path: string, method = 'GET', host = '127.0.0.1:41234') =>
    new Request(origin + path, { method, headers: { host } })
  const response = previewResponse(request('/left.html'), origin, assets)
  assert.equal(await response.text(), 'controlled')
  assert.match(response.headers.get('content-security-policy')!, /connect-src 'none'/)
  assert.equal(await previewResponse(request('/left.html', 'HEAD'), origin, assets).text(), '')
  for (const candidate of [
    request('/left.html', 'POST'),
    request('/left.html', 'GET', 'attacker.invalid'),
    request('/left.html?command=quit'),
    new Request('http://example.invalid/left.html', { headers: { host: '127.0.0.1:41234' } }),
  ])
    assert.equal(previewResponse(candidate, origin, assets).status, 403)
  for (const path of ['/command', '/runtime.json', '/../../etc/passwd', '/right.html'])
    assert.equal(previewResponse(request(path), origin, assets).status, 404)
})

test('application routing binds opaque owners and current document/frame/generation, with narrower overlay rights', async () => {
  const backend = new MockBackend()
  try {
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'hardware' })
    const window = await backend.createWindow({
      title: 'Protocol fixture',
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const overlay = await backend.createView({
      window,
      session,
      url: 'app://ui/overlay.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const authority = new WorkbenchAuthority(backend)
    authority.bind('controls', view)
    authority.bind('overlay', overlay)
    const context = (handle: ViewHandle): RpcContext => ({
      signal: new AbortController().signal,
      identity: {
        viewId: handle.id,
        origin: 'app://ui',
        documentId: backend.state(handle).documentId,
        frameId: 'native-main',
        generation: 1,
      },
    })
    const control = context(view),
      other = context(overlay)
    authority.check(control, { action: 'quit' })
    authority.check(other, { action: 'dismiss-overlay' })
    assert.throws(() => authority.check(other, { action: 'quit' }), /denied/)
    assert.throws(() => authority.check(control, { action: 'dismiss-overlay' }), /current owner/)
    assert.throws(() => authority.bind('controls', { ...view } as ViewHandle))
    for (const identity of [
      { ...control.identity, viewId: 'foreign' },
      { ...control.identity, frameId: 'other-frame' },
      { ...control.identity, documentId: 'retired' },
      { ...control.identity, generation: 2 },
      { ...control.identity, origin: 'http://127.0.0.1:8000' },
    ])
      assert.throws(() => authority.check({ ...control, identity }, { action: 'quit' }))
    assert.throws(() => authority.check({ ...control, signal: AbortSignal.abort() }), /cancelled/)
    await backend.navigate(view, 'app://ui/elsewhere.html')
    assert.throws(() => authority.check(control), /revoked/)
    authority.retire('overlay')
    assert.throws(() => authority.check(other), /unavailable/)
  } finally {
    await backend.dispose()
  }
})

async function fixture() {
  const peer = await nativePeer()
  const native = new Map<number, ViewPresentationState>()
  const created: { id: number; command: Command }[] = []
  let next = 0
  let intercept: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (intercept?.(command)) return
    if (command.op.endsWith('.create')) {
      const id = ++next
      created.push({ id, command })
      if (command.op === 'view.create') {
        const presentation = normalizeViewPresentation(command.args['presentation'])
        native.set(id, {
          presentation,
          layer: command.args['layer'] as 'content' | 'overlay',
          viewport: presentation.bounds,
          visible: presentation.visible,
          drawn: presentation.visible,
          focusable: presentation.focusable,
          focused: false,
        })
      }
      peer.reply(command, { id })
    } else if (command.op === 'view.present') {
      const id = Number(command.args['id']),
        previous = native.get(id)!
      const presentation = normalizeViewPresentation(command.args['presentation'])
      native.set(id, {
        ...previous,
        presentation,
        visible: presentation.visible,
        drawn: presentation.visible,
        focusable: presentation.focusable,
      })
      peer.reply(command, native.get(id))
    } else if (command.op === 'view.presentation')
      peer.reply(command, native.get(Number(command.args['id'])))
    else if (command.op === 'window.state')
      peer.reply(command, {
        visible: true,
        active: true,
        minimized: false,
        maximized: false,
        fullscreen: false,
      })
    else if (command.op === 'window.bounds')
      peer.reply(command, { x: 40, y: 40, width: 1240, height: 860 })
    else peer.reply(command)
  })
  const backend = new CefBackend(peer.transport)
  const app = new HardwareWorkbench(backend, 'http://127.0.0.1:41234')
  const stopRpc = backend.serveRpc(
    workbenchSchema,
    {
      snapshot: {
        capability: 'hardware-workbench',
        handle: (_value, context) => app.snapshot(context),
      },
      command: {
        capability: 'hardware-workbench',
        handle: (value, context) => app.command(value, context),
      },
    },
    ['app://ui'],
    ['hardware-workbench']
  )
  await app.start()
  const channel = async (url: string, origin = 'app://ui') => {
    const target = created.find((row) => row.command.args['url'] === url)!.id
    const connection = 100 + target
    peer.send({
      v: 1,
      event: 'rpc.connected',
      target,
      data: {
        connection,
        context: 1,
        frameId: 'native-main',
        documentId: `native-${target}-1`,
        generation: 1,
        origin,
      },
    })
    await turn()
    let sequence = 0
    const limits = rpcLimits({ maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 })
    return {
      target,
      connection,
      cancel() {
        const packet = encodeRpc({ type: 'cancel', id: sequence }, limits)
        peer.send({
          v: 1,
          event: 'rpc.packet',
          target,
          data: {
            connection,
            context: 1,
            generation: 1,
            sequence: ++sequence,
            packet: Buffer.from(packet).toString('hex'),
            copiedBytes: packet.byteLength,
          },
        })
      },
      async call(method: string, value: unknown): Promise<RpcEnvelope | undefined> {
        const id = ++sequence
        const packet = encodeRpc({ type: 'request', id, method, value, timeoutMs: 1000 }, limits)
        const offset = peer.commands.length
        peer.send({
          v: 1,
          event: 'rpc.packet',
          target,
          data: {
            connection,
            context: 1,
            generation: 1,
            sequence,
            packet: Buffer.from(packet).toString('hex'),
            copiedBytes: packet.byteLength,
          },
        })
        for (let tries = 0; tries < 12; tries++) {
          await turn()
          const reply = peer.commands
            .slice(offset)
            .find(
              (command) => command.op === 'rpc.deliver' && command.args['connection'] === connection
            )
          if (reply) return decodeRpc(Uint8Array.fromHex(String(reply.args['packet'])), limits)
        }
        return undefined
      },
    }
  }
  return {
    ...peer,
    backend,
    app,
    created,
    native,
    channel,
    intercept: (callback: (command: Command) => boolean) => {
      intercept = callback
    },
    cleanup: async () => {
      app.stop()
      stopRpc()
      await peer.stop()
    },
  }
}

test('native-mediated workbench RPC routes only allowlisted controls and keeps preview sessions separate', async () => {
  const f = await fixture()
  try {
    const views = f.created.filter((row) => row.command.op === 'view.create')
    assert.equal(views.length, 4)
    assert.equal(new Set(views.map((row) => row.command.args['session'])).size, 4)
    const previews = views.filter((row) => String(row.command.args['url']).startsWith('http:'))
    assert.equal(previews.length, 2)
    assert.ok(previews.every((row) => row.command.args['origin'] === undefined))
    const controls = await f.channel('app://ui/index.html')
    const overlay = await f.channel('app://ui/overlay.html')
    const before = f.commands.filter((row) => row.op === 'view.present').length
    assert.deepEqual(await controls.call('command', present), {
      type: 'success',
      id: 1,
      value: null,
    })
    assert.equal(f.commands.filter((row) => row.op === 'view.present').length, before + 1)
    assert.equal(
      [...f.commands].reverse().find((row) => row.op === 'view.present')!.args['id'],
      previews[0]!.id
    )
    const response = await controls.call('snapshot', null)
    assert.equal(response?.type, 'success')
    if (response?.type === 'success')
      assert.equal(parseWorkbenchSnapshot(response.value).panes.length, 2)
    assert.equal(
      (await controls.call('command', { action: 'quit', url: 'https://example.invalid' }))?.type,
      'error'
    )
    assert.equal((await overlay.call('command', { action: 'quit' }))?.type, 'error')
    assert.equal(
      f.commands.some((row) => row.op === 'window.close'),
      false
    )
    await f.channel('http://127.0.0.1:41234/left.html', 'http://127.0.0.1:41234')
    assert.match(String(f.transport.failure), /Invalid native RPC connection/)
    assert.equal(
      f.commands.some((row) => /clipboard|dialog|external|status\.create/.test(row.op)),
      false
    )
  } finally {
    await f.cleanup()
  }
})

test('navigation during a pending command revokes the reply and prevents subsequent native readback', async () => {
  const f = await fixture()
  try {
    const controls = await f.channel('app://ui/index.html')
    let held: Command | undefined
    f.intercept((command) => {
      if (command.op === 'view.present') {
        held = command
        return true
      }
      return false
    })
    const pending = controls.call('command', present)
    await turn()
    assert.ok(held)
    f.send({
      v: 1,
      event: 'view.navigating',
      target: controls.target,
      data: { url: 'app://ui/other.html', documentId: 'retired-document' },
    })
    const reads = f.commands.filter((row) => row.op === 'window.state').length
    f.reply(held, f.native.get(Number(held.args['id'])))
    await pending
    assert.equal(f.commands.filter((row) => row.op === 'window.state').length, reads)
    assert.ok(
      f.commands.some(
        (row) => row.op === 'rpc.disconnect' && row.args['connection'] === controls.connection
      )
    )
  } finally {
    await f.cleanup()
  }
})

test('closing and reopening a preview keeps bounded owners and rebuilds content before the overlay', async () => {
  const f = await fixture()
  try {
    const controls = await f.channel('app://ui/index.html')
    assert.equal(
      (await controls.call('command', { action: 'close-pane', pane: 'left' }))?.type,
      'success'
    )
    assert.equal(f.backend.diagnostics().views, 3)
    assert.equal(f.backend.diagnostics().sessions, 3)
    const snapshot = await controls.call('snapshot', null)
    if (snapshot?.type !== 'success') throw new Error('Missing snapshot')
    assert.equal(parseWorkbenchSnapshot(snapshot.value).panes[0]!.native, null)
    const offset = f.commands.length
    assert.equal(
      (await controls.call('command', { action: 'reopen-pane', pane: 'left' }))?.type,
      'success'
    )
    const creations = f.commands.slice(offset).filter((command) => command.op === 'view.create')
    assert.deepEqual(
      creations.map((command) => command.args['layer']),
      ['content', 'overlay']
    )
    assert.equal(f.backend.diagnostics().views, 4)
    assert.equal(f.backend.diagnostics().sessions, 4)
    const restored = await controls.call('snapshot', null)
    if (restored?.type !== 'success') throw new Error('Missing restored snapshot')
    assert.equal(parseWorkbenchSnapshot(restored.value).panes[0]!.incarnation, 2)
  } finally {
    await f.cleanup()
  }
})

test('retired or cancelled commands cannot create a view after their nested session receipt arrives', async () => {
  for (const role of ['left', 'overlay'] as const)
    for (const revoke of ['navigation', 'cancellation'] as const) {
      const f = await fixture()
      try {
        const controls = await f.channel('app://ui/index.html')
        const close =
          role === 'left'
            ? { action: 'close-pane', pane: 'left' }
            : { action: 'overlay', state: 'closed' }
        assert.equal((await controls.call('command', close))?.type, 'success')
        let held: Command | undefined
        f.intercept((command) => {
          if (command.op === 'session.create' && command.args['partition'] === `hardware-${role}`) {
            held = command
            return true
          }
          return false
        })
        const reopen =
          role === 'left'
            ? { action: 'reopen-pane', pane: 'left' }
            : { action: 'overlay', state: 'open' }
        const pending = controls.call('command', reopen)
        for (let tries = 0; !held && tries < 12; tries++) await turn()
        assert.ok(held)
        const before = f.commands.filter((command) => command.op === 'view.create').length
        if (revoke === 'navigation')
          f.send({
            v: 1,
            event: 'view.navigating',
            target: controls.target,
            data: { url: 'app://ui/retired.html', documentId: 'retired-document' },
          })
        else controls.cancel()
        await turn()
        f.reply(held, { id: 1000 })
        await pending
        await turn()
        assert.equal(
          f.commands.filter((command) => command.op === 'view.create').length,
          before,
          `${role}/${revoke} must not create after revocation`
        )
        assert.ok(
          f.commands.some(
            (command) => command.op === 'session.dispose' && command.args['id'] === 1000
          ),
          `${role}/${revoke} must release the admitted session`
        )
        assert.equal(f.backend.diagnostics().sessions, role === 'left' ? 2 : 3)
      } finally {
        await f.cleanup()
      }
    }
})

test('operator templates retain all twelve cases without automatically passing available or missing hardware', () => {
  const template = equipmentRecordTemplate()
  assert.deepEqual(
    hardwareCases.map((item) => item.id),
    ['K1', 'K2', 'I1', 'T1', 'D1', 'A1', 'L1', 'L2', 'F1', 'E1', 'M1', 'C1']
  )
  assert.equal(template.hardwareQualified, false)
  for (const item of template.cases) {
    assert.ok(['not run', 'unsupported'].includes(item.status))
    assert.ok(item.reason)
    assert.deepEqual(item.attempts, [])
  }
  assert.match(
    template.cases.find((item) => item.id === 'T1')!.coverage,
    /selection alone cannot pass/
  )
})

test('native UI controls use captured scope, dispose menu, and never expose a selected path', async () => {
  const f = await fixture()
  const scope = Object.freeze({})
  const handle = Object.freeze({})
  const calls: string[] = []
  let listener: ((event: { type: string }) => void) | undefined
  Object.assign(f.backend, {
    capturePolicyScope: async () => {
      calls.push('capture')
      return scope
    },
    grantNativeCapability: async (actual: unknown, grant: { name: string }) => {
      assert.equal(actual, scope)
      calls.push(grant.name)
    },
    createWindowCommands: async (actual: unknown) => {
      assert.equal(actual, scope)
      calls.push('create')
      return handle
    },
    onWindowCommandsEvent: (_handle: unknown, callback: typeof listener) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    showWindowMenu: async (actual: unknown) => {
      assert.equal(actual, handle)
      queueMicrotask(() => listener?.({ type: 'menu-closed' }))
    },
    disposeWindowCommands: async (actual: unknown) => {
      assert.equal(actual, handle)
      calls.push('dispose')
    },
    showOpenFileDialog: async (actual: unknown) => {
      assert.equal(actual, scope)
      return { status: 'selected', path: '/private/fixture' }
    },
  })
  try {
    const controls = await f.channel('app://ui/index.html')
    const overlay = await f.channel('app://ui/overlay.html')
    assert.equal((await overlay.call('command', { action: 'native-menu' }))?.type, 'error')
    assert.equal((await controls.call('command', { action: 'native-menu' }))?.type, 'success')
    assert.deepEqual(calls, ['capture', 'window-commands', 'create', 'dispose'])
    assert.equal((await controls.call('command', { action: 'open-dialog' }))?.type, 'success')
    assert.deepEqual(calls.slice(-2), ['capture', 'dialog-open'])
    const snapshot = await controls.call('snapshot', null)
    assert.equal(JSON.stringify(snapshot).includes('/private/fixture'), false)
    assert.match(JSON.stringify(snapshot), /Native file dialog selected/)
  } finally {
    await f.cleanup()
  }
})
