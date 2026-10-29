import assert from 'node:assert/strict'
import type { ApplicationLinkReader, ErrorCode } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../../packages/runtime/src/managed-generations.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { formatDesktopFixtureFailure } from '../../benchmarks/desktop/failure-codes.ts'
import { applicationLinkChecks, applicationLinkStartupInputs } from './contract.ts'

const hasCode = (code: ErrorCode) => (error: unknown) =>
  error instanceof Error && error.name === 'BunlyError' && 'code' in error && error.code === code
type Snapshot = Awaited<ReturnType<CefBackend['qualifyApplicationLinkSnapshot']>>
function snapshot(value: unknown): Snapshot {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const input = value as Record<string, unknown>
  assert.deepEqual(Object.keys(input).sort(), [
    'acknowledged',
    'bytes',
    'delegates',
    'macos',
    'overflow',
    'queued',
    'readers',
    'rejected',
    'startup',
  ])
  for (const item of Object.values(input))
    assert.ok(Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 16384)
  return input as unknown as Snapshot
}

/** Three controlled startup arguments; no external browser launch or OS registration. */
export default async function qualifyApplicationLinks(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Application link fixture deadline')),
    25_000
  )
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const readiness: ReturnType<typeof managedDocumentReadiness>[] = []
  const checks: Record<string, boolean> = {}
  let stage = 'ready',
    failure: string | null = null,
    disposing = false
  let shutdown: Snapshot | null = null,
    shutdowns = 0
  const fail = (error: unknown) => {
    failure ??= formatDesktopFixtureFailure('links', stage, error)
  }
  const stop = backend.observe((event) => {
    if (event.event !== 'links.shutdown') return
    try {
      assert.equal(++shutdowns, 1)
      shutdown = snapshot(event.data)
    } catch (error) {
      fail(error)
    }
  })
  void backend.closed.then(
    () => {
      if (!disposing)
        controller.abort(new Error('Host closed before application link fixture completed'))
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
    const initial = snapshot(await bounded(backend.qualifyApplicationLinkSnapshot()))
    assert.deepEqual(initial, {
      readers: 0,
      queued: 2,
      bytes: applicationLinkStartupInputs
        .slice(0, 2)
        .reduce((total, value) => total + value.length, 0),
      overflow: 0,
      startup: 2,
      macos: 0,
      rejected: 1,
      acknowledged: 0,
      delegates: process.platform === 'darwin' ? 1 : 0,
    })
    checks['startupRouting'] = true
    const session = await bounded(
      backend.createSession({ persistence: 'ephemeral', partition: 'application-links' })
    )
    const window = await bounded(
      backend.createWindow({
        title: 'Bunly application link owner',
        bounds: { x: 80, y: 80, width: 640, height: 480 },
      })
    )
    const url = 'app://ui/index.html?generation=first'
    const ready = managedDocumentReadiness(backend, url)
    readiness.push(ready)
    const view = await bounded(
      backend.createView({
        session,
        window,
        url,
        trust: { kind: 'application', origin: 'app://ui' },
      })
    )
    await bounded(ready.wait(view))
    stage = 'policy'
    let scope = await bounded(backend.capturePolicyScope(view))
    await bounded(
      assert.rejects(backend.createApplicationLinkReader(scope), hasCode('PERMISSION_DENIED'))
    )
    checks['missingGrantDenied'] = true
    await bounded(backend.grantNativeCapability(scope, { name: 'application-links' }))
    const reader = await bounded(backend.createApplicationLinkReader(scope))
    await bounded(
      assert.rejects(
        backend.readApplicationLinks({ ...reader } as ApplicationLinkReader),
        hasCode('INVALID_HANDLE')
      )
    )
    checks['forgedReaderDenied'] = true
    await bounded(
      assert.rejects(backend.createApplicationLinkReader(scope), hasCode('RESOURCE_IN_USE'))
    )
    checks['duplicateReaderDenied'] = true
    stage = 'read-ack'
    const first = await bounded(backend.readApplicationLinks(reader))
    const current = await bounded(backend.readApplicationLinks(reader))
    assert.deepEqual(
      current.links.map((link) => link.url),
      applicationLinkStartupInputs.slice(0, 2)
    )
    assert.deepEqual(
      current.links.map((link) => [link.sequence, link.source]),
      [
        [1, 'startup'],
        [2, 'startup'],
      ]
    )
    assert.equal(current.overflow, 0)
    await bounded(
      assert.rejects(
        backend.acknowledgeApplicationLinks(reader, first),
        hasCode('INVALID_ARGUMENT')
      )
    )
    checks['staleBatchDenied'] = true
    await bounded(backend.disposeApplicationLinkReader(reader))
    assert.equal((await bounded(backend.qualifyApplicationLinkSnapshot())).queued, 2)
    checks['disposePreservesInput'] = true
    stage = 'managed'
    const managed = await bounded(backend.createApplicationLinkReader(scope))
    const authority = await bounded(desktop.captureAuthority(view))
    const resource = desktop.registerApplicationLinks('links', managed, {
      authority,
      permission: 'links',
      operations: ['events', 'ack-events'],
    })
    const bindings = await bounded(desktop.prepare())
    const generation = owner.begin('links:1', ['links'])
    owner.attach(generation, resource, bindings['links']!.schema)
    owner.commit(generation, '{}')
    const events = JSON.parse(
      await bounded(owner.scope(generation).invoke(resource, 'events', 'null'))
    ) as { sequence: number; type: string; state: { url: string } }[]
    assert.deepEqual(
      events.map((event) => [event.sequence, event.type, event.state.url]),
      applicationLinkStartupInputs.slice(0, 2).map((value, index) => [index + 1, 'link', value])
    )
    assert.equal((await bounded(backend.qualifyApplicationLinkSnapshot())).queued, 0)
    const replacement = owner.begin('links:1', ['links'])
    owner.attach(replacement, resource, bindings['links']!.schema)
    owner.commit(replacement, '{}')
    await bounded(
      assert.rejects(
        owner.scope(generation).invoke(resource, 'ack-events', '{"through":2}'),
        /RETIRED/
      )
    )
    await bounded(
      assert.rejects(
        owner.scope(replacement).invoke(resource, 'ack-events', '{"through":2}'),
        /INVALID_ARGUMENT/
      )
    )
    assert.deepEqual(
      JSON.parse(await bounded(owner.scope(replacement).invoke(resource, 'events', 'null'))),
      events
    )
    checks['managedJournalRetained'] = true
    await bounded(owner.scope(replacement).invoke(resource, 'ack-events', '{"through":2}'))
    assert.equal(desktop.diagnostics().queuedEvents, 0)
    await bounded(desktop.close('links'))
    checks['managedAcknowledgment'] = true
    stage = 'external-policy'
    if (backend.descriptor.capabilities.includes('app.open-url')) {
      await bounded(
        assert.rejects(
          backend.openExternalUrl(scope, 'https://example.invalid/path'),
          hasCode('PERMISSION_DENIED')
        )
      )
      await bounded(
        backend.grantNativeCapability(scope, {
          name: 'external-url',
          origins: ['https://example.invalid'],
        })
      )
      await bounded(
        assert.rejects(
          backend.openExternalUrl(scope, 'https://unlisted.invalid/path'),
          hasCode('PERMISSION_DENIED')
        )
      )
      await bounded(
        assert.rejects(
          backend.openExternalUrl(scope, 'file:///untrusted'),
          hasCode('INVALID_ARGUMENT')
        )
      )
    } else
      await bounded(
        assert.rejects(
          backend.openExternalUrl(scope, 'https://example.invalid/path'),
          hasCode('UNSUPPORTED_CAPABILITY')
        )
      )
    checks['externalUrlDenied'] = true
    stage = 'navigation'
    const retired = await bounded(backend.createApplicationLinkReader(scope))
    const nextUrl = 'app://ui/index.html?generation=next'
    const nextReady = managedDocumentReadiness(backend, nextUrl)
    readiness.push(nextReady)
    await bounded(backend.navigate(view, nextUrl))
    await bounded(nextReady.wait(view))
    await bounded(assert.rejects(backend.readApplicationLinks(retired), hasCode('DISPOSED')))
    await bounded(backend.disposeApplicationLinkReader(retired))
    assert.equal((await bounded(backend.qualifyApplicationLinkSnapshot())).readers, 0)
    checks['navigationRevoked'] = true
    scope = await bounded(backend.capturePolicyScope(view))
    await bounded(backend.grantNativeCapability(scope, { name: 'application-links' }))
    await bounded(backend.createApplicationLinkReader(scope))
    stage = 'quit'
    disposing = true
    await bounded(backend.dispose())
    assert.equal(shutdowns, 1)
    assert.deepEqual(shutdown, {
      readers: 0,
      queued: 0,
      bytes: 0,
      overflow: 0,
      startup: 2,
      macos: 0,
      rejected: 1,
      acknowledged: 2,
      delegates: 0,
    })
    checks['quitRemoval'] = true
    assert.deepEqual(Object.keys(checks).sort(), [...applicationLinkChecks].sort())
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
      event: 'bunly.native.application-links',
      schema: 1,
      passed: failure === null,
      failure,
      checks,
      shutdowns,
      shutdown,
      final: backend.applicationLinkDiagnostics(),
      backendFinal: backend.diagnostics(),
      osRegistrationQualified: false,
      liveOsDeliveryQualified: false,
      externalLaunchQualified: false,
      physicalInputQualified: false,
      performanceEligible: false,
    })
    assert.ok(Buffer.byteLength(receipt) <= 4096)
    console.error(receipt)
  }
  if (failure !== null) throw new Error(failure)
}
