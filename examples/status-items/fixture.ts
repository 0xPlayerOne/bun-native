import assert from 'node:assert/strict'
import type { ErrorCode, StatusItemHandle, ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../../packages/runtime/src/managed-generations.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { formatDesktopFixtureFailure } from '../../benchmarks/desktop/failure-codes.ts'

// The qualifier builds bootstrap and application independently in one Bun realm.
export const hasCode = (code: ErrorCode) => (error: unknown) =>
  error instanceof Error && error.name === 'BunlyError' && 'code' in error && error.code === code
type Snapshot = Awaited<ReturnType<CefBackend['qualifyStatusItemSnapshot']>>
function snapshot(value: unknown): Snapshot {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const input = value as Record<string, unknown>
  assert.deepEqual(Object.keys(input).sort(), [
    'clicks',
    'created',
    'delegates',
    'items',
    'removed',
    'supported',
    'weakOwners',
  ])
  assert.equal(typeof input['supported'], 'boolean')
  for (const key of ['items', 'delegates', 'weakOwners', 'created', 'removed'])
    assert.ok(
      Number.isSafeInteger(input[key]) && Number(input[key]) >= 0 && Number(input[key]) <= 4
    )
  assert.ok(
    Number.isSafeInteger(input['clicks']) &&
      Number(input['clicks']) >= 0 &&
      Number(input['clicks']) <= 2
  )
  return input as unknown as Snapshot
}

/** Four native owners, two actual AppKit performClick callbacks, and real removal/quit proof. */
export default async function qualifyStatusItems(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Status item fixture deadline')),
    25_000
  )
  let stage = 'ready',
    failure: string | null = null,
    disposing = false
  let status: 'executed' | 'unsupported' | null = null
  let shutdown: Snapshot | null = null,
    shutdowns = 0,
    callbacks = 0
  const checks: Record<string, boolean> = {}
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const readiness: ReturnType<typeof managedDocumentReadiness>[] = []
  const fail = (error: unknown) => {
    failure ??= formatDesktopFixtureFailure('status', stage, error)
  }
  const stop = backend.observe((event) => {
    if (event.event !== 'status.shutdown') return
    try {
      assert.equal(++shutdowns, 1)
      shutdown = snapshot(event.data)
    } catch (error) {
      fail(error)
    }
  })
  void backend.closed.then(
    () => {
      if (!disposing) controller.abort(new Error('Host closed before status fixture completed'))
    },
    (error: unknown) => controller.abort(error)
  )
  const bounded = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      void promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort))
      if (controller.signal.aborted) abort()
    })
  try {
    await bounded(backend.whenApplicationReady())
    const session = await bounded(
      backend.createSession({ persistence: 'ephemeral', partition: 'status-items' })
    )
    const window = await bounded(
      backend.createWindow({
        title: 'Bunly status item owner',
        bounds: { x: 80, y: 80, width: 640, height: 480 },
      })
    )
    const createView = async (part: string) => {
      const url = 'app://ui/index.html?status=' + part
      const ready = managedDocumentReadiness(backend, url)
      readiness.push(ready)
      const view = await bounded(
        backend.createView({
          window,
          session,
          url,
          trust: { kind: 'application', origin: 'app://ui' },
        })
      )
      await bounded(ready.wait(view))
      return view
    }
    let view = await createView('first')
    const grant = async (view: ViewHandle) => {
      const scope = await bounded(backend.capturePolicyScope(view))
      await bounded(backend.grantNativeCapability(scope, { name: 'status-item' }))
      return scope
    }
    const assertOwners = async (created: number, removed: number, items: number) => {
      const state = snapshot(await bounded(backend.qualifyStatusItemSnapshot()))
      assert.deepEqual(state, {
        supported: true,
        created,
        removed,
        items,
        delegates: items,
        weakOwners: items,
        clicks: callbacks,
      })
    }
    stage = 'capability'
    const initial = snapshot(await bounded(backend.qualifyStatusItemSnapshot()))
    const supported = backend.descriptor.capabilities.includes('status.item')
    assert.equal(initial.supported, supported)
    assert.deepEqual(initial, {
      supported,
      items: 0,
      delegates: 0,
      weakOwners: 0,
      created: 0,
      removed: 0,
      clicks: 0,
    })
    if (!supported) {
      const scope = await bounded(backend.capturePolicyScope(view))
      await bounded(
        assert.rejects(
          backend.createStatusItem(scope, { title: 'Unavailable' }),
          hasCode('UNSUPPORTED_CAPABILITY')
        )
      )
      checks['capabilityUnavailable'] = true
      checks['createUnsupported'] = true
      status = 'unsupported'
    } else {
      stage = 'policy'
      let scope = await bounded(backend.capturePolicyScope(view))
      await bounded(
        assert.rejects(
          backend.createStatusItem(scope, { title: 'Denied' }),
          hasCode('PERMISSION_DENIED')
        )
      )
      checks['missingGrantDenied'] = true
      scope = await grant(view)
      await bounded(
        assert.rejects(
          backend.createStatusItem(scope, { title: 'x'.repeat(65) }),
          hasCode('INVALID_ARGUMENT')
        )
      )
      checks['oversizedRejected'] = true
      const item = await bounded(
        backend.createStatusItem(scope, { title: 'Bunly 1', tooltip: 'Owned status fixture' })
      )
      await bounded(
        assert.rejects(
          backend.updateStatusItem({ ...item } as StatusItemHandle, { title: 'Forged' }),
          hasCode('INVALID_HANDLE')
        )
      )
      checks['forgedRejected'] = true
      await bounded(
        assert.rejects(
          backend.createStatusItem(scope, { title: 'Duplicate' }),
          hasCode('RESOURCE_IN_USE')
        )
      )
      checks['duplicateRejected'] = true
      stage = 'owned-click'
      const stopClick = backend.onStatusItemEvent(item, (event) => {
        assert.equal(event.type, 'click')
        callbacks++
      })
      await bounded(backend.qualifyStatusItemClick(item))
      assert.equal(callbacks, 1)
      stage = 'update'
      await bounded(backend.updateStatusItem(item, { title: 'Bunly Ω', tooltip: 'Updated text' }))
      checks['updated'] = true
      await assertOwners(1, 0, 1)
      stopClick()
      await bounded(backend.disposeStatusItem(item))
      await assertOwners(1, 1, 0)
      checks['explicitRemoval'] = true

      stage = 'managed'
      const managed = await bounded(backend.createStatusItem(scope, { title: 'Bunly 2' }))
      stage = 'managed-authority'
      const authority = await bounded(desktop.captureAuthority(view))
      const resource = desktop.registerStatusItem('status', managed, {
        authority,
        permission: 'status',
        operations: ['events', 'ack-events'],
      })
      stage = 'managed-prepare'
      const bindings = await bounded(desktop.prepare())
      const first = owner.begin('status:1', ['status'])
      owner.attach(first, resource, bindings['status']!.schema)
      owner.commit(first, '{}')
      stage = 'managed-click'
      await bounded(backend.qualifyStatusItemClick(managed))
      stage = 'managed-read'
      const events = JSON.parse(
        await bounded(owner.scope(first).invoke(resource, 'events', 'null'))
      ) as { type: string; sequence: number; state: { type: string } }[]
      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'click')
      assert.equal(events[0]?.state.type, 'click')
      callbacks++
      stage = 'managed-replace'
      const second = owner.begin('status:1', ['status'])
      owner.attach(second, resource, bindings['status']!.schema)
      owner.commit(second, '{}')
      stage = 'managed-retired'
      await bounded(
        assert.rejects(
          owner.scope(first).invoke(resource, 'ack-events', '{"through":1}'),
          /RETIRED/
        )
      )
      stage = 'managed-replay'
      assert.deepEqual(
        JSON.parse(await bounded(owner.scope(second).invoke(resource, 'events', 'null'))),
        events
      )
      stage = 'managed-ack'
      await bounded(owner.scope(second).invoke(resource, 'ack-events', '{"through":1}'))
      assert.equal(desktop.diagnostics().queuedEvents, 0)
      stage = 'managed-close'
      await bounded(desktop.close('status'))
      await assertOwners(2, 2, 0)
      checks['managedJournalRetained'] = true
      checks['managedRemoval'] = true

      stage = 'view-close'
      const closing = await bounded(backend.createStatusItem(scope, { title: 'Bunly 3' }))
      await bounded(backend.disposeView(view))
      await bounded(backend.disposeStatusItem(closing))
      await assertOwners(3, 3, 0)
      checks['viewCloseRemoval'] = true
      view = await createView('quit')
      scope = await grant(view)
      await bounded(backend.createStatusItem(scope, { title: 'Bunly 4' }))
      await assertOwners(4, 3, 1)
      status = 'executed'
    }
    stage = 'quit'
    disposing = true
    await bounded(backend.dispose())
    assert.equal(shutdowns, 1)
    assert.deepEqual(shutdown, {
      supported: status === 'executed',
      items: 0,
      delegates: 0,
      weakOwners: 0,
      created: status === 'executed' ? 4 : 0,
      removed: status === 'executed' ? 4 : 0,
      clicks: status === 'executed' ? 2 : 0,
    })
    checks['quitRemoval'] = true
  } catch (error) {
    fail(error)
  } finally {
    stage = 'cleanup'
    for (const ready of readiness) ready.close()
    try {
      await desktop.dispose()
      owner.dispose()
    } catch (error) {
      fail(error)
    }
    disposing = true
    try {
      await backend.dispose()
    } catch (error) {
      fail(error)
    }
    stop()
    clearTimeout(deadline)
    const receipt = JSON.stringify({
      event: 'bunly.native.status-items',
      schema: 1,
      passed: failure === null,
      failure,
      status,
      checks,
      callbacks,
      shutdowns,
      shutdown,
      final: backend.statusItemDiagnostics(),
      backendFinal: backend.diagnostics(),
      physicalInputQualified: false,
      trayMenusQualified: false,
      keepaliveQualified: false,
      assistiveTechnologyQualified: false,
      performanceEligible: false,
    })
    assert.ok(Buffer.byteLength(receipt) <= 4096)
    console.error(receipt)
  }
  if (failure !== null) throw new Error(failure)
}
