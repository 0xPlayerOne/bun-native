import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type {
  BinaryStreamSink,
  BinaryStreamWriter,
  StreamOutcome,
} from '../packages/contracts/src/streams.ts'
import {
  TerminalService,
  type TerminalDriverObserver,
  type TerminalDriverProcess,
  type TerminalHandle,
} from '../packages/runtime/src/terminal.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('actual renderer holds consumption before overload and releases the failed stream', async () => {
  const entry = fileURLToPath(
    new URL('../examples/cef-terminal/terminal-client.ts', import.meta.url)
  )
  // Execute the actual renderer and record parser against xterm. Substitute only
  // its DOM/CEF edges; admission, callback coalescing and scheduling are real.
  const shims: Readonly<Record<string, string>> = {
    '@xterm/xterm': 'export const Terminal = globalThis.fixture.Terminal',
    '../../packages/client/src/rpc.ts': `export class RpcClient {
      call(...args) { return globalThis.fixture.rpc(...args) }
      close() {}
    }`,
    '../../packages/client/src/cef-rpc.ts':
      'export const waitForCefRpcTransport = async () => ({})',
    '../../packages/client/src/cef-streams.ts':
      'export const waitForCefStreamTransport = async () => ({})',
    '../../packages/contracts/src/streams.ts': `export class BinaryStreamReceiver {
      constructor(_transport, _options, consumers) { globalThis.fixture.connect(consumers) }
      close() { globalThis.fixture.abort.abort() }
    }`,
  }
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'actual-renderer-fixture-edges',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.importer === entry && Object.hasOwn(shims, args.path)
              ? { path: args.path, namespace: 'fixture-edge' }
              : undefined
          )
          build.onLoad({ filter: /.*/, namespace: 'fixture-edge' }, (args) => ({
            contents: shims[args.path]!,
            loader: 'js',
          }))
        },
      },
    ],
  })
  expect(built.success).toBe(true)
  const events: string[] = []
  const consumerFailures: string[] = []
  const rendererFailures: string[] = []
  const connected = deferred<TerminalHandle>()
  const finished = deferred<StreamOutcome>()
  const abort = new AbortController()
  const encoder = new TextEncoder()
  const signals: NodeJS.Signals[] = []
  const pagehide: Array<() => void> = []
  const tasks = new Set<ReturnType<typeof setTimeout>>()
  let observer!: TerminalDriverObserver
  let consume!: BinaryStreamSink['consume']
  let completedWrites = 0
  let ended = 0
  let cancelled = 0
  let terminalCloses = 0
  let rendererDisposals = 0
  const queueOutput = (action: string) => {
    if (action !== 'stall' && action !== 'overload')
      throw new Error(`Unexpected terminal action: ${action}`)
    const task = setTimeout(() => {
      tasks.delete(task)
      events.push(`producer:${action}`)
      if (action === 'stall') observer.output(encoder.encode('stall\r\n'))
      else {
        // PTY callbacks need not align with child records. These callbacks can
        // overflow the 32 KiB source before its scheduled consumer ever enters.
        observer.output(new Uint8Array(16 * 1024))
        observer.output(new Uint8Array(16 * 1024))
        observer.output(new Uint8Array([1]))
      }
    }, 0)
    tasks.add(task)
  }
  const service = new TerminalService({
    driver: {
      spawn(_options, callbacks): TerminalDriverProcess {
        observer = callbacks
        return {
          write(bytes) {
            queueOutput(new TextDecoder().decode(bytes).trim())
            return bytes.byteLength
          },
          resize() {},
          signal(signal) {
            signals.push(signal)
            callbacks.processExited({ exitCode: null, signalCode: signal, waitError: false })
          },
          closeTerminal() {
            terminalCloses++
            callbacks.terminalClosed(0)
          },
        }
      },
    },
  })
  const writer: BinaryStreamWriter = {
    finished: finished.promise,
    async write(bytes) {
      events.push(`consumer:${bytes.byteLength}`)
      try {
        await consume(bytes, { signal: abort.signal, streamId: 1 })
        completedWrites++
      } catch (error) {
        consumerFailures.push(String(error))
        throw error
      }
    },
    async end() {
      ended++
      finished.resolve({ ok: true })
    },
    cancel() {
      cancelled++
      abort.abort()
      finished.resolve({ ok: false, code: 'CANCELLED' })
    },
  }
  const fixture = {
    abort,
    Terminal: class extends HeadlessTerminal {
      open() {}
      override dispose() {
        rendererDisposals++
        super.dispose()
      }
    },
    connect(consumers: Readonly<Record<string, BinaryStreamSink>>) {
      consume = consumers['overload-0']!.consume
      void service
        .create({}, writer, {
          executable: process.execPath,
          cwd: import.meta.dir,
          maxOutputBytes: 32 * 1024,
          maxQueuedOutputChunks: 8,
        })
        .then((handle) => {
          connected.resolve(handle)
          const payload = btoa(JSON.stringify({ type: 'ready', tty: true }))
          observer.output(encoder.encode(`\r\nBUNLYTERM|0|${payload}|END\r\n`))
        })
        .catch(connected.reject)
    },
    async rpc(method: string, request: { readonly action: string }) {
      if (method !== 'control') throw new Error(`Unexpected RPC: ${method}`)
      const handle = await connected.promise
      events.push(`control:${request.action}`)
      await service.write(handle, encoder.encode(`${request.action}\n`))
      return null
    },
  }
  try {
    // Isolate browser globals so this test can run with the rest of the suite.
    const execution = runInNewContext(`(async () => {\n${await built.outputs[0]!.text()}\n})()`, {
      fixture,
      URL,
      performance,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      AbortController,
      atob,
      btoa,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      location: { href: 'app://ui/index.html?role=overload' },
      document: {
        querySelector: () => ({ append() {} }),
        createElement: () => ({ dataset: {} }),
      },
      addEventListener: (name: string, listener: () => void) => {
        if (name === 'pagehide') pagehide.push(listener)
      },
      console: {
        log: (value: string) => events.push(`log:${value}`),
        error: (value: string) => rendererFailures.push(value),
      },
    }) as Promise<void>
    void execution.catch((error) => rendererFailures.push(String(error)))
    const observation = service.observe(await connected.promise)
    expect(await observation.outputFinished).toEqual({ ok: false, code: 'OVERLOADED' })
    await observation.released
    const marker = 'log:BUNLY_TERMINAL_OVERLOAD_PENDING'
    expect(events).toContain(marker)
    expect(events).toContain('consumer:7')
    expect(events.indexOf('consumer:7')).toBeLessThan(events.indexOf(marker))
    expect(events.indexOf(marker)).toBeLessThan(events.indexOf('control:overload'))
    expect(events.indexOf('control:overload')).toBeLessThan(events.indexOf('producer:overload'))
    await execution
    expect(rendererFailures).toEqual([])
    expect(consumerFailures).toEqual(['Error: Document stream aborted'])
    expect(completedWrites).toBe(1)
    expect(cancelled).toBe(1)
    expect(ended).toBe(0)
    expect(signals).toEqual(['SIGKILL'])
    expect(terminalCloses).toBe(1)
    expect(await observation.processExited).toMatchObject({
      started: true,
      observed: true,
      signalCode: 'SIGKILL',
      waitError: false,
      failure: null,
    })
    expect(await observation.terminalClosed).toEqual({
      started: true,
      observed: true,
      status: 0,
      failure: null,
    })
    expect(service.diagnostics()).toMatchObject({
      terminals: 0,
      reservedOutputBytes: 0,
      owners: 0,
      sourceReservedBytes: 0,
      sourceStreams: 0,
      spawning: 0,
      live: 0,
      closing: 0,
      pendingDriverWrites: 0,
      driverFailures: 0,
      scheduling: { queueDepth: 0 },
    })
    expect(tasks.size).toBe(0)
  } finally {
    for (const task of tasks) clearTimeout(task)
    for (const listener of pagehide) listener()
    await service.dispose()
  }
  expect(pagehide).toHaveLength(1)
  expect(rendererDisposals).toBe(1)
  expect(service.diagnostics().disposed).toBe(true)
})
