import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import {
  requireCapability,
  type Bounds,
  type SessionHandle,
  type ViewHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { observeCompositionLifetime } from '../view-composition/lifetime.ts'
import {
  compositionPlan,
  compositionRectangles,
  compositionResize,
  type CompositionPhaseReceipt,
} from './plan.ts'

type Pane = keyof typeof compositionRectangles
interface Owner {
  readonly view: ViewHandle
  readonly session: SessionHandle
}

/** API-driven windowed-CEF resource baseline; never physical or presentation-latency evidence. */
export default async function profileComposition(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Composition profile workload deadline')),
    35_000
  )
  const signal = controller.signal
  const options = { signal }
  const owners = new Map<Pane, Owner>()
  const readiness: ReturnType<typeof managedDocumentReadiness>[] = []
  const phases: CompositionPhaseReceipt[] = []
  const incarnations = { left: 0, right: 0, overlay: 0 }
  let failure: string | null = null
  let nativeFinal: Record<string, number> | null = null
  let pendingPhase: string | null = null
  let stopWindow = () => {}
  const failed = (error: unknown) => {
    const name =
      error instanceof Error &&
      ['Error', 'AssertionError', 'BunlyError', 'AbortError'].includes(error.name)
        ? error.name
        : 'unclassified'
    failure ??= `${pendingPhase ?? 'setup-or-cleanup'}: ${name}`
  }
  const lifetime = observeCompositionLifetime(backend.closed, controller, failed)
  const bounded = <T>(operation: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  const until = async (target: number) => {
    for (;;) {
      signal.throwIfAborted()
      const remaining = target - performance.now()
      if (remaining <= 0) return
      await wait(Math.ceil(remaining), undefined, { signal })
    }
  }
  const owner = (name: Pane) => {
    const current = owners.get(name)
    assert.ok(current, 'Missing composition pane')
    return current
  }
  const inspect = async (name: Pane, bounds: Bounds, visible = true) => {
    const current = owner(name)
    const state = await backend.viewPresentation(current.view, options)
    assert.equal(state.visible, visible)
    assert.equal(state.drawn, visible)
    assert.equal(state.layer, name === 'overlay' ? 'overlay' : 'content')
    assert.deepEqual(state.presentation.bounds, bounds)
    if (visible) assert.deepEqual(state.viewport, bounds)
    return state
  }
  const dispose = async (name: Pane) => {
    const current = owner(name)
    await bounded(backend.disposeView(current.view))
    await bounded(backend.disposeSession(current.session))
    owners.delete(name)
  }
  const mark = (phase: string) =>
    console.error(JSON.stringify({ event: 'bunly.composition.phase', schema: 1, phase }))
  try {
    requireCapability(backend.descriptor, 'view.composition')
    requireCapability(backend.descriptor, 'window.state')
    const window = await bounded(
      backend.createWindow({
        title: 'Bunly — descriptive composition profile',
        bounds: { x: 40, y: 40, width: 820, height: 600 },
        viewLayout: 'manual',
      })
    )
    const create = async (name: Pane) => {
      const session = await bounded(
        backend.createSession({
          persistence: 'ephemeral',
          partition: `composition-profile-${name}-${incarnations[name]}`,
        })
      )
      const url = `app://ui/index.html?pane=${name}&generation=${incarnations[name]}`
      const ready = managedDocumentReadiness(backend, url)
      readiness.push(ready)
      const view = await bounded(
        backend.createView({
          window,
          session,
          url,
          trust: { kind: 'application', origin: 'app://ui' },
          layer: name === 'overlay' ? 'overlay' : 'content',
          presentation: {
            bounds: compositionRectangles[name],
            visible: name !== 'overlay',
          },
        })
      )
      owners.set(name, { view, session })
      await bounded(ready.wait(view))
      await inspect(name, compositionRectangles[name], name !== 'overlay')
      incarnations[name]++
    }
    for (const name of ['left', 'right', 'overlay'] as const) await create(name)
    stopWindow = backend.onWindowEvent(window, (event) => {
      if (
        event.type === 'closed' ||
        event.type === 'bounds-changed' ||
        !event.state.visible ||
        event.state.minimized
      )
        controller.abort(new Error('Profile window eligibility changed'))
    })
    const started = performance.now()
    for (const phase of compositionPlan) {
      pendingPhase = phase.name
      const state = await backend.windowState(window, options)
      assert.equal(state.visible, true, 'Profile window must remain visible')
      assert.equal(state.minimized, false, 'Profile window must not be minimized')
      const phaseStart = performance.now()
      mark(`composition-${phase.name}`)
      const operationMs: number[] = []
      for (let index = 0; index < phase.operations; index++) {
        await until(phaseStart + index * phase.cadenceMs)
        const operationStart = performance.now()
        if (phase.name === 'resize') {
          const bounds = compositionResize(index)
          await backend.setViewPresentation(owner('left').view, { bounds }, options)
          await inspect('left', bounds)
        } else if (phase.name === 'overlay') {
          const visible = index % 2 === 0
          await backend.setViewPresentation(
            owner('overlay').view,
            { bounds: compositionRectangles.overlay, visible },
            options
          )
          await inspect('overlay', compositionRectangles.overlay, visible)
        } else if (phase.name === 'recreate') {
          // CEF requires content before overlays. Include this cost in the declared cycle.
          await dispose('overlay')
          await dispose('left')
          await create('left')
          await create('overlay')
          await inspect('right', compositionRectangles.right)
        }
        operationMs.push(performance.now() - operationStart)
      }
      await until(phaseStart + phase.durationMs)
      phases.push({
        name: phase.name,
        startedMs: phaseStart - started,
        endedMs: performance.now() - started,
        operationMs,
        visible: state.visible,
        minimized: state.minimized,
        activeAtStart: state.active,
      })
    }
    pendingPhase = null
    mark('composition-complete')
    for (const name of ['overlay', 'left', 'right'] as const) await dispose(name)
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
    stopWindow()
    for (const ready of readiness) ready.close()
    lifetime.beginShutdown()
    try {
      await backend.dispose()
    } catch (error) {
      failed(error)
    }
    clearTimeout(deadline)
    lifetime.detach()
    const receipt = JSON.stringify({
      event: 'bunly.native.composition-profile',
      schema: 1,
      passed: failure === null,
      phases,
      incarnations,
      nativeFinal,
      final: backend.diagnostics(),
      failure,
      pendingPhase,
      physicalInputQualified: false,
      hardwareDpiQualified: false,
      assistiveTechnologyQualified: false,
      gpuMeasured: false,
      performanceEligible: false,
    })
    assert.ok(Buffer.byteLength(receipt) <= 16 * 1024)
    console.error(receipt)
  }
  if (failure !== null) throw new Error(failure)
}
