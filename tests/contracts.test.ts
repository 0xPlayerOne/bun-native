import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockBackend, BunlyError, defineApp, startApp } from '../packages/runtime/src/index.ts'
import { readDescriptor } from '../packages/client/src/index.ts'
import type { ViewHandle } from '../packages/contracts/src/index.ts'
const config = { id: 'dev.bunly.test', title: 'Test', url: 'https://example.test' }
const hasCode = (code: string) => (e: unknown) => e instanceof BunlyError && e.code === code
describe('portable lifecycle contract', () => {
  it('creates, navigates and disposes in a deterministic order', async () => {
    const b = new MockBackend()
    const events: string[] = []
    b.onEvent((e) => events.push(e.type))
    const a = await startApp(b, config)
    const before = b.state(a.view)
    const after = await b.navigate(a.view, 'https://example.test/next')
    assert.notEqual(before.documentId, after.documentId)
    assert.equal(after.url, 'https://example.test/next')
    await a.dispose()
    await a.dispose()
    assert.deepEqual(events, [
      'created',
      'created',
      'created',
      'navigated',
      'disposed',
      'disposed',
      'disposed',
    ])
    assert.equal(b.diagnostics().views, 0)
    await b.dispose()
  })
  it('rejects forged, foreign, wrong-kind and stale handles', async () => {
    const b = new MockBackend()
    const other = new MockBackend()
    const a = await startApp(b, config)
    assert.throws(() => other.state(a.view), hasCode('INVALID_HANDLE'))
    assert.throws(() => b.state({ ...a.view } as ViewHandle), hasCode('INVALID_HANDLE'))
    assert.throws(() => b.state(a.window as unknown as ViewHandle), hasCode('INVALID_HANDLE'))
    await b.disposeView(a.view)
    assert.throws(() => b.state(a.view), hasCode('DISPOSED'))
    await b.dispose()
    await other.dispose()
  })
  it('prevents disposal of a referenced session and cascades window close', async () => {
    const b = new MockBackend()
    const a = await startApp(b, config)
    await assert.rejects(b.disposeSession(a.session), hasCode('RESOURCE_IN_USE'))
    await b.closeWindow(a.window)
    assert.equal(b.diagnostics().views, 0)
    await b.disposeSession(a.session)
    await b.dispose()
  })
  it('does not invent native capabilities in the mock', async () => {
    const b = new MockBackend()
    const a = await startApp(b, config)
    const operations = [
      () => b.snapshot(a.view),
      () => b.evaluate(a.view, '1'),
      () => b.input(a.view, { type: 'text', text: 'x' }),
      () => b.cookies(a.session),
      () => b.requestPermission(a.view, 'camera'),
      () => b.download(a.view, { url: 'https://example.test/a' }),
      () => b.extension(a.view, 'cef:raw', {}),
    ]
    for (const op of operations) await assert.rejects(op(), hasCode('UNSUPPORTED_CAPABILITY'))
    await assert.rejects(
      b.createSession({ persistence: 'persistent', partition: 'disk' }),
      hasCode('UNSUPPORTED_CAPABILITY')
    )
    await b.dispose()
  })
  it('revokes application trust on navigation and never implicitly restores it', async () => {
    const b = new MockBackend()
    const session = await b.createSession({ persistence: 'ephemeral', partition: 'app' })
    const window = await b.createWindow({
      title: 'Test',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
    const view = await b.createView({
      window,
      session,
      url: 'app://bunly/start',
      trust: { kind: 'application', origin: 'app://bunly' },
    })
    assert.equal((await b.navigate(view, 'app://bunly/next')).trust.kind, 'application')
    assert.equal((await b.navigate(view, 'https://hostile.test')).trust.kind, 'remote')
    assert.equal((await b.navigate(view, 'app://bunly/start')).trust.kind, 'remote')
    await b.dispose()
  })
  it('rejects incorrect origin grants and credential or executable URLs', async () => {
    const b = new MockBackend()
    const a = await startApp(b, config)
    await assert.rejects(
      b.createView({
        window: a.window,
        session: a.session,
        url: 'https://other.test',
        trust: { kind: 'application', origin: 'https://example.test' },
      }),
      hasCode('PERMISSION_DENIED')
    )
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@example.test',
      'about:config',
      'app://',
    ])
      await assert.rejects(b.navigate(a.view, url), hasCode('INVALID_ARGUMENT'))
    await b.dispose()
  })
  it('cancels before mutating state', async () => {
    const b = new MockBackend()
    const a = await startApp(b, config)
    const previous = b.state(a.view)
    await assert.rejects(b.navigate(a.view, 'https://other.test', { signal: AbortSignal.abort() }))
    assert.equal(b.state(a.view), previous)
    await b.dispose()
  })
  it('rolls back partially created applications', async () => {
    const b = new MockBackend()
    await assert.rejects(startApp(b, { ...config, url: 'file:///bad' }))
    assert.equal(b.diagnostics().sessions + b.diagnostics().windows + b.diagnostics().views, 0)
    await b.dispose()
  })
  it('cleans listeners and forbids creation after backend disposal', async () => {
    const b = new MockBackend()
    const off = b.onEvent(() => {
      throw new Error('user listener')
    })
    const a = await startApp(b, config)
    assert.equal(b.diagnostics().listenerErrors, 3)
    off()
    off()
    await a.dispose()
    await b.dispose()
    await b.dispose()
    assert.equal(b.diagnostics().listeners, 0)
    await assert.rejects(startApp(b, config), hasCode('DISPOSED'))
  })
  it('validates immutable feature discovery and application identity', () => {
    const b = new MockBackend()
    const d = readDescriptor(b.descriptor)
    assert.ok(Object.isFrozen(d.capabilities))
    assert.throws(() => readDescriptor({ ...d, contractVersion: 999 }), hasCode('VERSION_MISMATCH'))
    assert.throws(
      () => readDescriptor({ ...d, capabilities: ['invented'] }),
      hasCode('INVALID_ARGUMENT')
    )
    assert.throws(
      () => readDescriptor({ ...d, capabilities: ['view.navigate', 'view.navigate'] }),
      hasCode('INVALID_ARGUMENT')
    )
    assert.throws(() => defineApp({ ...config, id: '../../bad' }), hasCode('INVALID_ARGUMENT'))
  })
  it('rejects reentrant view creation while its window is closing', async () => {
    const b = new MockBackend()
    const a = await startApp(b, config)
    const attempts: Promise<void>[] = []
    b.onEvent((event) => {
      if (event.type === 'disposed' && event.resource === a.view) {
        attempts.push(
          assert.rejects(
            b.createView({
              window: a.window,
              session: a.session,
              url: config.url,
              trust: { kind: 'remote' },
            }),
            hasCode('DISPOSED')
          )
        )
      }
    })
    await b.closeWindow(a.window)
    await Promise.all(attempts)
    assert.equal(attempts.length, 1)
    assert.equal(b.diagnostics().views, 0)
    await b.dispose()
  })
  it('does not deliver an in-progress event to a newly added listener', async () => {
    const b = new MockBackend()
    let calls = 0
    let installed = false
    b.onEvent(() => {
      if (!installed) {
        installed = true
        b.onEvent(() => calls++)
      }
    })
    const session = await b.createSession({ persistence: 'ephemeral', partition: 'snapshot' })
    assert.equal(calls, 0)
    await b.disposeSession(session)
    assert.equal(calls, 1)
    await b.dispose()
  })
  it('survives repeated lifecycle cycles without retained resources', async () => {
    const b = new MockBackend()
    for (let i = 0; i < 100; i++) {
      const a = await startApp(b, config)
      await a.dispose()
    }
    assert.equal(b.diagnostics().windows + b.diagnostics().views + b.diagnostics().sessions, 0)
    await b.dispose()
  })
})
