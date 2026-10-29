import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ErrorCode, PolicyScope, ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../../packages/runtime/src/managed-generations.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { dialogNavigationReadiness } from './readiness.ts'
import { formatDesktopFixtureFailure } from '../../benchmarks/desktop/failure-codes.ts'

// Bootstrap and fixture are separate bundles in one Bun realm. SDK errors keep
// their name and code across that boundary, but not a shared BunlyError class.
export const hasCode = (code: ErrorCode) => (error: unknown) =>
  error instanceof Error && error.name === 'BunlyError' && 'code' in error && error.code === code
type Receipt = {
  supported: boolean
  active: number
  visible: boolean
  admissions: number
  callbacks: number
  selected: number
  cancelled: number
  failed: number
}
function receipt(value: unknown): Receipt {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const data = value as Record<string, unknown>
  assert.deepEqual(Object.keys(data).sort(), [
    'active',
    'admissions',
    'callbacks',
    'cancelled',
    'failed',
    'selected',
    'supported',
    'visible',
  ])
  for (const key of ['admissions', 'callbacks', 'cancelled', 'failed', 'selected'])
    assert.ok(Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 6)
  assert.ok(data['active'] === 0 || data['active'] === 1)
  assert.equal(typeof data['visible'], 'boolean')
  assert.equal(typeof data['supported'], 'boolean')
  return data as Receipt
}

/** Native cancellation only. No file is selected, read, created or overwritten. */
export default async function qualifyFileDialogs(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('File dialog fixture deadline')),
    25_000
  )
  let stage = 'setup',
    failure: string | null = null,
    status: 'executed' | 'unsupported' | null = null
  const checks: Record<string, boolean> = {}
  let root: string | undefined
  let final: Receipt | null = null
  let shutdowns = 0,
    shutdown: Receipt | null = null,
    disposing = false,
    clean = false
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const onAbort = () => {
    failure ??= formatDesktopFixtureFailure('dialogs', stage, controller.signal.reason)
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const stop = backend.observe((event) => {
    if (event.event !== 'dialog.shutdown') return
    try {
      assert.equal(++shutdowns, 1)
      shutdown = receipt(event.data)
    } catch (error) {
      failure ??= formatDesktopFixtureFailure('dialogs', 'shutdown-receipt', error)
    }
  })
  void backend.closed.then(
    () => {
      if (!disposing) controller.abort(new Error('Host closed before dialog fixture completed'))
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
  const state = async () => receipt(await bounded(backend.qualifyFileDialogState()))
  // Observe early rejection while visibility polling owns the next await.
  const track = <T>(promise: Promise<T>): Promise<T> => {
    void promise.catch((error: unknown) => controller.abort(error))
    return promise
  }
  const visible = async () => {
    for (;;) {
      controller.signal.throwIfAborted()
      const current = await state()
      if (current.active === 1 && current.visible) return
      await bounded(new Promise<void>((resolve) => setTimeout(resolve, 20)))
    }
  }
  try {
    root = await mkdtemp(join(tmpdir(), 'bunly-dialogs-'))
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'file-dialogs',
    })
    const window = await backend.createWindow({
      title: 'Bunly file dialogs',
      bounds: { x: 32, y: 32, width: 640, height: 480 },
    })
    const create = async (url: string): Promise<ViewHandle> => {
      const readiness = managedDocumentReadiness(backend, url)
      try {
        const view = await backend.createView({
          window,
          session,
          url,
          trust: { kind: 'application', origin: 'app://ui' },
        })
        await bounded(readiness.wait(view))
        return view
      } finally {
        readiness.close()
      }
    }
    const grant = async (view: ViewHandle): Promise<PolicyScope> => {
      const scope = await backend.capturePolicyScope(view)
      await backend.grantNativeCapability(scope, { name: 'dialog-open' })
      await backend.grantNativeCapability(scope, { name: 'dialog-save' })
      return scope
    }
    let view = await create('app://ui/index.html')
    let scope = await backend.capturePolicyScope(view)
    const options = { directory: root, title: 'Bunly cancel-only qualification' }
    stage = 'capability'
    if (!backend.descriptor.capabilities.includes('dialog.file')) {
      assert.notEqual(process.platform, 'darwin')
      checks['capabilityUnavailable'] = true
      await assert.rejects(
        backend.showOpenFileDialog(scope, options),
        hasCode('UNSUPPORTED_CAPABILITY')
      )
      checks['openUnsupported'] = true
      await assert.rejects(
        backend.showSaveFileDialog(scope, { ...options, suggestedName: 'unused.txt' }),
        hasCode('UNSUPPORTED_CAPABILITY')
      )
      checks['saveUnsupported'] = true
      status = 'unsupported'
      final = await state()
      assert.deepEqual(final, {
        supported: false,
        active: 0,
        visible: false,
        admissions: 0,
        callbacks: 0,
        selected: 0,
        cancelled: 0,
        failed: 0,
      })
    } else {
      assert.equal(process.platform, 'darwin')
      await assert.rejects(backend.showOpenFileDialog(scope, options), hasCode('PERMISSION_DENIED'))
      checks['missingGrantDenied'] = true
      scope = await grant(view)
      for (const kind of ['open', 'save'] as const) {
        stage = kind + '-cancel'
        const cancel = new AbortController()
        const pending = track(
          kind === 'open'
            ? backend.showOpenFileDialog(scope, options, { signal: cancel.signal })
            : backend.showSaveFileDialog(
                scope,
                { ...options, suggestedName: 'unused.txt' },
                { signal: cancel.signal }
              )
        )
        await visible()
        cancel.abort()
        assert.deepEqual(await bounded(pending), { status: 'cancelled' })
        assert.equal((await state()).active, 0)
        checks[kind + 'VisibleAndCancelled'] = true
      }
      stage = 'managed-retirement'
      const authority = await desktop.captureAuthority(view)
      const resource = desktop.registerFileDialogs('dialogs', {
        authority,
        permission: 'dialog',
        operations: ['open'],
      })
      const generation = owner.begin('dialog:1', ['dialog'])
      owner.attach(generation, resource, 'bunly.dialog:1')
      owner.commit(generation, '{}')
      const managed = track(
        assert.rejects(
          owner.invoke(generation, resource, 'open', JSON.stringify(options)),
          /RETIRED/
        )
      )
      await visible()
      owner.retire(generation)
      await bounded(managed)
      await bounded(desktop.close('dialogs'))
      assert.equal(owner.diagnostics().inFlight, 0)
      checks['managedRetiredAfterNativeCompletion'] = true

      stage = 'navigation'
      const navigating = track(
        assert.rejects(backend.showOpenFileDialog(scope, options), hasCode('PERMISSION_DENIED'))
      )
      await visible()
      const url = 'app://ui/index.html?new-document=1'
      const readiness = dialogNavigationReadiness(backend, view, url)
      try {
        await bounded(backend.navigate(view, url))
        await bounded(readiness.wait())
      } finally {
        readiness.close()
      }
      await bounded(navigating)
      checks['navigationRevoked'] = true
      scope = await grant(view)
      stage = 'view-close'
      const closing = track(
        assert.rejects(backend.showOpenFileDialog(scope, options), hasCode('PERMISSION_DENIED'))
      )
      await visible()
      await bounded(backend.disposeView(view))
      await bounded(closing)
      checks['viewCloseWaitedForNativeCompletion'] = true

      view = await create('app://ui/index.html?quit=1')
      scope = await grant(view)
      stage = 'quit'
      const quitting = track(
        assert.rejects(
          backend.showSaveFileDialog(scope, { ...options, suggestedName: 'unused.txt' }),
          hasCode('PERMISSION_DENIED')
        )
      )
      await visible()
      disposing = true
      await bounded(backend.dispose())
      await bounded(quitting)
      clean = true
      checks['quitWaitedForNativeCompletion'] = true
      assert.equal(shutdowns, 1)
      final = shutdown
      assert.deepEqual(final, {
        supported: true,
        active: 0,
        visible: false,
        admissions: 6,
        callbacks: 6,
        selected: 0,
        cancelled: 3,
        failed: 3,
      })
      status = 'executed'
    }
    assert.deepEqual(await readdir(root), [])
    checks['directoryUnchanged'] = true
  } catch (error) {
    failure ??= formatDesktopFixtureFailure('dialogs', stage, error)
  } finally {
    try {
      await bounded(desktop.dispose())
      owner.dispose()
    } catch (error) {
      failure ??= formatDesktopFixtureFailure('dialogs', 'managed-cleanup', error)
    }
    disposing = true
    try {
      await bounded(backend.dispose())
      clean = true
    } catch (error) {
      failure ??= formatDesktopFixtureFailure('dialogs', 'native-cleanup', error)
    }
    if (clean && root) {
      try {
        await rm(root, { recursive: true })
        checks['temporaryDirectoryRemoved'] = true
      } catch (error) {
        failure ??= formatDesktopFixtureFailure('dialogs', 'directory-cleanup', error)
      }
    }
    if (shutdowns !== 1)
      failure ??= formatDesktopFixtureFailure('dialogs', 'shutdown-receipt', undefined)
    if (final && shutdown) {
      try {
        assert.deepEqual(final, shutdown)
      } catch (error) {
        failure ??= formatDesktopFixtureFailure('dialogs', 'shutdown-mismatch', error)
      }
    }
    stop()
    clearTimeout(deadline)
    controller.signal.removeEventListener('abort', onAbort)
  }
  console.log(
    JSON.stringify({
      event: 'bunly.native.file-dialogs',
      schema: 1,
      passed: failure === null,
      failure,
      status,
      checks,
      final,
      shutdown,
      shutdowns,
      physicalInputQualified: false,
      assistiveTechnologyQualified: false,
      fileSelectionQualified: false,
      performanceEligible: false,
    })
  )
  if (failure) throw new Error('Native file dialog fixture failed at ' + failure)
}
