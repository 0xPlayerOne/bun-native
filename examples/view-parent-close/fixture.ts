import assert from 'node:assert/strict'
import {
  requireCapability,
  type SessionHandle,
  type ViewHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { observeCompositionLifetime } from '../view-composition/lifetime.ts'
import { ParentCloseReceipts, parentClosePanes, parentCloseUrl } from './receipts.ts'

/** Close one native parent while all four manual panes are still live. */
export default async function qualifyParentClose(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Parent close fixture deadline')),
    25_000
  )
  const receipts = new ParentCloseReceipts()
  const views: ViewHandle[] = []
  const sessions: SessionHandle[] = []
  const readiness: ReturnType<typeof managedDocumentReadiness>[] = []
  let failure: string | null = null
  let before: Record<string, number> | null = null
  let nativeFinal: Record<string, number> | null = null
  let controlSurvived = false
  let sessionsReleasedAfterNativeClose = 0
  let wake: (() => void) | undefined
  const failed = (error: unknown) => {
    failure ??= String(error).slice(0, 1024)
  }
  const lifetime = observeCompositionLifetime(backend.closed, controller, failed)
  const stopNative = backend.observe((event) => {
    try {
      receipts.observe(event)
      wake?.()
    } catch (error) {
      controller.abort(error)
    }
  })
  const bounded = <T>(operation: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      void operation
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort))
      if (controller.signal.aborted) abort()
    })
  try {
    requireCapability(backend.descriptor, 'view.composition')
    const control = await bounded(
      backend.createWindow({
        title: 'Parent close control window',
        bounds: { x: 40, y: 40, width: 320, height: 240 },
      })
    )
    const parent = await bounded(
      backend.createWindow({
        title: 'Bunly live pane parent close',
        bounds: { x: 100, y: 100, width: 700, height: 550 },
        viewLayout: 'manual',
      })
    )
    for (const [index, pane] of parentClosePanes.entries()) {
      const session = await bounded(
        backend.createSession({ persistence: 'ephemeral', partition: `parent-close-${pane}` })
      )
      sessions.push(session)
      const url = parentCloseUrl(pane)
      const ready = managedDocumentReadiness(backend, url)
      readiness.push(ready)
      const view = await bounded(
        backend.createView({
          window: parent,
          session,
          url,
          trust: { kind: 'application', origin: 'app://ui' },
          presentation: {
            bounds: {
              x: 20 + (index % 2) * 320,
              y: 20 + Math.floor(index / 2) * 240,
              width: 300,
              height: 220,
            },
          },
        })
      )
      views.push(view)
      await bounded(ready.wait(view))
      receipts.bind(pane, view.id, session.id, backend.state(view).documentId)
    }
    const initial = (await bounded(backend.nativeDiagnostics())) as Record<string, unknown>
    before = {}
    for (const [key, value] of Object.entries({ windows: 2, views: 4, sessions: 4 })) {
      assert.equal(initial[key], value)
      before[key] = Number(initial[key])
    }
    receipts.beginClose()
    await bounded(backend.closeWindow(parent))
    while (!receipts.complete()) {
      await bounded(
        new Promise<void>((resolve) => {
          wake = resolve
        })
      )
      wake = undefined
    }
    for (const view of views) assert.throws(() => backend.state(view), /disposed/)
    // Native readback through the original control handle proves that the
    // remaining window is the intended survivor, not an empty leaked parent.
    await bounded(backend.windowState(control))
    controlSurvived = true
    for (const session of sessions) {
      assert.ok(receipts.complete())
      await bounded(backend.disposeSession(session))
      sessionsReleasedAfterNativeClose++
    }
    const final = (await bounded(backend.nativeDiagnostics())) as Record<string, unknown>
    nativeFinal = {}
    for (const key of [
      'windows',
      'views',
      'sessions',
      'pending',
      'nativeDeliveryPackets',
      'nativeDeliveryBytes',
      'rpcIncomingBytes',
      'streamIncomingBytes',
    ]) {
      assert.equal(final[key], key === 'windows' ? 1 : 0)
      nativeFinal[key] = Number(final[key])
    }
  } catch (error) {
    failed(error)
  } finally {
    wake = undefined
    stopNative()
    for (const ready of readiness) ready.close()
    lifetime.beginShutdown()
    try {
      await backend.dispose()
    } catch (error) {
      failed(error)
    }
    clearTimeout(deadline)
    lifetime.detach()
    const result = JSON.stringify({
      event: 'bunly.native.view-parent-close',
      schema: 1,
      passed: failure === null,
      before,
      observations: receipts.snapshot(),
      controlSurvived,
      sessionsReleasedAfterNativeClose,
      nativeFinal,
      final: backend.diagnostics(),
      failure,
      osQuitQualified: false,
      physicalInputQualified: false,
      hardwareDpiQualified: false,
      assistiveTechnologyQualified: false,
      performanceEligible: false,
    })
    assert.ok(Buffer.byteLength(result) <= 8192)
    console.error(result)
  }
  if (failure !== null) throw new Error(failure)
}
