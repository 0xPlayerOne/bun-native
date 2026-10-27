/** Executable portable model, not a native window or backend-reload demonstration. */
import assert from 'node:assert/strict'
import { ManagedGenerationOwner, MockBackend } from '../../packages/runtime/src/index.ts'

export async function managedGenerationExample() {
  const backend = new MockBackend()
  const owner = new ManagedGenerationOwner()
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'managed' })
  const window = await backend.createWindow({
    title: 'Managed model',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://managed/start',
    trust: { kind: 'application', origin: 'app://managed' },
  })
  const sessionLease = owner.register({
    kind: 'session',
    schema: 'session:1',
    permission: 'session:use',
    authorize: () => false,
    invoke: () => {
      throw new Error('No session operations exposed')
    },
    dispose: () => backend.disposeSession(session),
  })
  const windowLease = owner.register({
    kind: 'window',
    schema: 'window:1',
    permission: 'window:use',
    authorize: () => false,
    invoke: () => {
      throw new Error('No window operations exposed')
    },
    dispose: () => backend.closeWindow(window),
  })
  const viewLease = owner.register({
    kind: 'view',
    schema: 'view:1',
    permission: 'view:read',
    dependsOn: [windowLease, sessionLease],
    authorize: (operation) =>
      operation === 'state' && backend.state(view).trust.kind === 'application',
    invoke: () => JSON.stringify({ url: backend.state(view).url }),
    dispose: () => backend.disposeView(view),
  })
  let oldEvents = 0,
    newEvents = 0
  try {
    const first = owner.begin('application-state:1', ['view:read'])
    owner.attach(first, viewLease, 'view:1')
    owner.commit(first, '{"revision":1}')
    const scope = owner.scope(first)
    let off = () => {}
    const subscription = scope.own('listener', () => off())
    off = backend.onEvent(
      scope.callback(subscription, () => {
        oldEvents++
      })
    )
    const before = backend.state(view)
    const replacement = owner.begin('application-state:1', ['view:read'])
    owner.attach(replacement, viewLease, 'view:1')
    assert.equal(owner.state(replacement), '{"revision":1}')
    owner.commit(replacement, '{"revision":2}')
    const next = owner.scope(replacement)
    let remove = () => {}
    const listener = next.own('listener', () => remove())
    remove = backend.onEvent(
      next.callback(listener, () => {
        newEvents++
      })
    )
    // The actual stable mock view/document has not been reconstructed.
    assert.equal(backend.state(view), before)
    assert.equal(await next.invoke(viewLease, 'state', 'null'), '{"url":"app://managed/start"}')
    await backend.navigate(view, 'app://managed/next')
    assert.equal(oldEvents, 0)
    assert.equal(newEvents, 1)
    assert.equal(scope.signal.aborted, true)
    assert.equal(owner.diagnostics().active, 1)
    return {
      profile: 'portable-managed-ownership-model',
      replacements: 1,
      nativeExecution: false,
      stableViewPreserved: true,
      oldCallbacks: oldEvents,
      newCallbacks: newEvents,
    }
  } finally {
    owner.dispose()
    await Promise.all([
      owner.disposeResource(viewLease),
      owner.disposeResource(windowLease),
      owner.disposeResource(sessionLease),
    ])
    await backend.dispose()
    assert.equal(owner.diagnostics().work, 0)
    assert.equal(owner.diagnostics().resources, 0)
  }
}
if (import.meta.main) console.log(JSON.stringify(await managedGenerationExample()))
