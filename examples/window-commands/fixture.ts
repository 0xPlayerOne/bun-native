import assert from 'node:assert/strict'
import type {
  PolicyScope,
  WindowCommandsDefinition,
  WindowCommandsHandle,
  WindowHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { managedDocumentReadiness } from '../managed-desktop/document-readiness.ts'
import { CommandObservations } from './observations.ts'
import { WINDOW_COMMAND_WORKLOAD_MS, windowCommandFixtureEvents } from './contract.ts'
import { formatDesktopFixtureFailure } from '../../benchmarks/desktop/failure-codes.ts'

const definition: WindowCommandsDefinition = {
  commands: [
    {
      id: 'record',
      label: 'Record native command',
      shortcut: { key: 'K', control: true, shift: true },
    },
    { id: 'disabled', label: 'Disabled command', enabled: false },
  ],
  // Only one enabled menu entry makes native Down/Return deterministic without
  // assuming an initial hover/selection or a particular pointer position.
  menu: [
    { type: 'command', command: 'record' },
    { type: 'command', command: 'disabled' },
  ],
}
const code = (expected: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'name' in error &&
  error.name === 'BunlyError' &&
  'code' in error &&
  error.code === expected

async function activate(
  backend: CefBackend,
  window: WindowHandle,
  signal: AbortSignal
): Promise<void> {
  let resolve!: () => void, reject!: (error: Error) => void
  const observed = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void observed.catch(() => {})
  const stop = backend.onWindowEvent(
    window,
    (event) => {
      if (event.type === 'state-changed' && event.state.active) resolve()
      if (event.type === 'closed') reject(new Error('Command owner window closed'))
    },
    { signal }
  )
  const abort = () => reject(new Error('Command owner activation deadline'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const state = await backend.activateWindow(window, { signal })
    if (!state.active) await observed
    assert.equal((await backend.windowState(window, { signal })).active, true)
  } finally {
    stop()
    signal.removeEventListener('abort', abort)
  }
}

/** Contributor-only entry. The outer qualifier chooses a disposable runner and
 * a host built with rpc-qualification. An ordinary renderer cannot enable input.
 */
export default async function qualifyWindowCommands(backend: CefBackend): Promise<void> {
  const started = performance.now()
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Window commands qualification deadline')),
    WINDOW_COMMAND_WORKLOAD_MS
  )
  const options = { signal: controller.signal }
  let stage = 'ready',
    failure: string | null = null,
    shutdownRequested = false,
    shutdownSucceeded = false
  let denied = false,
    forged = false,
    oversized = false,
    duplicate = false,
    stale = false,
    abortReleased = false,
    disposedOpenMenu = false
  let commands: WindowCommandsHandle | undefined
  let observations: CommandObservations | undefined
  let nativeFinal: Record<string, number> | null = null
  let final: {
    readonly registrations: number
    readonly shortcuts: number
    readonly popups: number
  } | null = null
  const receipt: { type: string; sequence: number; command?: string; source?: string }[] = []
  const aborted = () => {
    failure ??= formatDesktopFixtureFailure('commands', stage, controller.signal.reason)
  }
  controller.signal.addEventListener('abort', aborted, { once: true })
  void backend.closed.then(
    () => {
      if (!shutdownRequested) controller.abort(new Error('Unexpected native close'))
    },
    () => controller.abort(new Error('Native command host failed'))
  )
  try {
    await backend.whenApplicationReady(options)
    assert.ok(backend.descriptor.capabilities.includes('window.commands'))
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'window-commands',
    })
    const window = await backend.createWindow({
      title: 'Bunly native window commands qualification',
      bounds: { x: 40, y: 40, width: 640, height: 480 },
    })
    const readiness = managedDocumentReadiness(backend, 'app://ui/index.html')
    const abortReady = () => readiness.close(new Error('Command document deadline'))
    controller.signal.addEventListener('abort', abortReady, { once: true })
    let view
    try {
      view = await backend.createView({
        window,
        session,
        url: 'app://ui/index.html',
        trust: { kind: 'application', origin: 'app://ui' },
      })
      await readiness.wait(view)
    } finally {
      controller.signal.removeEventListener('abort', abortReady)
      readiness.close()
    }
    const scope = await backend.capturePolicyScope(view)
    stage = 'policy'
    await assert.rejects(backend.createWindowCommands(scope, definition), code('PERMISSION_DENIED'))
    denied = true
    await assert.rejects(
      backend.createWindowCommands({} as PolicyScope, definition),
      code('PERMISSION_DENIED')
    )
    forged = true
    await backend.grantNativeCapability(scope, { name: 'window-commands' })
    await assert.rejects(
      backend.createWindowCommands(scope, {
        commands: Array.from({ length: 33 }, (_, index) => ({
          id: `command-${index}`,
          label: 'Bounded',
        })),
        menu: [],
      }),
      code('INVALID_ARGUMENT')
    )
    oversized = true
    commands = await backend.createWindowCommands(scope, definition, options)
    await assert.rejects(backend.createWindowCommands(scope, definition), code('RESOURCE_IN_USE'))
    duplicate = true
    observations = new CommandObservations(controller.signal)
    backend.onWindowCommandsEvent(commands, (event) => observations!.receive(event), options)
    stage = 'shortcut'
    await activate(backend, window, controller.signal)
    await backend.qualifyWindowCommands(commands, 'shortcut', 'record')
    await observations.take('command', 'shortcut')
    stage = 'selected-menu'
    await backend.qualifyWindowCommands(commands, 'select-first')
    await backend.showWindowMenu(commands, { x: 40, y: 40 }, options)
    await observations.take('menu-shown')
    await observations.take('command', 'menu')
    await observations.take('menu-closed')
    stage = 'cancelled-menu'
    const popupOwner = new AbortController()
    await backend.showWindowMenu(commands, { x: 40, y: 40 }, { signal: popupOwner.signal })
    await observations.take('menu-shown')
    popupOwner.abort()
    await observations.take('menu-closed')
    stage = 'dispose-open-menu'
    await backend.showWindowMenu(commands, { x: 40, y: 40 }, options)
    await observations.take('menu-shown')
    await backend.disposeWindowCommands(commands)
    disposedOpenMenu = true
    observations.assertDrained()
    receipt.push(...observations.events)
    assert.deepEqual(receipt, windowCommandFixtureEvents)
    observations.close()
    observations = undefined
    assert.deepEqual(await backend.qualifyWindowCommandsSnapshot(), {
      registrations: 0,
      shortcuts: 0,
      popups: 0,
    })
    stage = 'abort-owner'
    const owner = new AbortController()
    const abortedCommands = await backend.createWindowCommands(scope, definition, {
      signal: owner.signal,
    })
    owner.abort()
    await backend.disposeWindowCommands(abortedCommands)
    assert.deepEqual(await backend.qualifyWindowCommandsSnapshot(), {
      registrations: 0,
      shortcuts: 0,
      popups: 0,
    })
    abortReleased = true
    stage = 'stale-document'
    commands = await backend.createWindowCommands(scope, definition, options)
    await backend.navigate(view, 'app://ui/index.html?retired=1', options)
    await assert.rejects(backend.showWindowMenu(commands, { x: 40, y: 40 }), code('DISPOSED'))
    await assert.rejects(backend.createWindowCommands(scope, definition), code('PERMISSION_DENIED'))
    await backend.disposeWindowCommands(commands)
    stale = true
    final = await backend.qualifyWindowCommandsSnapshot()
    assert.deepEqual(final, { registrations: 0, shortcuts: 0, popups: 0 })
    assert.deepEqual(backend.windowCommandsDiagnostics(), {
      registrations: 0,
      listeners: 0,
      popups: 0,
    })
    assert.equal(backend.diagnostics().listenerErrors, 0)
    stage = 'native-cleanup'
    await backend.disposeView(view)
    await backend.disposeSession(session)
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    nativeFinal = {}
    for (const key of [
      'views',
      'sessions',
      'windows',
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
    stage = 'quit'
    shutdownRequested = true
    await backend.dispose()
    shutdownSucceeded = true
    controller.signal.throwIfAborted()
  } catch (error) {
    failure ??= formatDesktopFixtureFailure('commands', stage, error)
  } finally {
    if (observations) {
      // Preserve the actual bounded prefix when a waiter rejects. The exact
      // seven-event acceptance gate above still requires the complete workload.
      receipt.splice(0, receipt.length, ...observations.events)
      observations.close()
    }
    shutdownRequested = true
    try {
      await backend.dispose()
      shutdownSucceeded = true
    } catch (error) {
      failure ??= formatDesktopFixtureFailure('commands', 'cleanup', error)
    }
    clearTimeout(deadline)
    controller.signal.removeEventListener('abort', aborted)
    const sdkFinal = backend.diagnostics()
    if (Object.values(sdkFinal).some((value) => value !== 0))
      failure ??= formatDesktopFixtureFailure('commands', 'sdk-cleanup', undefined)
    const workloadMs = performance.now() - started
    if (controller.signal.aborted || workloadMs > WINDOW_COMMAND_WORKLOAD_MS)
      failure ??= formatDesktopFixtureFailure(
        'commands',
        'workload-deadline',
        controller.signal.reason
      )
    console.error(
      JSON.stringify({
        event: 'bunly.native.window-commands',
        schema: 1,
        passed: failure === null,
        workloadMs,
        input: { syntheticNative: true, physical: false },
        denied,
        forged,
        oversized,
        duplicate,
        stale,
        abortReleased,
        disposedOpenMenu,
        observations: receipt,
        final,
        nativeFinal,
        sdkFinal,
        shutdownSucceeded,
        failure,
        physicalInputQualified: false,
        hardwareDpiQualified: false,
        assistiveTechnologyQualified: false,
        performanceEligible: false,
      })
    )
  }
  if (failure !== null) throw new Error(`Native window commands qualification failed: ${failure}`)
}
