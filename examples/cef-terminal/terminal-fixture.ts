import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { BinaryStreamWriter, StreamOutcome } from '../../packages/contracts/src/streams.ts'
import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend, CefStreamConnection } from '../../packages/runtime/src/cef.ts'
import type { RpcContext, RpcHandlers } from '../../packages/runtime/src/rpc.ts'
import {
  BunTerminalDriver,
  TerminalService,
  type TerminalClosure,
  type TerminalDriver,
  type TerminalDriverObserver,
  type TerminalDriverSpawnOptions,
  type TerminalHandle,
  type TerminalObservation,
} from '../../packages/runtime/src/terminal.ts'
import {
  RESIZED_COLS,
  RESIZED_ROWS,
  TERMINAL_COLS,
  TERMINAL_COUNT,
  TERMINAL_RECORDS,
  TERMINAL_ROWS,
  terminalRpcLimits,
  terminalSchema,
  type TerminalControl,
  type TerminalPageReport,
} from './terminal-contract.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

class WriterProbe implements BinaryStreamWriter {
  callbacks = 0
  bytes = 0
  peakQueuedBytes = 0
  peakQueuedFrames = 0
  constructor(
    readonly writer: BinaryStreamWriter,
    readonly diagnostics: () => { readonly queuedBytes: number; readonly queuedFrames: number }
  ) {}
  get finished(): Promise<StreamOutcome> {
    return this.writer.finished
  }
  async write(chunk: Uint8Array): Promise<void> {
    this.callbacks++
    this.bytes += chunk.byteLength
    const pending = this.writer.write(chunk)
    const queue = this.diagnostics()
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, queue.queuedBytes)
    this.peakQueuedFrames = Math.max(this.peakQueuedFrames, queue.queuedFrames)
    await pending
  }
  end(): Promise<void> {
    return this.writer.end()
  }
  cancel(): void {
    this.writer.cancel()
  }
}

class PtyCallbackProbe {
  readonly hash = createHash('sha256')
  callbacks = 0
  bytes = 0
  add(chunk: Uint8Array): void {
    this.callbacks++
    this.bytes += chunk.byteLength
    assert.ok(
      this.bytes <= 2 * 1024 * 1024 && this.callbacks <= 4096,
      'Bounded fixture callback accounting'
    )
    this.hash.update(chunk)
  }
  checksum(): string {
    return this.hash.digest('hex')
  }
}

class CapturingTerminalDriver implements TerminalDriver {
  readonly delegate = new BunTerminalDriver()
  readonly probes = new Map<string, PtyCallbackProbe>()
  spawn(options: TerminalDriverSpawnOptions, observer: TerminalDriverObserver) {
    const token = options.env['BUNLY_TERMINAL_FIXTURE']
    assert.ok(token && !this.probes.has(token))
    const probe = new PtyCallbackProbe()
    this.probes.set(token, probe)
    return this.delegate.spawn(options, {
      ...observer,
      output: (chunk) => {
        probe.add(chunk)
        observer.output(chunk)
      },
    })
  }
}

interface OwnedTerminal {
  readonly handle: TerminalHandle
  readonly observation: TerminalObservation
  readonly writer: WriterProbe
  readonly callbacks: PtyCallbackProbe
}
interface ViewTerminals {
  readonly view: ViewHandle
  readonly role: 'main' | 'navigate' | 'overload'
  ready: Promise<void>
  readonly terminals: OwnedTerminal[]
  failure?: Error
}

const child = fileURLToPath(new URL('./terminal-child.js', import.meta.url))
const cwd = fileURLToPath(new URL('../..', import.meta.url))
const line = (value: string) => new TextEncoder().encode(value + '\n')

export default async function terminalFixture(backend: CefBackend): Promise<void> {
  Error.stackTraceLimit = 4
  const driver = new CapturingTerminalDriver()
  const service = new TerminalService({
    driver,
    limits: {
      maxTerminals: 8,
      maxTerminalsPerOwner: 2,
      maxOutputBytes: 256 * 1024,
      maxOutputBytesPerOwner: 64 * 1024,
      maxOutputBytesPerTerminal: 32 * 1024,
      closeTimeoutMs: 5_000,
      operationTimeoutMs: 5_000,
    },
  })
  const views = new Map<string, ViewTerminals>()
  const pageReport = deferred<TerminalPageReport>()
  const gateEvents: string[] = []
  const pendingWaits = new Set<() => void>()
  let failure: Error | undefined
  let stopRpc: (() => void | Promise<void>) | undefined
  let stopStreams: (() => void) | undefined
  const fail = (error: Error) => {
    failure ??= error
  }
  const waitConsole = (message: string) => {
    let remove = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = deferred<void>()
    const close = () => {
      remove()
      if (timer !== undefined) clearTimeout(timer)
      pendingWaits.delete(close)
    }
    remove = backend.observe((event) => {
      if (event.event === 'view.console' && event.data?.['message'] === message) {
        close()
        result.resolve()
      }
      if (
        event.event === 'view.console' &&
        typeof event.data?.['message'] === 'string' &&
        event.data['message'].startsWith('BUNLY_TERMINAL_FAILED:')
      ) {
        close()
        const error = new Error(event.data['message'])
        fail(error)
        result.reject(error)
      }
    })
    timer = setTimeout(() => {
      close()
      const error = new Error('Missing terminal fixture marker: ' + message)
      fail(error)
      result.reject(error)
    }, 15_000)
    pendingWaits.add(close)
    return result.promise
  }
  const owned = (context: RpcContext): ViewTerminals => {
    const state = views.get(context.identity.viewId)
    if (!state) throw new Error('RPC view does not own terminal resources')
    return state
  }
  const command = async (state: ViewTerminals, request: TerminalControl) => {
    await state.ready
    const terminal = state.terminals[request.terminal]
    if (!terminal) throw new Error('Terminal is not owned by this native RPC view')
    if (request.action === 'cancel') {
      await service.cancel(terminal.handle)
      return
    }
    if (request.action === 'resize') {
      service.resize(terminal.handle, 80, 24)
      service.resize(terminal.handle, 120, 40)
      service.resize(terminal.handle, 90, 30)
      service.resize(terminal.handle, RESIZED_COLS, RESIZED_ROWS)
      await service.write(terminal.handle, line('resize'))
      return
    }
    if (request.action === 'input')
      await service.write(terminal.handle, line('input:' + request.value))
    else if (request.action === 'emit') {
      assert.equal(Number(request.value), TERMINAL_RECORDS)
      await service.write(terminal.handle, line('emit:' + request.value))
    } else await service.write(terminal.handle, line(request.action))
  }
  const handlers: RpcHandlers<typeof terminalSchema> = {
    control: {
      capability: 'terminal-fixture',
      handle: async (request, context) => {
        await command(owned(context), request)
        return null
      },
    },
    gate: {
      capability: 'terminal-fixture',
      handle: (event, context) => {
        assert.equal(owned(context).role, 'main')
        const name = event.name + ':' + event.action
        assert.ok(!gateEvents.includes(name))
        gateEvents.push(name)
        return event.action
      },
    },
    progress: {
      capability: 'terminal-fixture',
      handle: (_none, context) => {
        assert.equal(owned(context).role, 'main')
        return 'progress'
      },
    },
    report: {
      capability: 'terminal-fixture',
      handle: (report, context) => {
        assert.equal(owned(context).role, 'main')
        pageReport.resolve(report)
        return null
      },
    },
  }
  const connect = (connection: CefStreamConnection) => {
    const url = new URL(backend.state(connection.view).url)
    const role = url.searchParams.get('role')
    if (role !== 'main' && role !== 'navigate' && role !== 'overload')
      throw new Error('Unknown terminal stream role')
    const sender = connection.sender({ timeoutMs: 15_000 })
    const state: ViewTerminals = {
      view: connection.view,
      role,
      terminals: [],
      ready: Promise.resolve(),
    }
    const count = role === 'main' ? TERMINAL_COUNT : 1
    state.ready = (async () => {
      for (let index = 0; index < count; index++) {
        const name = role === 'main' ? `terminal-${index}` : `${role}-0`
        const writer = new WriterProbe(await sender.open(name, { signal: connection.signal }), () =>
          sender.diagnostics()
        )
        const token = `fixed-${role}-${index}`
        const handle = await service.create(connection.view, writer, {
          executable: process.execPath,
          cwd,
          argv: [child],
          env: { BUNLY_TERMINAL_FIXTURE: token },
          cols: TERMINAL_COLS,
          rows: TERMINAL_ROWS,
          signal: connection.signal,
          maxOutputBytes: 32 * 1024,
          maxQueuedOutputChunks: 8,
        })
        const callbacks = driver.probes.get(token)
        assert.ok(callbacks)
        const observation = service.observe(handle)
        // A failed normal output stream is a fixture failure, not a missing
        // marker to wait for until the page deadline. Negative controls below
        // retain their explicitly expected cancellation/overload outcomes.
        void observation.outputFinished.then((result) => {
          if (role === 'main' && !result.ok) {
            const error = new Error('Main terminal output failed: ' + result.code)
            fail(error)
            pageReport.reject(error)
          }
        })
        state.terminals.push({ handle, observation, writer, callbacks })
      }
    })().catch((error) => {
      state.failure = error instanceof Error ? error : new Error(String(error))
      fail(state.failure)
      throw state.failure
    })
    void state.ready.catch(() => {})
    views.set(connection.view.id, state)
  }

  let session: Awaited<ReturnType<CefBackend['createSession']>> | undefined
  let window: Awaited<ReturnType<CefBackend['createWindow']>> | undefined
  const created: ViewHandle[] = []
  try {
    stopStreams = backend.serveStreams(['app://ui'], connect)
    stopRpc = backend.serveRpc(terminalSchema, handlers, ['app://ui'], ['terminal-fixture'], {
      limits: terminalRpcLimits,
    })
    session = await backend.createSession({ persistence: 'ephemeral', partition: 'terminals' })
    window = await backend.createWindow({
      title: 'Bunly graphical terminal qualification',
      bounds: { x: 16, y: 16, width: 900, height: 640 },
    })
    const create = async (role: ViewTerminals['role']) => {
      const view = await backend.createView({
        window: window!,
        session: session!,
        url: `app://ui/index.html?role=${role}`,
        trust: { kind: 'application', origin: 'app://ui' },
      })
      created.push(view)
      return view
    }

    const navigationPending = waitConsole('BUNLY_TERMINAL_NAVIGATION_PENDING')
    const mainComplete = waitConsole('BUNLY_TERMINAL_MAIN_COMPLETE')
    const mainView = await create('main')
    const navigateView = await create('navigate')
    await navigationPending
    const navigationState = views.get(navigateView.id)
    assert.ok(navigationState)
    await navigationState.ready
    await backend.navigate(navigateView, 'about:blank')
    const navigationTerminal = navigationState.terminals[0]!
    const [navigationExit, navigationClose, navigationOutput] = await Promise.all([
      navigationTerminal.observation.processExited,
      navigationTerminal.observation.terminalClosed,
      navigationTerminal.observation.outputFinished,
      navigationTerminal.observation.released,
    ])

    await Promise.all([mainComplete, pageReport.promise])
    const mainState = views.get(mainView.id)
    assert.ok(mainState)
    await mainState.ready
    const mainObserved = await Promise.all(
      mainState.terminals.map(async (terminal) => ({
        processExit: await terminal.observation.processExited,
        terminalClose: await terminal.observation.terminalClosed,
        terminalEof: await terminal.observation.terminalClosed.then((closure: TerminalClosure) =>
          closure.status === 0 ? 'clean-status-0' : 'linux-status-1-ambiguous'
        ),
        output: await terminal.observation.outputFinished,
        released: await terminal.observation.released.then(() => true),
        callbackBytes: terminal.callbacks.bytes,
        callbackCount: terminal.callbacks.callbacks,
        callbackSha256: terminal.callbacks.checksum(),
        streamWriteCount: terminal.writer.callbacks,
      }))
    )

    const overloadPending = waitConsole('BUNLY_TERMINAL_OVERLOAD_PENDING')
    const overloadView = await create('overload')
    await overloadPending
    const overloadState = views.get(overloadView.id)
    assert.ok(overloadState)
    await overloadState.ready
    const overloadTerminal = overloadState.terminals[0]!
    const [overloadExit, overloadClose, overloadOutput] = await Promise.all([
      overloadTerminal.observation.processExited,
      overloadTerminal.observation.terminalClosed,
      overloadTerminal.observation.outputFinished,
      overloadTerminal.observation.released,
    ])

    for (const view of created.reverse()) await backend.disposeView(view).catch(() => {})
    await backend.disposeSession(session)
    session = undefined
    const stop = stopRpc
    assert.ok(stop)
    await stop()
    stopRpc = undefined
    const stopStreamService = stopStreams
    assert.ok(stopStreamService)
    stopStreamService()
    stopStreams = undefined
    const terminalDiagnostics = service.diagnostics()
    const streamDiagnostics = backend.streamDiagnostics()
    const writers = [...views.values()].flatMap((state) => state.terminals.map((row) => row.writer))
    const queuePeaks = {
      frames: Math.max(0, ...writers.map((writer) => writer.peakQueuedFrames)),
      bytes: Math.max(0, ...writers.map((writer) => writer.peakQueuedBytes)),
    }
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    assert.equal(failure, undefined)
    console.error(
      JSON.stringify({
        event: 'bunly.native.graphical-terminal',
        schema: 2,
        classification: 'functional',
        renderer: await pageReport.promise,
        runtime: {
          terminals: mainObserved,
          navigation: {
            exactOwner: navigateView.id !== mainView.id,
            processExit: navigationExit,
            terminalClose: navigationClose,
            output: navigationOutput,
            released: true,
            siblingCompleted: true,
          },
          overload: {
            processExit: overloadExit,
            terminalClose: overloadClose,
            output: overloadOutput,
            released: true,
            callbackBytes: overloadTerminal.callbacks.bytes,
            callbackCount: overloadTerminal.callbacks.callbacks,
          },
        },
        gates: gateEvents,
        budgets: { terminal: terminalDiagnostics, stream: streamDiagnostics },
        queuePeaks,
        nativeFinal: {
          windows: native['windows'],
          views: native['views'],
          sessions: native['sessions'],
          streamIncomingBytes: native['streamIncomingBytes'],
        },
        viewModes: {
          foreground: 'visible-window-exercised',
          background: 'NOT_QUALIFIED-no-maintained-native-visibility-control',
          minimized: 'NOT_QUALIFIED-no-maintained-native-minimize-control',
        },
        baseline: 'NOT_CLAIMED-no-identical-baseline-workload',
      })
    )
  } finally {
    for (const close of pendingWaits) close()
    await stopRpc?.()
    stopStreams?.()
    await service.dispose()
    for (const view of created.reverse()) await backend.disposeView(view).catch(() => {})
    if (session) await backend.disposeSession(session).catch(() => {})
    await backend.dispose()
  }
}
