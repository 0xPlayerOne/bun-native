import assert from 'node:assert/strict'
import { Probe, deferred, bounded } from './probe.ts'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { BinaryStreamWriter } from '../../packages/contracts/src/streams.ts'
import type { CefBackend, CefStreamConnection } from '../../packages/runtime/src/cef.ts'
import {
  TerminalService,
  type TerminalDriver,
  type TerminalHandle,
} from '../../packages/runtime/src/terminal.ts'
import { TERMINAL_COLS, TERMINAL_ROWS } from '../cef-terminal/terminal-contract.ts'
import { BATCHES, LOAD } from './workload.ts'
import { schema, loadMode, type receipt, type diagnostic } from './contract.ts'
import { LOAD_PROFILE } from './profile.ts'
import { expectedVisibility, requireLoadMode } from './mode-state.ts'
import { awaitWindowMode } from './window-modes.ts'

export default async function loadFixture(backend: CefBackend) {
  const selected = loadMode(process.env['BUNLY_TERMINAL_LOAD_MODE'])
  const windowed = LOAD_PROFILE === 'windowed'
  const expectedPage = expectedVisibility(selected)
  let observedVisibility: 'visible' | 'hidden' = 'visible'
  let changingWindow = true
  const output = process.env['BUNLY_TERMINAL_LOAD_OUTPUT']
  assert.ok(output)
  // Native installation/profile admission must precede fixture output creation.
  // There is no standalone fallback when guardian selection or verification fails.
  const delegate = await backend.createTerminalDriver({ profile: 'non-detaching' })
  const raw = await open(output, 'wx', 0o600)
  const record = async (value: object) => {
    await raw.write(JSON.stringify(value) + '\n')
  }
  const probes = [new Probe(), new Probe()]
  const driver: TerminalDriver = {
    spawn(options, observer) {
      const probe = probes[Number(options.env['BUNLY_TERMINAL_INDEX'])]
      assert.ok(probe)
      return delegate.spawn(options, {
        ...observer,
        output: (chunk) => {
          probe.add(chunk)
          observer.output(chunk)
        },
      })
    },
  }
  const service = new TerminalService({
    driver,
    limits: {
      maxTerminals: 2,
      maxTerminalsPerOwner: 2,
      maxOutputBytes: 64 * 1024,
      maxOutputBytesPerOwner: 64 * 1024,
      maxOutputBytesPerTerminal: 32 * 1024,
    },
  })
  const ready = deferred<void>()
  const connected = deferred<void>()
  const visibility = deferred<void>()
  const finished = [deferred<unknown>(), deferred<unknown>()]
  const received = new Set<number>()
  let receipts = [deferred<ReturnType<typeof receipt>>(), deferred<ReturnType<typeof receipt>>()]
  let connection: CefStreamConnection | undefined
  let phase = 'startup'
  let operation = 'startup'
  const consumers: (ReturnType<typeof diagnostic> | null)[] = [null, null]
  const progress = [-1, -1]
  let diagnosticCount = 0
  let streamState: (() => unknown) | undefined
  let activeBatch = -1
  const handles: TerminalHandle[] = []
  let queueBytes = 0
  let queueFrames = 0
  const visibilityReceipts: string[] = []
  const nativeEvents: object[] = []
  const stopObserver = backend.observe((event) => {
    if (
      ![
        'rpc.packet',
        'stream.packet',
        'rpc.revoked',
        'stream.revoked',
        'view.navigating',
        'view.loaded',
        'view.closed',
      ].includes(event.event)
    )
      return
    nativeEvents.push({
      event: event.event,
      phase,
      batch: activeBatch,
      atMs: performance.now(),
      sequence: event.data?.['sequence'] ?? null,
      copiedBytes: event.data?.['copiedBytes'] ?? null,
    })
    if (nativeEvents.length > 16) nativeEvents.shift()
  })
  let stopRpc: (() => void | Promise<void>) | undefined
  let stopStreams: (() => void) | undefined
  try {
    let view: Awaited<ReturnType<CefBackend['createView']>> | undefined
    const owner = (id: string) => {
      assert.ok(connection && view && connection.view === view && id === view.id)
    }
    stopRpc = backend.serveRpc(
      schema,
      {
        diagnostic: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            assert.ok(++diagnosticCount <= 2 * (BATCHES + 1) * (LOAD.maxCallbacksPerBatch * 3 + 10))
            consumers[value.terminal] = value
            return null
          },
        },
        ready: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            assert.equal(value, 'visible')
            visibilityReceipts.push('initial-visible')
            ready.resolve()
            return null
          },
        },
        visibility: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            if (!windowed || !changingWindow) assert.equal(value, expectedPage)
            observedVisibility = value
            assert.ok(visibilityReceipts.length < 8, 'Window visibility callback bound')
            visibilityReceipts.push(value)
            visibility.resolve()
            return null
          },
        },
        progress: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            assert.equal(value, activeBatch)
            progress[0] = value
            progress[1] = progress[1]! + 1
            return value
          },
        },
        consumed: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            assert.equal(value.batch, activeBatch)
            assert.equal(value.visibility, expectedPage)
            assert.ok(!received.has(value.terminal), 'Duplicate consumer receipt')
            received.add(value.terminal)
            receipts[value.terminal]!.resolve(value)
            return null
          },
        },
        finished: {
          capability: 'terminal-load',
          handle(value, context) {
            owner(context.identity.viewId)
            assert.equal(value.records, 1)
            finished[value.terminal]!.resolve(value)
            return null
          },
        },
      },
      ['app://ui'],
      ['terminal-load']
    )
    stopStreams = backend.serveStreams(['app://ui'], (current) => {
      assert.equal(connection, undefined)
      connection = current
      void (async () => {
        const sender = current.sender({ timeoutMs: 15_000 })
        streamState = () => sender.diagnostics()
        for (let index = 0; index < LOAD.terminals; index++) {
          const writer = await sender.open(`load-${index}`, { signal: current.signal })
          const probe = probes[index]!
          const wrapped: BinaryStreamWriter = {
            finished: writer.finished,
            async write(chunk) {
              probe.written += chunk.length
              probe.streamCallbacks++
              const pending = writer.write(chunk)
              const diagnostics = sender.diagnostics()
              queueBytes = Math.max(queueBytes, diagnostics.queuedBytes)
              queueFrames = Math.max(queueFrames, diagnostics.queuedFrames)
              probe.pending = pending
              await pending
              probe.acknowledged += chunk.length
            },
            end: () => writer.end(),
            cancel: () => writer.cancel(),
          }
          handles.push(
            await service.create(current.view, wrapped, {
              executable: process.execPath,
              cwd: fileURLToPath(new URL('../..', import.meta.url)),
              argv: [fileURLToPath(new URL('./terminal-child.js', import.meta.url))],
              env: { BUNLY_TERMINAL_INDEX: String(index) },
              cols: TERMINAL_COLS,
              rows: TERMINAL_ROWS,
              maxOutputBytes: LOAD.maxBatchBytes,
              maxQueuedOutputChunks: 8,
              signal: current.signal,
            })
          )
        }
        connected.resolve()
      })().catch((error) => connected.reject(error))
    })
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'terminal-load',
    })
    const window = await backend.createWindow({
      title: 'Bunly sustained graphical terminal qualification',
      bounds: { x: 16, y: 16, width: 900, height: 640 },
    })
    view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await bounded(Promise.all([connected.promise, ready.promise]))
    let backgroundWindow: Awaited<ReturnType<CefBackend['createWindow']>> | undefined
    let admittedWindow: ReturnType<typeof requireLoadMode> | undefined
    const initialWindow = windowed
      ? requireLoadMode('visible', await backend.windowState(window), observedVisibility)
      : undefined
    if (windowed) {
      if (selected === 'background') {
        backgroundWindow = await backend.createWindow({
          title: 'Bunly owned background-focus fixture',
          bounds: { x: 960, y: 16, width: 160, height: 160 },
        })
      }
      admittedWindow = await awaitWindowMode(
        backend,
        window,
        selected,
        () => observedVisibility,
        async () => {
          if (selected === 'hidden') await backend.showWindow(window, false)
          else if (selected === 'minimized') await backend.minimizeWindow(window)
          else if (backgroundWindow) await backend.activateWindow(backgroundWindow)
          else await backend.activateWindow(window)
        },
        connection?.signal
      )
    } else {
      await backend.showWindow(window, selected === 'visible')
      if (selected === 'hidden') await bounded(visibility.promise)
    }
    changingWindow = false
    const modeSnapshot = async () =>
      requireLoadMode(selected, await backend.windowState(window), observedVisibility)
    await record({
      kind: 'start',
      schema: windowed ? 2 : 1,
      ...(windowed ? { windowMode: { initial: initialWindow, admitted: admittedWindow } } : {}),
      terminalOwnership: 'native-non-detaching',
      workload: LOAD,
      mode: selected,
      visibilityReceipts,
      visibilityAuthority: windowed
        ? 'owned-native-state-readback + authenticated-renderer-visibility; activation notifications are hints only'
        : 'native-exact-window-show-hide + document.visibilitychange; OS focus/minimize not inferred',
    })
    const encoder = new TextEncoder()
    for (const definition of LOAD.phases) {
      phase = definition.name
      console.error(JSON.stringify({ event: 'bunly.terminal-load.phase', schema: 1, phase }))
      const phaseStart = performance.now()
      const started = activeBatch + 1
      for (let index = 0; index < definition.batches; index++) {
        // Fixed offered cadence, with no catch-up burst and at most one batch per
        // terminal outstanding. Delays are reported; work is never dropped.
        const due = phaseStart + index * definition.intervalMs
        if (performance.now() < due) await Bun.sleep(due - performance.now())
        activeBatch++
        received.clear()
        receipts = [deferred(), deferred()]
        for (const probe of probes) probe.reset()
        const begin = performance.now()
        await Promise.all(
          handles.map((handle) => service.write(handle, encoder.encode(`batch:${activeBatch}\n`)))
        )
        operation = 'consumer-receipts'
        const accepted = await bounded(
          Promise.all(receipts.map((entry) => entry.promise)),
          connection?.signal
        )
        operation = 'stream-ack'
        await bounded(Promise.all(probes.map((probe) => probe.pending)), connection?.signal)
        const acknowledgedAt = performance.now()
        const triggerToConsumptionAckMs = acknowledgedAt - begin
        for (let terminal = 0; terminal < LOAD.terminals; terminal++) {
          const consumer = accepted[terminal]!
          const probe = probes[terminal]!
          assert.equal(consumer.bytes, probe.bytes)
          assert.equal(consumer.bytes, probe.acknowledged)
          const runtimeSha256 = probe.hash.digest('hex')
          assert.equal(consumer.sha256, runtimeSha256)
          assert.equal(consumer.callbacks, probe.streamCallbacks)
          await record({
            kind: 'batch',
            phase,
            ...consumer,
            runtimeCallbacks: probe.callbacks,
            runtimePendingBytePeak: probe.pendingBytePeak,
            ptyCallbackToConsumptionAckMs: acknowledgedAt - probe.firstCallbackMs,
            runtimeBytes: probe.bytes,
            acknowledgedBytes: probe.acknowledged,
            streamCallbacks: probe.streamCallbacks,
            runtimeSha256,
            triggerToConsumptionAckMs,
            scheduleLagMs: Math.max(0, begin - due),
            terminalBudget: service.diagnostics(),
            queueBytes,
            queueFrames,
          })
        }
      }
      const remaining = phaseStart + definition.batches * definition.intervalMs - performance.now()
      if (remaining > 0) await Bun.sleep(remaining)
      await record({
        kind: 'phase',
        phase,
        batches: activeBatch + 1 - started,
        ...(windowed ? { windowMode: await modeSnapshot() } : {}),
        elapsedMs: performance.now() - phaseStart,
      })
    }
    assert.equal(activeBatch + 1, BATCHES)
    for (const probe of probes) probe.reset()
    await Promise.all(handles.map((handle) => service.write(handle, encoder.encode('exit\n'))))
    operation = 'final-records'
    const final = await bounded(
      Promise.all(finished.map((entry) => entry.promise)),
      connection?.signal
    )
    operation = 'exit-output-release'
    const exits = await bounded(
      Promise.all(
        handles.map(async (handle, index) => {
          const observed = service.observe(handle)
          const processExit = await observed.processExited
          const terminalClose = await observed.terminalClosed
          const output = await observed.outputFinished
          await observed.released
          const probe = probes[index]!
          assert.deepEqual(final[index], {
            terminal: index,
            records: 1,
            bytes: probe.bytes,
            sha256: probe.hash.digest('hex'),
          })
          assert.equal(processExit.exitCode, 0)
          assert.deepEqual(output, { ok: true })
          return { processExit, terminalClose, output, released: true, final: final[index] }
        })
      )
    )
    let finalWindow:
      | { loaded: ReturnType<typeof requireLoadMode>; restored: ReturnType<typeof requireLoadMode> }
      | undefined
    if (windowed) {
      const loaded = await modeSnapshot()
      changingWindow = true
      const restored = await awaitWindowMode(
        backend,
        window,
        'foreground',
        () => observedVisibility,
        async () => {
          await backend.restoreWindow(window)
          await backend.showWindow(window, true)
          await backend.activateWindow(window)
        },
        connection?.signal
      )
      finalWindow = { loaded, restored }
      if (backgroundWindow) await backend.closeWindow(backgroundWindow)
    }
    await backend.disposeView(view)
    await backend.disposeSession(session)
    await stopRpc()
    stopRpc = undefined
    stopStreams()
    stopStreams = undefined
    const native = await backend.nativeDiagnostics()
    await record({
      kind: 'complete',
      ...(windowed ? { windowMode: finalWindow } : {}),
      batches: BATCHES,
      terminalOwnership: 'native-non-detaching',
      exits,
      terminalBudget: service.diagnostics(),
      streamBudget: backend.streamDiagnostics(),
      native,
      queueBytes,
      queueFrames,
    })
    console.error(
      JSON.stringify({
        event: 'bunly.native.terminal-load',
        schema: windowed ? 3 : 2,
        terminalOwnership: 'native-non-detaching',
        mode: selected,
        batches: BATCHES,
        complete: true,
      })
    )
  } catch (error) {
    await record({
      kind: 'failure',
      phase,
      batch: activeBatch,
      operation,
      classification:
        error instanceof Error && 'code' in error
          ? String(error.code)
          : error instanceof Error && error.message === 'Load operation deadline'
            ? 'WORKLOAD_DEADLINE'
            : 'WORKLOAD_FAILURE',
      error: error instanceof Error ? error.message : String(error),
      pendingConsumers: [0, 1].filter((index) => !received.has(index)),
      consumers,
      progress,
      diagnosticCount,
      visibilityReceipts,
      ack: probes.map((probe) => ({
        bytes: probe.bytes,
        written: probe.written,
        acknowledged: probe.acknowledged,
        callbacks: probe.callbacks,
        streamCallbacks: probe.streamCallbacks,
      })),
      terminalBudget: service.diagnostics(),
      streamBudget: backend.streamDiagnostics(),
      sender: streamState?.(),
      rpc: backend.rpcDiagnostics(),
      nativeEvents,
      connectionAborted: connection?.signal.aborted ?? null,
      connectionReason: connection?.signal.aborted
        ? String(connection.signal.reason).slice(0, 240)
        : null,
      snapshotTiming:
        'after workload error, before fixture cleanup; protocol revocation may already have drained queues',
      transport: backend.nativeTransportDiagnostics(),
      native: await backend
        .nativeDiagnostics()
        .catch((failure: unknown) => ({ unavailable: String(failure).slice(0, 240) })),
    })
    throw error
  } finally {
    stopObserver()
    await stopRpc?.()
    stopStreams?.()
    await service.dispose()
    await backend.dispose()
    await raw.close()
  }
}
