import { expect, test } from 'bun:test'
import type { ViewHandle } from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { dialogNavigationReadiness } from '../examples/file-dialogs/readiness.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const url = 'app://ui/index.html?new-document=1'
async function fixture() {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  let next = 0,
    navigation: Command | undefined,
    view!: ViewHandle
  peer.handle((command) => {
    if (command.op === 'view.navigate') navigation = command
    else if (command.op === 'policy.scope') {
      const document = backend.state(view).documentId
      peer.reply(command, {
        view: 3,
        session: 1,
        generation: Number(document.split('-')[2]),
        mainFrame: 'frame-3',
        document,
        origin: 'app://ui',
      })
    } else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const session = await backend.createSession({
    partition: 'dialog-ready',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'dialog-ready',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  })
  view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const ready = dialogNavigationReadiness(backend, view, url)
  const navigating = (data: Record<string, unknown> = {}) =>
    peer.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url, documentId: 'native-3-2', applicationTrust: false, ...data },
    })
  const loaded = (data: Record<string, unknown> = {}, target = 3) =>
    peer.send({
      v: 1,
      event: 'view.loaded',
      target,
      data: { url, documentId: 'native-3-2', status: 200, ...data },
    })
  return {
    ...peer,
    backend,
    view,
    ready,
    navigating,
    loaded,
    acknowledge() {
      expect(navigation).toBeDefined()
      peer.reply(navigation!)
    },
    async cleanup() {
      ready.close()
      await backend.dispose()
    },
  }
}

test('dialog navigation waits beyond its acknowledgment and keeps old policy authority revoked', async () => {
  const f = await fixture()
  try {
    const old = await f.backend.capturePolicyScope(f.view)
    await f.backend.grantNativeCapability(old, { name: 'dialog-open' })
    const navigation = f.backend.navigate(f.view, url)
    f.acknowledge()
    await navigation
    let finished = false
    const waiting = f.ready.wait().then(() => (finished = true))
    await turn()
    expect(finished).toBe(false)
    expect(f.backend.isPolicyScopeLocallyCurrent(old)).toBe(false)
    f.navigating()
    await turn()
    expect(finished).toBe(false)
    f.loaded()
    await waiting
    expect(f.backend.state(f.view).trust).toEqual({ kind: 'remote' })
    await expect(
      f.backend.grantNativeCapability(old, { name: 'dialog-open' })
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(f.commands.filter((command) => command.op === 'policy.native.grant')).toHaveLength(1)
    const fresh = await f.backend.capturePolicyScope(f.view)
    await f.backend.grantNativeCapability(fresh, { name: 'dialog-open' })
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.commands.filter((command) => command.op === 'policy.native.grant')).toHaveLength(2)
  } finally {
    await f.cleanup()
  }
})

test('dialog navigation retains matching native readiness when callbacks precede the reply', async () => {
  const f = await fixture()
  try {
    const navigation = f.backend.navigate(f.view, url)
    f.navigating()
    f.loaded()
    f.acknowledge()
    await navigation
    await f.ready.wait()
    expect(f.backend.state(f.view).documentId).toBe('native-3-2')
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.commands.some((command) => command.op === 'policy.scope')).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('old documents and other native targets cannot satisfy dialog navigation readiness', async () => {
  const f = await fixture()
  try {
    let finished = false
    const waiting = f.ready.wait().then(() => (finished = true))
    f.loaded({ url: 'app://ui/index.html', documentId: 'native-3-1' })
    await turn()
    expect(finished).toBe(false)
    f.navigating()
    f.loaded({}, 99)
    await turn()
    expect(finished).toBe(false)
    f.loaded()
    await waiting
    expect(f.backend.diagnostics().listeners).toBe(0)
  } finally {
    await f.cleanup()
  }
})

for (const failure of ['wrong-url', 'application-trust', 'replacement', 'failed-load'] as const) {
  test(`dialog navigation rejects ${failure} and releases its listeners`, async () => {
    const f = await fixture()
    try {
      const waiting = f.ready.wait()
      if (failure === 'wrong-url') f.navigating({ url: 'app://ui/other.html' })
      else if (failure === 'application-trust') f.navigating({ applicationTrust: true })
      else {
        f.navigating()
        if (failure === 'replacement') f.navigating({ documentId: 'native-3-3' })
        else f.loaded({ status: 500 })
      }
      await expect(waiting).rejects.toThrow('MANAGED_DOCUMENT_CHANGED')
      expect(f.backend.diagnostics().listeners).toBe(0)
      expect(f.commands.some((command) => command.op === 'policy.scope')).toBe(false)
    } finally {
      await f.cleanup()
    }
  })
}

test('dialog readiness rejects a noncanonical previous document before subscribing', async () => {
  const f = await fixture()
  try {
    f.ready.close()
    f.navigating({ documentId: 'other-document' })
    await turn()
    expect(() => dialogNavigationReadiness(f.backend, f.view, url)).toThrow(
      'MANAGED_DOCUMENT_CHANGED'
    )
    expect(f.backend.diagnostics().listeners).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('a malformed native document rejects pending dialog readiness without accepting a partial match', async () => {
  const f = await fixture()
  try {
    f.navigating({ documentId: 'native-3-2\n' })
    await expect(f.ready.wait()).rejects.toThrow('Invalid native document identity')
    expect(f.backend.diagnostics().listeners).toBe(0)
  } finally {
    f.ready.close()
    await expect(f.backend.dispose()).rejects.toThrow('Invalid native document identity')
  }
})

test('dialog navigation releases both subscriptions when its caller cancels', async () => {
  const f = await fixture()
  try {
    const reason = new Error('FIXTURE_CANCELLED')
    f.ready.close(reason)
    await expect(f.ready.wait()).rejects.toBe(reason)
    expect(f.backend.diagnostics().listeners).toBe(0)
    expect(f.transport.diagnostics().closed).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('closing the dialog owner or backend rejects pending navigation readiness', async () => {
  for (const close of ['view', 'backend'] as const) {
    const f = await fixture()
    try {
      const waiting = f.ready.wait()
      if (close === 'view') await f.backend.disposeView(f.view)
      else await f.backend.dispose()
      await expect(waiting).rejects.toThrow('MANAGED_DOCUMENT_CLOSED')
      expect(f.backend.diagnostics().listeners).toBe(0)
    } finally {
      await f.cleanup()
    }
  }
})
