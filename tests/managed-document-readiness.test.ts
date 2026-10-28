import { expect, test } from 'bun:test'
import { managedDocumentReadiness } from '../examples/managed-desktop/document-readiness.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer } from './helpers/native-peer.ts'

async function fixture(rejectView = false) {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    if (command.op === 'view.create' && rejectView) peer.reject(command, 'VIEW_CREATE_REJECTED')
    else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ partition: 'readiness', persistence: 'ephemeral' })
  const window = await backend.createWindow({
    title: 'readiness',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  })
  const readiness = managedDocumentReadiness(backend, 'app://ui/restart.html')
  const createView = () =>
    backend.createView({
      window,
      session,
      url: 'app://ui/restart.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
  const cleanup = async () => {
    readiness.close()
    await backend.dispose()
  }
  return { ...peer, backend, readiness, createView, cleanup }
}

test('native readiness removes its observers immediately after the matching loaded receipt', async () => {
  const f = await fixture()
  try {
    const view = await f.createView()
    const waiting = f.readiness.wait(view)
    expect(f.backend.diagnostics().listeners).toBe(2)
    f.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url: 'app://ui/restart.html', documentId: 'native-3-1', status: 200 },
    })
    await waiting
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.commands.some((command) => command.op === 'policy.scope')).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('native readiness releases its pre-creation observers when creation fails', async () => {
  const f = await fixture(true)
  try {
    expect(f.backend.diagnostics().listeners).toBe(2)
    await expect(f.createView()).rejects.toThrow('VIEW_CREATE_REJECTED')
    f.readiness.close(new Error('VIEW_CREATE_REJECTED'))
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.backend.diagnostics().views).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('native readiness preserves caller cancellation and removes observers before backend shutdown', async () => {
  const f = await fixture()
  try {
    const waiting = f.readiness.wait(await f.createView())
    const reason = new Error('FIXTURE_CANCELLED')
    f.readiness.close(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.transport.diagnostics().closed).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('closing the target view rejects native readiness without waiting for a fixture deadline', async () => {
  const f = await fixture()
  try {
    const view = await f.createView()
    const waiting = f.readiness.wait(view)
    await f.backend.disposeView(view)
    await expect(waiting).rejects.toThrow('MANAGED_DOCUMENT_CLOSED')
    expect(f.backend.diagnostics().listeners).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('a replacement document cannot satisfy readiness for the captured native document', async () => {
  const f = await fixture()
  try {
    const waiting = f.readiness.wait(await f.createView())
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: {
        url: 'app://ui/restart.html',
        documentId: 'native-3-2',
        applicationTrust: false,
      },
    })
    await expect(waiting).rejects.toThrow('MANAGED_DOCUMENT_CHANGED')
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.commands.some((command) => command.op === 'policy.scope')).toBe(false)
  } finally {
    await f.cleanup()
  }
})
