import assert from 'node:assert/strict'
import {
  requireCapability,
  type Bounds,
  type SessionHandle,
  type ViewHandle,
  type ViewPresentationOptions,
  type ViewPresentationState,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import {
  ManagedGenerationOwner,
  type ManagedResource,
} from '../../packages/runtime/src/managed-generations.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import {
  compositionMarker,
  compositionSchema,
  panes,
  type CompositionPage,
  type Pane,
} from './contract.ts'

interface OwnedPane {
  readonly view: ViewHandle
  readonly session: SessionHandle
  readonly document: string
  readonly initial: CompositionPage
  readonly base: ViewPresentationOptions
  retained?: ManagedResource
}

/** Finite native composition qualification; notifications wake observations, never polling. */
export default async function qualifyViewComposition(backend: CefBackend): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('View composition fixture deadline')),
    25_000
  )
  const options = { signal: controller.signal }
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const owned = new Map<Pane, OwnedPane>()
  const received = new Map<string, { document: string; latest: CompositionPage; count: number }>()
  const readiness: ReturnType<typeof managedDocumentReadiness>[] = []
  const stopping = new Map<Pane, { width: number; height: number; after: number }>()
  const steps: {
    name: string
    pane: Pane
    native: ViewPresentationState
    page: Pick<CompositionPage, 'sequence' | 'width' | 'height' | 'visibility' | 'focused'>
  }[] = []
  const focusOrder: Pane[] = []
  const checks = {
    hiddenFocusRejected: false,
    clippedFocusRejected: false,
    nonfocusableRejected: false,
    overlayNavigationRejected: false,
    retiredGenerationRejected: false,
    siblingSurvived: false,
    staleViewRejected: false,
  }
  let nativeFinal: Record<string, number> | null = null
  let failure: string | null = null
  let generationReattachments = 0
  let resizeTransitions = 0
  let revision = 0,
    wake: (() => void) | undefined
  const changed = () => {
    revision++
    wake?.()
  }
  controller.signal.addEventListener(
    'abort',
    () => {
      const error =
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Composition cancelled')
      for (const ready of readiness) ready.close(error)
    },
    { once: true }
  )
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
  void backend.closed.then(
    () => controller.abort(new Error('Composition host closed before completion')),
    (error: unknown) => controller.abort(error)
  )
  const stopRpc = backend.serveRpc(
    compositionSchema,
    {
      observe: {
        capability: 'view-composition-fixture',
        handle: (receipt, context) => {
          try {
            const existing = received.get(context.identity.viewId)
            const pane = owned.get(receipt.pane)
            // Early handshakes are bounded, then bound to the exact opaque created handle.
            assert.ok(existing || received.size < 3)
            if (pane) assert.equal(context.identity.viewId, pane.view.id)
            assert.equal(receipt.sequence, existing?.count ?? 0)
            if (existing) {
              assert.equal(context.identity.documentId, existing.document)
              assert.equal(receipt.instance, existing.latest.instance)
              assert.equal(receipt.pane, existing.latest.pane)
            }
            assert.equal(receipt.form, compositionMarker(receipt.pane))
            assert.equal(receipt.session, compositionMarker(receipt.pane))
            received.set(context.identity.viewId, {
              document: context.identity.documentId,
              latest: receipt,
              count: receipt.sequence + 1,
            })
            changed()
            const finish = stopping.get(receipt.pane)
            return {
              stop:
                finish !== undefined &&
                receipt.sequence > finish.after &&
                receipt.width === finish.width &&
                receipt.height === finish.height &&
                receipt.visibility === 'visible',
            }
          } catch (error) {
            controller.abort(error)
            throw error
          }
        },
      },
    },
    ['app://ui'],
    ['view-composition-fixture']
  )
  const pane = (name: Pane): OwnedPane => {
    const value = owned.get(name)
    assert.ok(value, `Missing owned ${name} pane`)
    return value
  }
  const currentPage = (name: Pane): CompositionPage => {
    const current = pane(name)
    const value = received.get(current.view.id)
    assert.ok(value)
    assert.equal(value.document, current.document)
    assert.equal(value.latest.instance, current.initial.instance)
    assert.equal(backend.state(current.view).documentId, current.document)
    assert.equal(backend.session(current.view), current.session)
    return value.latest
  }
  const capture = async (
    name: string,
    nameOfPane: Pane,
    accepted: (state: ViewPresentationState, page: CompositionPage) => boolean
  ) => {
    for (let reads = 0; reads < 128; reads++) {
      const seen = revision
      const state = await backend.viewPresentation(pane(nameOfPane).view, options)
      const page = currentPage(nameOfPane)
      if (accepted(state, page)) {
        assert.ok(steps.length < 64)
        const { sequence, width, height, visibility, focused } = page
        steps.push({
          name,
          pane: nameOfPane,
          native: state,
          page: { sequence, width, height, visibility, focused },
        })
        return state
      }
      await wait(seen)
    }
    throw new Error('Composition readback budget exceeded')
  }
  const shown = (state: ViewPresentationState, page: CompositionPage): boolean =>
    state.visible &&
    state.drawn &&
    page.visibility === 'visible' &&
    state.viewport.width === page.width &&
    state.viewport.height === page.height &&
    page.width > 0 &&
    page.height > 0
  const present = (name: Pane, value: ViewPresentationOptions) =>
    backend.setViewPresentation(pane(name).view, value, options)
  const focus = async (name: Pane) => {
    await backend.focusView(pane(name).view, options)
    await capture(
      `focus-${name}`,
      name,
      (state, page) => shown(state, page) && state.focused && page.focused
    )
    focusOrder.push(name)
  }
  try {
    requireCapability(backend.descriptor, 'view.composition')
    const window = await backend.createWindow({
      title: 'Bunly native view composition',
      viewLayout: 'manual',
      bounds: { x: 32, y: 32, width: 820, height: 520 },
    })
    const bounds: Record<Pane, Bounds> = {
      left: { x: 24, y: 24, width: 280, height: 220 },
      right: { x: 336, y: 24, width: 280, height: 220 },
      overlay: { x: 180, y: 60, width: 220, height: 140 },
    }
    for (const [index, name] of panes.entries()) {
      const session = await backend.createSession({
        persistence: 'ephemeral',
        partition: `composition-${name}`,
      })
      const url = `app://ui/index.html?pane=${name}`
      const ready = managedDocumentReadiness(backend, url)
      readiness.push(ready)
      const base = { bounds: bounds[name], tabIndex: index }
      const view = await backend.createView({
        window,
        session,
        url,
        presentation: base,
        layer: name === 'overlay' ? 'overlay' : 'content',
        trust: { kind: 'application', origin: 'app://ui' },
      })
      while (!received.has(view.id)) await wait(revision)
      await ready.wait(view)
      const initial = received.get(view.id)!
      assert.equal(initial.latest.pane, name)
      assert.equal(initial.document, backend.state(view).documentId)
      owned.set(name, { view, session, document: initial.document, initial: initial.latest, base })
      const authority = await desktop.captureAuthority(view)
      const retainedSession = desktop.registerSession(`session-${name}`, session, {
        authority,
        permission: 'composition',
        operations: ['identity'],
      })
      pane(name).retained = desktop.registerView(name, view, {
        authority,
        permission: 'composition',
        operations: ['state', 'presentation', 'present', 'focus'],
        dependsOn: [retainedSession],
      })
      await capture(`initial-${name}`, name, shown)
    }
    assert.equal(new Set([...owned.values()].map((entry) => entry.initial.instance)).size, 3)
    assert.equal(new Set([...owned.values()].map((entry) => entry.session.id)).size, 3)

    // Native overlays are real windows in CEF Views; DOM z-index is not used here.
    await backend.activateWindow(window, options)
    await present('overlay', { ...pane('overlay').base, visible: false })
    await capture(
      'overlay-hidden',
      'overlay',
      (state, page) => !state.visible && !state.drawn && page.visibility === 'hidden'
    )
    await focus('left')
    assert.equal(await backend.focusNextView(window, false, options), pane('right').view)
    await capture(
      'forward-tab-order',
      'right',
      (state, page) => shown(state, page) && state.focused && page.focused
    )
    focusOrder.push('right')
    assert.equal(await backend.focusNextView(window, true, options), pane('left').view)
    await capture(
      'reverse-tab-order',
      'left',
      (state, page) => shown(state, page) && state.focused && page.focused
    )
    focusOrder.push('left')

    await present('left', { ...pane('left').base, visible: false })
    await capture(
      'hidden-pane',
      'left',
      (state, page) =>
        !state.visible &&
        !state.drawn &&
        !state.focusable &&
        !page.focused &&
        page.visibility === 'hidden'
    )
    await assert.rejects(
      backend.focusView(pane('left').view, options),
      /hidden|clipped|nonfocusable/
    )
    checks.hiddenFocusRejected = true
    await focus('right')
    await present('left', pane('left').base)
    await capture('restored-pane', 'left', shown)

    await present('right', { ...pane('right').base, focusable: false })
    await assert.rejects(
      backend.focusView(pane('right').view, options),
      /hidden|clipped|nonfocusable/
    )
    checks.nonfocusableRejected = true
    await capture(
      'nonfocusable-pane',
      'right',
      (state, page) => shown(state, page) && !state.focusable && !state.focused && !page.focused
    )
    await focus('left')
    assert.equal(await backend.focusNextView(window, false, options), null)
    await present('right', pane('right').base)

    await present('left', { ...pane('left').base, clip: { x: 24, y: 24, width: 196, height: 164 } })
    await capture(
      'clipped-viewport',
      'left',
      (state, page) => shown(state, page) && page.width === 196 && page.height === 164
    )
    await present('left', {
      ...pane('left').base,
      clip: { x: 1200, y: 1200, width: 10, height: 10 },
    })
    await capture(
      'fully-clipped-pane',
      'left',
      (state, page) =>
        !state.visible &&
        !state.drawn &&
        !state.focusable &&
        state.viewport.width === 0 &&
        state.viewport.height === 0 &&
        page.visibility === 'hidden'
    )
    await assert.rejects(
      backend.focusView(pane('left').view, options),
      /hidden|clipped|nonfocusable/
    )
    checks.clippedFocusRejected = true
    await present('left', pane('left').base)
    await capture('clip-cleared', 'left', shown)

    await backend.resizeWindow(window, 500, 400)
    await capture(
      'window-clips-pane',
      'right',
      (state, page) => shown(state, page) && state.viewport.width < 280
    )
    await backend.resizeWindow(window, 820, 520)
    await capture(
      'window-restores-pane',
      'right',
      (state, page) => shown(state, page) && page.width === 280 && page.height === 220
    )
    await focus('right')
    for (let index = 0; index < 16; index++) {
      await present('left', {
        ...pane('left').base,
        bounds: { ...bounds.left, width: 240 + index * 3 },
      })
      resizeTransitions++
    }
    await capture(
      'rapid-resize-final',
      'left',
      (state, page) => shown(state, page) && page.width === 285
    )
    await capture(
      'resize-preserves-sibling-focus',
      'right',
      (state, page) => shown(state, page) && state.focused && page.focused
    )

    let generation = owner.begin('composition:1', ['composition'])
    for (const binding of Object.values(await desktop.prepare()))
      owner.attach(generation, binding.resource, binding.schema)
    owner.commit(generation, '{"revision":0}')
    for (let index = 1; index <= 2; index++) {
      const previous = generation
      generation = owner.begin('composition:1', ['composition'])
      for (const binding of Object.values(await desktop.prepare()))
        owner.attach(generation, binding.resource, binding.schema)
      owner.commit(generation, JSON.stringify({ revision: index }))
      await assert.rejects(
        owner.invoke(previous, pane('left').retained!, 'presentation', 'null'),
        /RETIRED/
      )
      checks.retiredGenerationRejected = true
      const retained = JSON.parse(
        await owner.invoke(generation, pane('left').retained!, 'presentation', 'null')
      ) as ViewPresentationState
      assert.equal(retained.presentation.bounds.width, 285)
      generationReattachments++
    }
    await owner.invoke(
      generation,
      pane('left').retained!,
      'present',
      JSON.stringify({ presentation: pane('left').base })
    )
    await capture(
      'retained-after-generations',
      'left',
      (state, page) => shown(state, page) && page.width === 280
    )

    await present('overlay', pane('overlay').base)
    await capture('overlay-shown', 'overlay', shown)
    await focus('overlay')
    await assert.rejects(
      backend.navigate(pane('overlay').view, 'https://example.invalid/'),
      /application-owned/
    )
    checks.overlayNavigationRejected = true
    stopping.set('overlay', {
      width: 221,
      height: bounds.overlay.height,
      after: currentPage('overlay').sequence,
    })
    await present('overlay', { ...pane('overlay').base, bounds: { ...bounds.overlay, width: 221 } })
    await capture(
      'overlay-before-close',
      'overlay',
      (state, page) => shown(state, page) && page.width === 221
    )
    await backend.drainRpc(pane('overlay').view)
    await desktop.close('overlay')
    await assert.rejects(backend.viewPresentation(pane('overlay').view, options), /disposed/)
    checks.staleViewRejected = true
    await focus('right')
    await present('right', { ...pane('right').base, bounds: { ...bounds.right, width: 281 } })
    await capture(
      'sibling-after-overlay-close',
      'right',
      (state, page) => shown(state, page) && page.width === 281
    )
    checks.siblingSurvived = true

    for (const name of ['left', 'right'] as const) {
      stopping.set(name, {
        width: 282,
        height: bounds[name].height,
        after: currentPage(name).sequence,
      })
      await present(name, { ...pane(name).base, bounds: { ...bounds[name], width: 282 } })
      await capture(
        `final-${name}`,
        name,
        (state, page) => shown(state, page) && page.width === 282
      )
      await backend.drainRpc(pane(name).view)
    }
    await desktop.dispose()
    owner.dispose()
    stopRpc()
    assert.equal(owner.diagnostics().resources, 0)
    assert.equal(owner.diagnostics().failedCleanup, 0)
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
  } finally {
    for (const ready of readiness) ready.close()
    stopRpc()
    try {
      await desktop.dispose()
    } catch (error) {
      failure ??= String(error)
    }
    owner.dispose()
    try {
      await backend.dispose()
    } catch (error) {
      failure ??= String(error)
    }
    clearTimeout(deadline)
    // The native shutdown receipt precedes the final application line, so shared
    // stderr cannot interleave it with the host's process-stop diagnostic.
    const serialized = JSON.stringify({
      event: 'bunly.native.view-composition',
      schema: 1,
      passed: failure === null,
      observations: {
        steps,
        focusOrder,
        checks,
        resizeTransitions,
        generationReattachments,
        // Keep constant identity/state evidence once per document, rather than
        // repeating it on every resize and exceeding native diagnostic limits.
        pages: Object.fromEntries(
          [...owned].map(([name, entry]) => [
            name,
            {
              viewId: entry.view.id,
              sessionId: entry.session.id,
              documentId: entry.document,
              initial: entry.initial,
              final: received.get(entry.view.id)?.latest ?? null,
              observations: received.get(entry.view.id)?.count ?? 0,
            },
          ])
        ),
      },
      nativeFinal,
      failure,
      physicalInputQualified: false,
      hardwareDpiQualified: false,
      assistiveTechnologyQualified: false,
      performanceEligible: false,
    })
    assert.ok(
      Buffer.byteLength(serialized) <= 16 * 1024,
      'Composition receipt exceeds the existing native diagnostic budget'
    )
    console.error(serialized)
  }
  if (failure !== null) throw new Error(failure)
}
