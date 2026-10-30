import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SessionHandle,
  ViewHandle,
  ViewPresentationOptions,
  WindowCommandsHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { CommandObservations } from '../window-commands/observations.ts'
import {
  compositionMarker,
  compositionSchema,
  panes,
  type CompositionPage,
  type Pane,
} from './contract.ts'
import { observeCompositionLifetime } from './lifetime.ts'
import {
  COMPOSITION_INTERACTION_WORKLOAD_MS,
  interactionMenuEvents,
  interactionSteps,
  type InteractionFocusObservation,
  type InteractionPaneState,
} from './interactions-plan.ts'

interface OwnedPane {
  readonly view: ViewHandle
  readonly session: SessionHandle
  readonly document: string
  readonly initial: CompositionPage
  readonly presentation: ViewPresentationOptions
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && error.name === 'BunlyError' && 'code' in error && error.code === code

/** A separate finite integration case, preserving the original composition profile.
 * SDK focus and cancellation drive real native widgets; no physical input is injected.
 */
export default async function qualifyCompositionInteractions(backend: CefBackend): Promise<void> {
  const started = performance.now()
  const controller = new AbortController()
  const { signal } = controller
  const options = { signal }
  const deadline = setTimeout(
    () => controller.abort(new Error('Composition interaction deadline')),
    COMPOSITION_INTERACTION_WORKLOAD_MS
  )
  const owned = new Map<Pane, OwnedPane>()
  const received = new Map<string, { document: string; latest: CompositionPage; count: number }>()
  const stopping = new Map<Pane, { after: number; width: number }>()
  const stopped = new Set<Pane>()
  const focus: InteractionFocusObservation[] = []
  let pendingFocus: InteractionFocusObservation | null = null
  const menus: { pane: Pane; events: readonly unknown[] }[] = []
  let dialog: Record<string, unknown> | null = null
  let root: string | undefined
  let failure: string | null = null
  let stage = 'setup'
  let hiddenFocusRejected = false
  let shutdownSucceeded = false
  let nativeFinal: Record<string, number> | null = null
  let menuFinal: unknown = null
  let revision = 0
  let wake: (() => void) | undefined
  const lifetime = observeCompositionLifetime(backend.closed, controller, (error) => {
    failure ??= `${stage}: ${String(error)}`.slice(0, 1024)
  })
  const changed = () => {
    revision++
    wake?.()
  }
  const bounded = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  const wait = async (seen: number) => {
    signal.throwIfAborted()
    if (revision !== seen) return
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        wake = undefined
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        finish()
        reject(signal.reason)
      }
      wake = () => {
        finish()
        resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (revision !== seen) wake()
    })
  }
  const stopRpc = backend.serveRpc(
    compositionSchema,
    {
      observe: {
        capability: 'view-composition-fixture',
        handle: (page, context) => {
          try {
            const prior = received.get(context.identity.viewId)
            assert.ok(prior || received.size < panes.length)
            const pane = owned.get(page.pane)
            if (pane) assert.equal(context.identity.viewId, pane.view.id)
            assert.equal(page.sequence, prior?.count ?? 0)
            if (prior) {
              assert.equal(context.identity.documentId, prior.document)
              assert.equal(page.pane, prior.latest.pane)
              assert.equal(page.instance, prior.latest.instance)
            }
            assert.equal(page.form, compositionMarker(page.pane))
            assert.equal(page.session, compositionMarker(page.pane))
            received.set(context.identity.viewId, {
              document: context.identity.documentId,
              latest: page,
              count: page.sequence + 1,
            })
            const finish = stopping.get(page.pane)
            const stop =
              finish !== undefined && page.sequence > finish.after && page.width === finish.width
            if (stop) stopped.add(page.pane)
            changed()
            return { stop }
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
  const pane = (name: Pane) => {
    const value = owned.get(name)
    assert.ok(value, `Missing ${name} pane`)
    return value
  }
  const currentPage = (name: Pane) => {
    const current = pane(name)
    const observation = received.get(current.view.id)
    assert.ok(observation)
    assert.equal(observation.document, current.document)
    assert.equal(observation.latest.instance, current.initial.instance)
    assert.equal(backend.state(current.view).documentId, current.document)
    assert.equal(backend.session(current.view), current.session)
    return observation.latest
  }
  const capture = async (name: InteractionFocusObservation['name']) => {
    const expected = interactionSteps.find((step) => step.name === name)!
    stage = name
    await backend.focusView(pane(expected.focused).view, options)
    for (let reads = 0; reads < 128; reads++) {
      const seen = revision
      const states = {} as Record<Pane, InteractionPaneState>
      let accepted = true
      for (const name of panes) {
        const native = await backend.viewPresentation(pane(name).view, options)
        const page = currentPage(name)
        states[name] = {
          nativeFocused: native.focused,
          pageFocused: page.focused,
          visible: native.visible,
          drawn: native.drawn,
          focusable: native.focusable,
          pageVisibility: page.visibility,
          sequence: page.sequence,
        }
        const visible = name !== 'overlay' || expected.overlayVisible
        const focused = name === expected.focused
        accepted &&=
          native.visible === visible &&
          native.drawn === visible &&
          native.focusable === visible &&
          page.visibility === (visible ? 'visible' : 'hidden') &&
          native.focused === focused &&
          page.focused === focused &&
          (!visible ||
            (native.viewport.width === page.width && native.viewport.height === page.height))
      }
      pendingFocus = { name, panes: states }
      if (accepted) {
        focus.push(pendingFocus)
        pendingFocus = null
        return
      }
      await wait(seen)
    }
    throw new Error('Composition focus observation budget exceeded')
  }
  const presentOverlay = (visible: boolean) =>
    backend.setViewPresentation(
      pane('overlay').view,
      { ...pane('overlay').presentation, visible },
      options
    )
  const menu = async (name: Pane, after: (commands: WindowCommandsHandle) => Promise<void>) => {
    stage = `${name}-menu`
    const scope = await bounded(backend.capturePolicyScope(pane(name).view))
    await bounded(backend.grantNativeCapability(scope, { name: 'window-commands' }))
    const commands = await backend.createWindowCommands(
      scope,
      {
        commands: [{ id: 'inspect', label: 'Composition focus owner' }],
        menu: [{ type: 'command', command: 'inspect' }],
      },
      options
    )
    const observations = new CommandObservations(signal)
    const stop = backend.onWindowCommandsEvent(
      commands,
      (event) => observations.receive(event),
      options
    )
    try {
      await backend.showWindowMenu(commands, { x: 40, y: 40 }, options)
      await observations.take('menu-shown')
      await bounded(backend.cancelWindowMenu(commands))
      await observations.take('menu-closed')
      observations.assertDrained()
      assert.deepEqual(observations.events, interactionMenuEvents)
      menus.push({ pane: name, events: [...observations.events] })
      await after(commands)
      observations.assertDrained()
    } finally {
      stop()
      observations.close()
      await backend.disposeWindowCommands(commands)
    }
  }
  try {
    await backend.whenApplicationReady(options)
    for (const capability of ['view.composition', 'window.commands'] as const)
      assert.ok(backend.descriptor.capabilities.includes(capability))
    root = await mkdtemp(join(tmpdir(), 'bunly-composition-interactions-'))
    const window = await backend.createWindow({
      title: 'Bunly composition interaction qualification',
      viewLayout: 'manual',
      bounds: { x: 32, y: 32, width: 820, height: 520 },
    })
    for (const [index, name] of panes.entries()) {
      const session = await backend.createSession({
        persistence: 'ephemeral',
        partition: `interaction-${name}`,
      })
      const url = `app://ui/index.html?pane=${name}`
      const readiness = managedDocumentReadiness(backend, url)
      const presentation = {
        bounds:
          name === 'overlay'
            ? { x: 180, y: 60, width: 220, height: 140 }
            : { x: name === 'left' ? 24 : 336, y: 24, width: 280, height: 220 },
        tabIndex: index,
        visible: name !== 'overlay',
      }
      try {
        const view = await backend.createView({
          window,
          session,
          url,
          presentation,
          layer: name === 'overlay' ? 'overlay' : 'content',
          trust: { kind: 'application', origin: 'app://ui' },
        })
        await bounded(readiness.wait(view))
        while (!received.has(view.id)) await wait(revision)
        const observation = received.get(view.id)!
        assert.equal(observation.latest.pane, name)
        assert.equal(observation.document, backend.state(view).documentId)
        owned.set(name, {
          view,
          session,
          document: observation.document,
          initial: observation.latest,
          presentation,
        })
      } finally {
        readiness.close()
      }
    }
    await backend.activateWindow(window, options)
    await capture('left-ready')
    await menu('left', async () => capture('left-menu-closed'))
    await capture('right-ready')
    await menu('right', async () => capture('right-menu-closed'))
    await presentOverlay(true)
    await capture('overlay-shown')
    await menu('overlay', async (commands) => {
      await capture('overlay-menu-closed')
      stage = 'overlay-dialog'
      const supported = backend.descriptor.capabilities.includes('dialog.file')
      const empty = {
        supported,
        active: 0,
        visible: false,
        admissions: 0,
        callbacks: 0,
        selected: 0,
        cancelled: 0,
        failed: 0,
      }
      const before = await bounded(backend.qualifyFileDialogState())
      assert.deepEqual(before, empty)
      const scope = await bounded(backend.capturePolicyScope(pane('overlay').view))
      const settings = { directory: root!, title: 'Bunly composition cancel-only dialog' }
      if (!supported) {
        await assert.rejects(
          backend.showOpenFileDialog(scope, settings, options),
          hasCode('UNSUPPORTED_CAPABILITY')
        )
        const after = await bounded(backend.qualifyFileDialogState())
        assert.deepEqual(after, empty)
        dialog = {
          status: 'unsupported',
          before,
          visible: null,
          after,
          menuRejectedWhileOpen: false,
        }
        return
      }
      await bounded(backend.grantNativeCapability(scope, { name: 'dialog-open' }))
      const cancellation = new AbortController()
      const abort = () => cancellation.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const opened = backend.showOpenFileDialog(scope, settings, { signal: cancellation.signal })
      void opened.catch((error: unknown) => controller.abort(error))
      let visible: unknown
      try {
        for (;;) {
          signal.throwIfAborted()
          visible = await bounded(backend.qualifyFileDialogState())
          if ((visible as { visible: boolean }).visible) break
          await bounded(new Promise<void>((resolve) => setTimeout(resolve, 20)))
        }
        assert.deepEqual(visible, { ...empty, active: 1, visible: true, admissions: 1 })
        await assert.rejects(
          backend.showWindowMenu(commands, { x: 40, y: 40 }, options),
          hasCode('RESOURCE_IN_USE')
        )
        cancellation.abort()
        assert.deepEqual(await bounded(opened), { status: 'cancelled' })
      } finally {
        cancellation.abort()
        signal.removeEventListener('abort', abort)
      }
      const after = await bounded(backend.qualifyFileDialogState())
      assert.deepEqual(after, { ...empty, admissions: 1, callbacks: 1, cancelled: 1 })
      dialog = { status: 'cancelled', before, visible, after, menuRejectedWhileOpen: true }
      await capture('overlay-dialog-closed')
    })
    await presentOverlay(false)
    await assert.rejects(
      backend.focusView(pane('overlay').view, options),
      hasCode('PERMISSION_DENIED')
    )
    hiddenFocusRejected = true
    await capture('overlay-hidden')
    await presentOverlay(true)
    await capture('overlay-reopened')
    await presentOverlay(false)
    await capture('overlay-final-hidden')
    menuFinal = await bounded(backend.qualifyWindowCommandsSnapshot())
    assert.deepEqual(menuFinal, { registrations: 0, shortcuts: 0, popups: 0 })
    assert.deepEqual(await readdir(root), [], 'Cancel-only dialogs must not create files')
    stage = 'cleanup'
    // Stop each producer on an authenticated resize receipt before draining RPC.
    // Merely closing a view while its blur event is being delivered is not quiescence.
    for (const name of panes) {
      const current = pane(name)
      const width = current.presentation.bounds.width + 1
      stopping.set(name, { after: currentPage(name).sequence, width })
      await backend.setViewPresentation(
        current.view,
        {
          ...current.presentation,
          visible: true,
          bounds: { ...current.presentation.bounds, width },
        },
        options
      )
      while (!stopped.has(name)) await wait(revision)
      await bounded(backend.drainRpc(current.view))
    }
    stopRpc()
    for (const name of [...panes].reverse()) {
      await backend.disposeView(pane(name).view)
      await backend.disposeSession(pane(name).session)
    }
    const native = (await bounded(backend.nativeDiagnostics())) as Record<string, unknown>
    nativeFinal = {}
    for (const key of [
      'windows',
      'views',
      'sessions',
      'rpcBindings',
      'pending',
      'downloads',
      'nativeDeliveryPackets',
      'nativeDeliveryBytes',
      'rpcIncomingBytes',
      'streamIncomingBytes',
    ]) {
      assert.equal(native[key], key === 'windows' ? 1 : 0)
      nativeFinal[key] = Number(native[key])
    }
  } catch (error) {
    failure ??= `${stage}: ${String(error)}`.slice(0, 1024)
  } finally {
    stopRpc()
    lifetime.beginShutdown()
    try {
      await backend.dispose()
      shutdownSucceeded = true
    } catch (error) {
      failure ??= `shutdown: ${String(error)}`.slice(0, 1024)
    }
    if (root) {
      try {
        await rm(root, { recursive: true, force: true })
      } catch (error) {
        failure ??= `temporary-root: ${String(error)}`.slice(0, 1024)
      }
    }
    const workloadMs = performance.now() - started
    if (workloadMs > COMPOSITION_INTERACTION_WORKLOAD_MS)
      failure ??= 'Composition interaction deadline'
    clearTimeout(deadline)
    lifetime.detach()
    const sdkFinal = backend.diagnostics()
    if (Object.values(sdkFinal).some((value) => value !== 0)) failure ??= 'SDK cleanup incomplete'
    const receipt = JSON.stringify({
      event: 'bunly.native.composition-interactions',
      schema: 1,
      passed: failure === null,
      failure,
      workloadMs,
      focus,
      pendingFocus,
      menus,
      dialog,
      hiddenFocusRejected,
      menuFinal,
      nativeFinal,
      sdkFinal,
      shutdownSucceeded,
      pages: Object.fromEntries(
        [...owned].map(([name, current]) => [
          name,
          {
            viewId: current.view.id,
            sessionId: current.session.id,
            documentId: current.document,
            initial: current.initial,
            final: received.get(current.view.id)?.latest ?? null,
          },
        ])
      ),
      physicalInputQualified: false,
      imeQualified: false,
      hardwareDpiQualified: false,
      assistiveTechnologyQualified: false,
      performanceEligible: false,
    })
    assert.ok(
      Buffer.byteLength(receipt) <= 16 * 1024,
      'Interaction receipt exceeds native diagnostic budget'
    )
    console.error(receipt)
  }
  if (failure !== null) throw new Error(failure)
}
