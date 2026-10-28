import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { downloadFixtureServer } from '../examples/file-downloads/server.ts'
import { remoteDocumentReadiness } from '../examples/file-downloads/readiness.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'
import { downloadFixturePayloads } from '../examples/file-downloads/contract.ts'
import { downloadFixtureFailure } from '../examples/file-downloads/failure.ts'

test('owned download fixture serves exact bytes, bounded reload, and cancellable streams', async () => {
  const server = await downloadFixtureServer({ html: '<p>owned page</p>', client: 'export {}' })
  try {
    for (const name of ['small', 'large'] as const) {
      assert.equal(server[name].byteLength, downloadFixturePayloads[name].bytes)
      assert.equal(
        createHash('sha256').update(server[name]).digest('hex'),
        downloadFixturePayloads[name].sha256
      )
    }
    const small = await fetch(server.origin + '/small.bin')
    assert.equal(
      small.headers.get('content-disposition'),
      'attachment; filename="../../outside-fixture.txt"'
    )
    assert.deepEqual(Buffer.from(await small.arrayBuffer()), server.small)
    const redirected = await fetch(server.origin + '/redirect.bin')
    assert.deepEqual(Buffer.from(await redirected.arrayBuffer()), server.small)
    const blocked = await fetch(server.origin + '/redirect-denied.bin', { redirect: 'manual' })
    assert.equal(blocked.status, 302)
    assert.equal(blocked.headers.get('location'), server.blockedOrigin + '/forbidden.bin')
    assert.equal(server.observations().blockedRequests, 0)
    const reload = fetch(server.origin + '/reload-command')
    await server.reloadRequested
    server.releaseReload()
    assert.equal(await (await reload).text(), 'reload')
    assert.equal(await (await fetch(server.origin + '/reload-command')).text(), 'done')
    const slow = await fetch(server.origin + '/slow.bin')
    const reader = slow.body!.getReader()
    assert.ok((await reader.read()).value!.byteLength > 0)
    await reader.cancel()
  } finally {
    await server.close()
  }
  assert.equal(server.observations().activeStreams, 0)
  assert.equal(server.observations().cancelledStreams, 1)
})

test('owned interruption endpoint closes before its declared content length', async () => {
  const server = await downloadFixtureServer({ html: '', client: '' })
  try {
    const signal = AbortSignal.timeout(1000)
    const response = await fetch(server.origin + '/broken.bin', { signal })
    assert.equal(response.headers.get('content-length'), String(1024 * 1024))
    await assert.rejects(response.arrayBuffer())
    assert.equal(
      signal.aborted,
      false,
      'The server must interrupt without waiting for the test deadline'
    )
    assert.equal(server.count('/broken.bin'), 1)
    assert.equal(server.observations().blockedRequests, 0)
  } finally {
    await server.close()
  }
  assert.equal(server.observations().activeStreams, 0)
})

test('download failure receipts classify exact protocol errors without exporting arbitrary text', () => {
  assert.equal(
    downloadFixtureFailure(
      'network-interruption',
      new Error('Invalid native download state transition')
    ),
    'network-interruption: Error [native-transition]'
  )
  assert.equal(
    downloadFixtureFailure('cancel', new Error('Transfer settled before positive native progress')),
    'cancel: Error [no-positive-progress]'
  )
  for (const [message, category] of [
    ['Download directory is writable by another user', 'windows-root-shared-writer'],
    ['Download directory must belong to the current user', 'windows-root-owner'],
    ['Access is denied. (os error 5)', 'windows-access-denied'],
  ]) {
    assert.equal(
      downloadFixtureFailure('complete', new Error(message)),
      `complete: Error [${category}]`
    )
    assert.equal(
      downloadFixtureFailure('complete', new Error(message + ' C:\\private\\fixture')),
      'complete: Error [unclassified]'
    )
  }
  assert.equal(
    downloadFixtureFailure('native-shutdown', {
      name: 'AssertionError',
      code: 'ERR_ASSERTION',
      message: '/private/fixture-path',
    }),
    'native-shutdown: AssertionError (ERR_ASSERTION) [unclassified]'
  )
  for (const message of [
    '/private/fixture-path',
    'https://private.invalid/path?secret=fixture',
    'Invalid native download state transition /private/fixture-path',
    'secret Invalid native download state transition',
    'x'.repeat(1_000_000),
  ]) {
    const receipt = downloadFixtureFailure('/private/phase', {
      name: 'PrivateFixtureName',
      code: 'PRIVATE_FIXTURE_CODE',
      message,
      stack: 'private stack',
      cause: { message: 'private cause' },
    })
    assert.equal(receipt, 'unknown-phase: Error [unclassified]')
  }
})

test('remote fixture readiness requires exact native load completion and a new reload document', async () => {
  const peer = await nativePeer()
  let id = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++id } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const url = 'https://download.test/document'
  const initial = remoteDocumentReadiness(backend, url)
  let reload: ReturnType<typeof remoteDocumentReadiness> | undefined
  try {
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'download-ready',
    })
    const window = await backend.createWindow({
      title: 'fixture',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
    const view = await backend.createView({ window, session, url, trust: { kind: 'remote' } })
    let done = false
    const first = initial.wait(view).then((document) => {
      done = true
      return document
    })
    peer.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url, status: 200, documentId: 'other-document' },
    })
    await turn()
    assert.equal(done, false)
    peer.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url, status: 200, documentId: 'native-3-1' },
    })
    assert.equal(await first, 'native-3-1')
    assert.equal(backend.diagnostics().listeners, 0)
    reload = remoteDocumentReadiness(backend, url, 'native-3-1')
    done = false
    const next = reload.wait(view).then((document) => {
      done = true
      return document
    })
    peer.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url, status: 200, documentId: 'native-3-1' },
    })
    await turn()
    assert.equal(done, false)
    peer.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url, documentId: 'native-3-2', applicationTrust: false },
    })
    peer.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url, status: 200, documentId: 'native-3-2' },
    })
    assert.equal(await next, 'native-3-2')
    assert.equal(backend.diagnostics().listeners, 0)
    assert.equal(
      peer.commands.some((command) => command.op === 'policy.scope'),
      false
    )
  } finally {
    initial.close()
    reload?.close()
    await backend.dispose()
  }
})
