import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import type { PolicyScope } from '../packages/contracts/src/index.ts'
import { nativePeer } from './helpers/native-peer.ts'

const request = () => ({
  kind: 'file-input' as const,
  elementId: 'upload',
  file: { name: 'fixture.bin', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
})
async function fixture(enabled = true) {
  const peer = await nativePeer({
    desktopCapabilities: {
      version: 1,
      capabilities: enabled ? ['view.file-input', 'view.file-drop', 'view.observe-dom'] : [],
    },
  })
  let next = 0
  peer.handle((command) => {
    if (command.op.endsWith('.create')) peer.reply(command, { id: ++next })
    else if (command.op === 'policy.scope')
      peer.reply(command, {
        view: 3,
        session: 1,
        generation: 1,
        mainFrame: 'main',
        document: 'native-3-1',
        origin: 'app://ui',
      })
    else if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      peer.send({ v: 1, event: 'file.interaction.ready', target: 3, data: { id: 10 } })
    } else if (command.op === 'file.interaction.cancel') {
      peer.reply(command)
      peer.send({
        v: 1,
        event: 'file.interaction.finished',
        target: 3,
        data: {
          id: 10,
          result: {
            status: 'cancelled',
            failure: null,
            synthetic: true,
            mayHaveExposedFile: false,
          },
        },
      })
    } else peer.reply(command)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'fixture' })
  const window = await backend.createWindow({
    title: 'fixture',
    bounds: { x: 0, y: 0, width: 640, height: 400 },
  })
  const view = await backend.createView({
    session,
    window,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const scope = await backend.capturePolicyScope(view)
  return { peer, backend, view, scope }
}
test('file facet requires opaque scope and advertised feature before payload inspection', async () => {
  const f = await fixture(false)
  try {
    const before = f.peer.commands.length
    assert.throws(
      () => f.backend.prepareFileInteraction({ ...f.scope } as PolicyScope, request()),
      /foreign/
    )
    assert.throws(() => f.backend.prepareFileInteraction(f.scope, request()), /does not implement/)
    assert.equal(f.peer.commands.length, before)
    assert.deepEqual(f.backend.viewControlDiagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await f.backend.dispose()
  }
})
test('file grant wire shape is exact and does not accept selectors or path aliases', async () => {
  const f = await fixture()
  try {
    for (const elementId of ['#upload', 'upload\n', '../path', 'input[type=file]'])
      await assert.rejects(
        f.backend.grantNativeCapability(f.scope, { name: 'file-input', elementId }),
        /exact element/
      )
    await f.backend.grantNativeCapability(f.scope, { name: 'file-drop', elementId: 'drop' })
    assert.deepEqual(f.peer.commands.at(-1)?.args['capability'], {
      name: 'file-drop',
      elementId: 'drop',
    })
  } finally {
    await f.backend.dispose()
  }
})
test('file and browser facets share admission before either asynchronous scope capture or commit', async () => {
  const f = await fixture()
  try {
    const operation = await f.backend.prepareFileInteraction(f.scope, request())
    assert.equal(f.backend.viewControlDiagnostics().operations, 1)
    const before = f.peer.commands.length
    await assert.rejects(f.backend.observeDom(f.view), /capacity/)
    assert.equal(f.peer.commands.length, before)
    assert.equal((await operation.cancel()).status, 'cancelled')
    assert.deepEqual(f.backend.viewControlDiagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await f.backend.dispose()
  }
})
