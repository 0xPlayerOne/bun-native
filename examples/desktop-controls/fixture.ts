import assert from 'node:assert/strict'
import {
  BunlyError,
  requireCapability,
  type Bounds,
  type WindowEvent,
  type WindowHandle,
  type WindowState,
  type ViewHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { desktopControlsSchema, type DesktopPageReceipt } from './contract.ts'

/** A finite real-window sequence. Native notifications wake readback; no polling. */
export default async function desktopControls(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Desktop controls fixture deadline')),
    25_000
  )
  const options = { signal: controller.signal }
  let revision = 0
  let wake: (() => void) | undefined
  let view: ViewHandle | undefined
  let page: DesktopPageReceipt | undefined
  let closedEvents = 0
  let eventCount = 0
  let stateEvents = 0
  let boundsEvents = 0
  let abortedDeliveries = 0
  let aborted = false
  const history: WindowEvent[] = []
  const fullscreen: { completed: boolean; state: WindowState }[] = []
  const steps: { name: string; state: WindowState; bounds: Bounds }[] = []
  let nativeFinal: Record<string, number> = {}
  let failure: string | null = null
  let staleRejected = false
  let invalidRejected = false
  let stopWindow: (() => void) | undefined
  let stopAborted: (() => void) | undefined
  const changed = () => {
    revision++
    wake?.()
  }
  const wait = async (seen: number) => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (revision !== seen) return
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        wake = undefined
        controller.signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        finish()
        reject(controller.signal.reason)
      }
      wake = () => {
        finish()
        resolve()
      }
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
      else if (revision !== seen) wake()
    })
  }
  const stopRpc = backend.serveRpc(
    desktopControlsSchema,
    {
      ready: {
        capability: 'desktop-controls-fixture',
        handle: (receipt, context) => {
          assert.equal(context.identity.viewId, view?.id)
          assert.equal(page, undefined, 'Duplicate renderer receipt')
          page = receipt
          changed()
          return null
        },
      },
    },
    ['app://ui'],
    ['desktop-controls-fixture']
  )
  try {
    requireCapability(backend.descriptor, 'window.state')
    requireCapability(backend.descriptor, 'window.geometry')
    // Keep one anchor alive so closing the tested window can be observed before quit.
    await backend.createWindow({
      title: 'Bunly desktop cleanup owner',
      bounds: { x: 16, y: 16, width: 240, height: 160 },
    })
    const window = await backend.createWindow({
      title: 'Bunly desktop controls',
      bounds: { x: 48, y: 48, width: 640, height: 440 },
    })
    stopWindow = backend.onWindowEvent(
      window,
      (event) => {
        if (++eventCount > 256) {
          controller.abort(new Error('Desktop window event budget exceeded'))
          return
        }
        if (history.length === 16) history.shift()
        history.push(event)
        if (event.type === 'state-changed') stateEvents++
        if (event.type === 'bounds-changed') boundsEvents++
        if (event.type === 'closed') closedEvents++
        if (event.type === 'fullscreen-transition') {
          if (fullscreen.length >= 8) {
            controller.abort(new Error('Fullscreen event budget exceeded'))
            return
          }
          fullscreen.push({ completed: event.completed, state: event.state })
        }
        changed()
      },
      options
    )
    const subscription = new AbortController()
    stopAborted = backend.onWindowEvent(
      window,
      () => {
        if (aborted) abortedDeliveries++
      },
      { signal: subscription.signal }
    )
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'desktop' })
    view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    while (!page) await wait(revision)

    const capture = async (
      name: string,
      action: () => Promise<unknown>,
      accepted: (state: WindowState, bounds: Bounds) => boolean
    ) => {
      await action()
      for (let reads = 0; reads < 128; reads++) {
        const seen = revision
        const state = await backend.windowState(window, options)
        const bounds = await backend.windowBounds(window, options)
        if (accepted(state, bounds)) {
          steps.push({ name, state, bounds })
          return
        }
        await wait(seen)
      }
      throw new Error('Desktop readback budget exceeded')
    }
    const ordinary = (state: WindowState) =>
      state.visible && !state.minimized && !state.maximized && !state.fullscreen
    await capture('initial', async () => {}, ordinary)
    const moved = { x: 64, y: 64, width: 704, height: 464 }
    await capture(
      'geometry',
      () => backend.setWindowBounds(window, moved, options),
      (state, bounds) =>
        ordinary(state) && Object.entries(moved).every(([k, v]) => bounds[k as keyof Bounds] === v)
    )
    await capture(
      'resize',
      () => backend.resizeWindow(window, 736, 496),
      (state, bounds) => ordinary(state) && bounds.width === 736 && bounds.height === 496
    )
    await capture(
      'hidden',
      () => backend.showWindow(window, false),
      (state) => !state.visible
    )
    await capture('shown', () => backend.showWindow(window, true), ordinary)
    await capture(
      'minimized',
      () => backend.minimizeWindow(window, options),
      (state) => state.minimized
    )
    await capture('restored', () => backend.restoreWindow(window, options), ordinary)
    await capture(
      'maximized',
      () => backend.maximizeWindow(window, options),
      (state) => state.maximized && !state.fullscreen
    )
    await capture('unmaximized', () => backend.restoreWindow(window, options), ordinary)
    await capture(
      'fullscreen',
      () => backend.setWindowFullscreen(window, true, options),
      (state) =>
        state.fullscreen && fullscreen.some((event) => event.completed && event.state.fullscreen)
    )
    await capture(
      'windowed',
      () => backend.setWindowFullscreen(window, false, options),
      (state) =>
        ordinary(state) && fullscreen.some((event) => event.completed && !event.state.fullscreen)
    )
    // Activation is a request; OS refusal is retained as actual state, never invented success.
    await capture('activation-request', () => backend.activateWindow(window, options), ordinary)
    aborted = true
    subscription.abort()
    await capture(
      'after-unsubscribe',
      () => backend.setWindowBounds(window, moved, options),
      (state, bounds) =>
        ordinary(state) && bounds.width === moved.width && bounds.height === moved.height
    )
    assert.equal(abortedDeliveries, 0)
    assert.ok(stateEvents > 0 && boundsEvents > 0, 'Native state and bounds events are required')
    await assert.rejects(
      backend.setWindowBounds(window, { ...moved, x: 0.5 }, options),
      (error: unknown) => error instanceof BunlyError && error.code === 'INVALID_ARGUMENT'
    )
    await assert.rejects(backend.windowBounds({ ...window } as WindowHandle, options))
    invalidRejected = true
    await backend.drainRpc(view)
    await backend.closeWindow(window)
    assert.equal(closedEvents, 1)
    await assert.rejects(backend.windowState(window, options))
    await assert.rejects(backend.windowBounds(window, options))
    staleRejected = true
    await backend.disposeSession(session)
    await stopRpc()
    const final = (await backend.nativeDiagnostics()) as Record<string, unknown>
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
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(deadline)
    stopAborted?.()
    stopWindow?.()
    try {
      await stopRpc()
    } catch (error) {
      failure ??= String(error)
    }
    try {
      await backend.dispose()
    } catch (error) {
      failure ??= String(error)
    }
    console.error(
      JSON.stringify({
        event: 'bunly.native.desktop-controls',
        schema: 1,
        passed: failure === null,
        steps,
        page: page ?? null,
        events: {
          count: eventCount,
          state: stateEvents,
          bounds: boundsEvents,
          last: history,
          fullscreen,
          closed: closedEvents,
          afterAbort: abortedDeliveries,
        },
        invalidRejected,
        staleRejected,
        nativeFinal,
        failure,
        physicalInputQualified: false,
        hardwareDpiQualified: false,
        performanceEligible: false,
      })
    )
  }
  if (failure) throw new Error(failure)
}
