import assert from 'node:assert/strict'
import type { ApplicationEvent, ApplicationState } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import {
  hasBunlyCode,
  qualifyClipboardText,
  type ClipboardFixtureReceipt,
} from './clipboard-fixture.ts'

/** Launched only by the outer contributor qualifier. Clipboard execution requires
 * its explicit disposable-hosted-runner precondition before native launch.
 */
export default async function qualifyDesktopServices(backend: CefBackend): Promise<void> {
  const events: ApplicationEvent[] = []
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Desktop services qualification deadline')),
    10_000
  )
  const options = { signal: controller.signal }
  let clipboard: ClipboardFixtureReceipt | { readonly status: 'unsupported' } | null = null
  let staleScopeRejected = false,
    ready = false,
    eventOverflow = false
  let nativeFinal: Record<string, number> | null = null
  let final: ApplicationState | null = null
  let stage = 'ready',
    failure: string | null = null,
    stop = () => {}
  const aborted = () => {
    failure ??= stage
  }
  controller.signal.addEventListener('abort', aborted, { once: true })
  try {
    const initial = await backend.whenApplicationReady(options)
    assert.equal(initial.phase, 'running')
    assert.equal(initial.quitRequested, false)
    ready = true
    stop = backend.onApplicationEvent((event) => {
      if (events.length === 4) eventOverflow = true
      else events.push(event)
    })
    const session = await backend.createSession({
      partition: 'desktop-services',
      persistence: 'ephemeral',
    })
    const window = await backend.createWindow({
      title: 'Bunly desktop services qualification',
      bounds: { x: 32, y: 32, width: 640, height: 480 },
    })
    const createReadyView = async (url: string) => {
      controller.signal.throwIfAborted()
      const readiness = managedDocumentReadiness(backend, url)
      const abort = () => readiness.close(new Error('Desktop services document deadline'))
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        const view = await backend.createView({
          window,
          session,
          url,
          trust: { kind: 'application', origin: 'app://ui' },
        })
        await readiness.wait(view)
        return view
      } finally {
        controller.signal.removeEventListener('abort', abort)
        readiness.close()
      }
    }
    stage = 'clipboard'
    const primary = await createReadyView('app://ui/index.html')
    const scope = await backend.capturePolicyScope(primary)
    if (backend.descriptor.capabilities.includes('clipboard.text')) {
      clipboard = await qualifyClipboardText(backend, scope, controller.signal)
    } else {
      assert.equal(process.platform, 'linux', 'Unexpected missing native clipboard adapter')
      const unsupported = hasBunlyCode('UNSUPPORTED_CAPABILITY')
      await assert.rejects(backend.readClipboardText(scope, options), unsupported)
      await assert.rejects(backend.writeClipboardText(scope, 'unsupported', options), unsupported)
      await assert.rejects(backend.clearClipboard(scope, options), unsupported)
      clipboard = { status: 'unsupported' }
    }
    stage = 'stale-scope'
    const child = await createReadyView('app://ui/index.html?scope=stale')
    const stale = await backend.capturePolicyScope(child)
    await backend.grantNativeCapability(stale, { name: 'clipboard-read' })
    await backend.navigate(child, 'app://ui/index.html?scope=retired', options)
    await assert.rejects(
      backend.readClipboardText(stale, options),
      hasBunlyCode('PERMISSION_DENIED')
    )
    staleScopeRejected = true
    await backend.disposeView(child)
    await backend.disposeView(primary)
    await backend.disposeSession(session)
    stage = 'native-cleanup'
    const diagnostics = (await backend.nativeDiagnostics()) as Record<string, unknown>
    nativeFinal = {}
    for (const key of [
      'views',
      'sessions',
      'windows',
      'pending',
      'nativeDeliveryPackets',
      'nativeDeliveryBytes',
      'rpcIncomingBytes',
      'streamIncomingBytes',
    ]) {
      assert.equal(diagnostics[key], key === 'windows' ? 1 : 0)
      nativeFinal[key] = Number(diagnostics[key])
    }
    stage = 'quit'
    await backend.quit()
    final = backend.applicationState()
    assert.deepEqual(events, [
      { type: 'quit-requested' },
      { type: 'quitting', reason: 'requested' },
      { type: 'closed', outcome: 'orderly' },
    ])
    assert.equal(eventOverflow, false)
    assert.deepEqual(final, {
      phase: 'closed',
      quitRequested: true,
      quitReason: 'requested',
      outcome: 'orderly',
    })
    assert.equal(backend.diagnostics().listeners, 0)
    assert.equal(backend.diagnostics().listenerErrors, 0)
  } catch {
    failure = stage
  } finally {
    clearTimeout(deadline)
    stop()
    try {
      await backend.dispose()
    } catch {
      failure ??= 'quit-cleanup'
    }
    controller.signal.removeEventListener('abort', aborted)
    console.error(
      JSON.stringify({
        event: 'bunly.native.desktop-services',
        schema: 1,
        passed: failure === null,
        clipboard,
        staleScopeRejected,
        ready,
        events,
        eventOverflow,
        nativeFinal,
        final,
        failure,
      })
    )
  }
  if (failure !== null) throw new Error(`Desktop services qualification failed: ${failure}`)
}
