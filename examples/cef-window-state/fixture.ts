import assert from 'node:assert/strict'
import type { CefBackend, CefWindowState } from '../../packages/runtime/src/cef.ts'
import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import { visibilitySchema, type PageVisibility } from './contract.ts'

export default async function qualifyWindowState(backend: CefBackend): Promise<void> {
  const pages: PageVisibility[] = []
  const actions: { mode: string; state: CefWindowState }[] = []
  let nativeFinal: Record<string, number> | null = null
  const modes: {
    mode: string
    state: CefWindowState
    page: PageVisibility
    actionState: CefWindowState | null
  }[] = []
  let view: ViewHandle | undefined
  let changed: (() => void) | undefined
  const controller = new AbortController()
  // One fixed request-sized deadline for this small functional sequence. Never extended.
  const deadline = setTimeout(
    () => controller.abort(new Error('Window mode qualification deadline')),
    10_000
  )
  const stop = backend.serveRpc(
    visibilitySchema,
    {
      visibility: {
        capability: 'window-mode-fixture',
        handle: (receipt, context) => {
          assert.equal(
            context.identity.viewId,
            view?.id,
            'Visibility must come from the owned view'
          )
          assert.equal(receipt.sequence, pages.length)
          assert.ok(pages.length < 16)
          pages.push(receipt)
          changed?.()
          return null
        },
      },
    },
    ['app://ui'],
    ['window-mode-fixture']
  )
  const page = async (index: number, visibility: 'hidden' | 'visible') => {
    if (!pages[index])
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          changed = undefined
          controller.signal.removeEventListener('abort', abort)
        }
        const abort = () => {
          finish()
          reject(controller.signal.reason)
        }
        changed = () => {
          finish()
          resolve()
        }
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
      })
    assert.equal(pages[index]?.visibility, visibility, 'Independent page visibility mismatch')
    return pages[index]!
  }
  let failure: string | null = null
  try {
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'window-state',
    })
    const window = await backend.createWindow({
      title: 'Bunly window state',
      bounds: { x: 32, y: 32, width: 640, height: 480 },
    })
    view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const capture = async (
      mode: string,
      visible: boolean,
      minimized: boolean,
      actionState: CefWindowState | null = null
    ) => {
      if (actionState) actions.push({ mode, state: actionState })
      const observedPage = await page(modes.length, visible && !minimized ? 'visible' : 'hidden')
      const state = await backend.windowState(window, { signal: controller.signal })
      // Retain mismatches before asserting. Minimized visibility is platform-specific.
      modes.push({ mode, state, page: observedPage, actionState })
      if (!minimized) assert.equal(state.visible, visible)
      assert.equal(state.minimized, minimized)
      assert.equal(state.maximized, false)
      assert.equal(state.fullscreen, false)
    }
    await capture('visible', true, false)
    await backend.showWindow(window, false)
    await capture('hidden', false, false)
    await backend.showWindow(window, true)
    await capture('shown', true, false)
    await capture(
      'minimized',
      false,
      true,
      await backend.minimizeWindow(window, { signal: controller.signal })
    )
    await capture(
      'restored',
      true,
      false,
      await backend.restoreWindow(window, { signal: controller.signal })
    )
    await backend.disposeView(view)
    await backend.disposeSession(session)
    await stop()
    // Closing the last window initiates host shutdown; take final resource diagnostics first.
    const final = (await backend.nativeDiagnostics()) as Record<string, unknown>
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
      assert.equal(final[key], key === 'windows' ? 1 : 0)
      nativeFinal[key] = Number(final[key])
    }
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    clearTimeout(deadline)
    console.error(
      JSON.stringify({
        event: 'bunly.native.window-modes',
        schema: 1,
        passed: failure === null,
        modes,
        pages,
        actions,
        nativeFinal,
        failure,
      })
    )
    await stop()
    await backend.dispose()
  }
}
