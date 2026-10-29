import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requireCapability,
  type DownloadOperation,
  type DownloadOutcome,
  type DownloadProgress,
  type ScopedDownloadRequest,
  type ViewHandle,
} from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { remoteDocumentReadiness } from './readiness.ts'
import { downloadFixtureServer } from './server.ts'
import { DOWNLOAD_WORKLOAD_MS, downloadFixtureSteps } from './contract.ts'
import { downloadFixtureFailure } from './failure.ts'

/** Finite real-CEF transfers, including cancellation while the native owner closes. */
export default async function fileDownloads(backend: CefBackend): Promise<void> {
  const started = performance.now()
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('File download fixture deadline')),
    DOWNLOAD_WORKLOAD_MS
  )
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bunly-native-downloads-é-Ω-')))
  if (process.platform !== 'win32') chmodSync(root, 0o700)
  const sentinel = 'unrelated fixture-owned bytes'
  writeFileSync(join(root, 'sentinel.txt'), sentinel, { flag: 'wx', mode: 0o600 })
  const readiness = new Set<ReturnType<typeof remoteDocumentReadiness>>()
  const documents: string[] = []
  const steps: {
    name: string
    outcome: DownloadOutcome
    notifications: number
    positiveProgress: boolean
    sha256: string | null
  }[] = []
  const checks: Record<string, boolean> = {}
  let firstRequestElapsedMs: number | null = null,
    replacementRequestElapsedMs: number | null = null
  // Diagnostic only: admission invocation through verified bytes, hash and stage cleanup.
  const diagnosticElapsed = (since: number): number | null => {
    const elapsed = performance.now() - since
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= DOWNLOAD_WORKLOAD_MS
      ? elapsed
      : null
  }
  let phase = 'setup'
  const failureText = (error: unknown): string => downloadFixtureFailure(phase, error)
  let server: Awaited<ReturnType<typeof downloadFixtureServer>> | undefined,
    failure: string | null = null,
    disposing = false,
    shutdownSucceeded = false,
    temporaryCleanup = false,
    nativeBeforeQuit: Record<string, number> | null = null,
    settledBaseline: Record<string, number> | null = null,
    downloadShutdown: Readonly<Record<string, unknown>> | null = null,
    shutdownReceipts = 0,
    quit:
      | {
          operation: DownloadOperation
          progressed: () => Promise<void>
          complete: () => Promise<DownloadOutcome>
        }
      | undefined
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw controller.signal.reason
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      void promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort))
      if (controller.signal.aborted) abort()
    })
  }
  void backend.closed.then(
    () => {
      if (!disposing) controller.abort(new Error('Download host closed before fixture completion'))
    },
    (error: unknown) => controller.abort(error)
  )
  const stopShutdown = backend.observe((event) => {
    if (event.event === 'app.quitting' && quit) {
      checks['cancelDuringQuitRequested'] = true
      void quit.operation.cancel().catch((error: unknown) => {
        failure ??= failureText(error)
        controller.abort(error)
      })
    }
    if (event.event !== 'download.shutdown') return
    try {
      assert.equal(++shutdownReceipts, 1)
      assert.deepEqual(event.data, {
        schema: 1,
        passed: true,
        admitted: 14,
        terminalCallbacks: 14,
        completed: 3,
        cancelled: 7,
        failed: 4,
        ownedTransfers: 0,
        ownedCallbacks: 0,
        ownedStagingHandles: 0,
        ownedDeadlineWorkers: 0,
      })
      downloadShutdown = event.data!
    } catch (error) {
      failure ??= failureText(error)
      controller.abort(error)
    }
  })
  const ready = (url: string, previous?: string) => {
    const item = remoteDocumentReadiness(backend, url, previous)
    readiness.add(item)
    return {
      wait: async (view: ViewHandle) => {
        try {
          documents.push(await bounded(item.wait(view)))
        } finally {
          item.close()
          readiness.delete(item)
        }
      },
    }
  }
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const destination = (name: string, overwrite: 'deny' | 'replace' = 'deny') => ({
    root,
    name,
    overwrite,
  })
  const request = (
    name: string,
    endpoint = '/small.bin',
    extra: Partial<ScopedDownloadRequest> = {}
  ): ScopedDownloadRequest => ({
    url: server!.origin + endpoint,
    destination: destination(name),
    timeoutMs: 6000,
    ...extra,
  })
  const cleanStage = () =>
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith('.bunly-download-')),
      []
    )
  const grant = async (view: ViewHandle) => {
    const scope = await bounded(backend.capturePolicyScope(view))
    await bounded(backend.grantNativeCapability(scope, { name: 'download', root }))
    return scope
  }
  const native = async () => {
    const value = (await bounded(backend.nativeDiagnostics())) as Record<string, unknown>
    const result: Record<string, number> = {}
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
      assert.ok(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
      result[key] = Number(value[key])
    }
    return result
  }
  const tracked = async (
    view: ViewHandle,
    name: string,
    input: ScopedDownloadRequest,
    signal = controller.signal
  ) => {
    phase = name
    const operation = await bounded(backend.startDownload(view, input, { signal }))
    let notifications = 0,
      positiveProgress = false,
      wake!: () => void
    const positive = new Promise<void>((resolve) => {
      wake = resolve
    })
    const remove = operation.onProgress((state: DownloadProgress) => {
      if (++notifications > 256)
        controller.abort(new Error('Native progress receipt capacity exceeded'))
      if (state.status === 'in-progress' && state.bytesReceived > 0) {
        positiveProgress = true
        wake()
      }
    })
    return {
      operation,
      progressed: () =>
        bounded(
          Promise.race([
            positive,
            operation.completed.then(() => {
              if (!positiveProgress)
                throw new Error('Transfer settled before positive native progress')
            }),
          ])
        ),
      complete: async (bytes?: Uint8Array) => {
        const outcome = await bounded(operation.completed)
        remove()
        if (outcome.status === 'completed') {
          assert.ok(bytes)
          const stored = readFileSync(join(root, input.destination.name))
          assert.equal(outcome.bytesWritten, bytes.length)
          assert.equal(outcome.bytesReceived, bytes.length)
          assert.equal(hash(stored), hash(bytes))
        } else {
          assert.equal(outcome.bytesWritten, 0)
          assert.equal(existsSync(join(root, input.destination.name)), false)
        }
        cleanStage()
        steps.push({
          name,
          outcome,
          notifications,
          positiveProgress,
          sha256: bytes ? hash(bytes) : null,
        })
        return outcome
      },
    }
  }
  try {
    requireCapability(backend.descriptor, 'download.manage')
    server = await downloadFixtureServer({
      html: await Bun.file(new URL('../public/index.html', import.meta.url)).text(),
      client: await Bun.file(new URL('../public/client.js', import.meta.url)).text(),
    })
    const window = await backend.createWindow({
      title: 'Bunly native downloads',
      bounds: { x: 36, y: 36, width: 680, height: 440 },
    })
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'file-downloads',
      network: { allowedOrigins: [server.origin] },
    })
    let url = server.origin + '/document?phase=initial'
    const initial = ready(url)
    const view = await backend.createView({ window, session, url, trust: { kind: 'remote' } })
    await initial.wait(view)
    const firstRequests = server.count('/small.bin')
    await assert.rejects(
      backend.startDownload(view, request('denied.bin')),
      /permission|grant|authority/i
    )
    assert.equal(server.count('/small.bin'), firstRequests)
    checks['permissionDenied'] = true
    const originalScope = await grant(view)
    for (const name of ['../outside', 'CON', 'path/file']) {
      await assert.rejects(backend.startDownload(view, request(name)), {
        name: 'BunlyError',
        code: 'INVALID_ARGUMENT',
      })
    }
    assert.equal(server.count('/small.bin'), firstRequests)
    checks['traversalRejected'] = true
    const otherRoot = join(root, 'not-granted')
    mkdirSync(otherRoot, { mode: 0o700 })
    await assert.rejects(
      backend.startDownload(
        view,
        request('wrong-root.bin', '/small.bin', {
          destination: { ...destination('wrong-root.bin'), root: otherRoot },
        })
      ),
      /permission|grant|authority/i
    )
    checks['rootMismatchRejected'] = true

    // Diagnostic-only first-request probe; the maintained fixture remains six seconds.
    const firstRequestStarted = performance.now()
    const small = await tracked(
      view,
      'complete',
      request('result.bin', '/small.bin', { timeoutMs: 12_000 })
    )
    assert.equal((await small.complete(server.small)).status, 'completed')
    firstRequestElapsedMs = diagnosticElapsed(firstRequestStarted)
    const beforeCollision = server.count('/small.bin')
    await assert.rejects(backend.startDownload(view, request('result.bin')), /exists|destination/i)
    assert.equal(hash(readFileSync(join(root, 'result.bin'))), hash(server.small))
    assert.equal(server.count('/small.bin'), beforeCollision)
    checks['duplicatePreserved'] = true
    const replacementRequestStarted = performance.now()
    const replace = await tracked(
      view,
      'explicit-replace-large',
      request('result.bin', '/large.bin', { destination: destination('result.bin', 'replace') })
    )
    assert.equal((await replace.complete(server.large)).status, 'completed')
    replacementRequestElapsedMs = diagnosticElapsed(replacementRequestStarted)
    mkdirSync(join(root, 'occupied.bin'), { mode: 0o700 })
    await assert.rejects(
      backend.startDownload(
        view,
        request('occupied.bin', '/small.bin', {
          destination: destination('occupied.bin', 'replace'),
        })
      ),
      /file|destination|path|directory/i
    )
    checks['nonfileDestinationRejected'] = true

    const redirected = await tracked(
      view,
      'allowed-redirect',
      request('redirect.bin', '/redirect.bin')
    )
    assert.equal((await redirected.complete(server.small)).status, 'completed')
    const blocked = await tracked(
      view,
      'denied-redirect',
      request('blocked.bin', '/redirect-denied.bin')
    )
    assert.deepEqual((await blocked.complete()).status, 'failed')
    assert.equal(blocked.operation.state().failure, 'permission')
    assert.equal(server.observations().blockedRequests, 0)
    checks['redirectNeverReachedBlockedOrigin'] = true

    const cancelled = await tracked(view, 'cancel', request('cancel.bin', '/slow.bin'))
    await cancelled.progressed()
    assert.strictEqual(cancelled.operation.cancel(), cancelled.operation.cancel())
    assert.equal((await cancelled.complete()).status, 'cancelled')
    const abort = new AbortController()
    const aborted = await tracked(
      view,
      'abort',
      request('abort.bin', '/slow.bin'),
      AbortSignal.any([controller.signal, abort.signal])
    )
    await aborted.progressed()
    abort.abort()
    assert.equal((await aborted.complete()).status, 'cancelled')
    const limited = await tracked(
      view,
      'unknown-size-limit',
      request('limit.bin', '/unknown-size.bin', { maxBytes: 64 * 1024 })
    )
    assert.deepEqual(await limited.complete(), {
      status: 'failed',
      failure: 'limit',
      bytesWritten: 0,
      bytesReceived: limited.operation.state().bytesReceived,
    })
    const timed = await tracked(
      view,
      'transfer-timeout',
      request('timeout.bin', '/slow.bin', { timeoutMs: 1000 })
    )
    assert.equal((await timed.complete()).status, 'failed')
    assert.equal(timed.operation.state().failure, 'timeout')
    const broken = await tracked(view, 'network-interruption', request('broken.bin', '/broken.bin'))
    assert.equal((await broken.complete()).status, 'failed')
    assert.equal(broken.operation.state().failure, 'network')

    const navigated = await tracked(
      view,
      'navigation-cancel',
      request('navigation.bin', '/slow.bin')
    )
    await navigated.progressed()
    url = server.origin + '/document?phase=reload'
    const navigation = ready(url, backend.state(view).documentId)
    await backend.navigate(view, url)
    await navigation.wait(view)
    assert.equal((await navigated.complete()).status, 'cancelled')
    await assert.rejects(
      backend.grantNativeCapability(originalScope, { name: 'download', root }),
      /stale|changed|revoked/i
    )
    checks['staleGrantRejected'] = true
    await grant(view)
    const reloaded = await tracked(
      view,
      'renderer-reload-cancel',
      request('reload.bin', '/slow.bin')
    )
    await reloaded.progressed()
    await bounded(server.reloadRequested)
    const reload = ready(url, backend.state(view).documentId)
    server.releaseReload()
    await reload.wait(view)
    assert.equal((await reloaded.complete()).status, 'cancelled')
    await grant(view)
    const closed = await tracked(view, 'view-close-cancel', request('view-close.bin', '/slow.bin'))
    await closed.progressed()
    await bounded(backend.disposeView(view))
    assert.equal((await closed.complete()).status, 'cancelled')
    await backend.disposeSession(session)

    const closingWindow = await backend.createWindow({
      title: 'Download close owner',
      bounds: { x: 60, y: 60, width: 480, height: 300 },
    })
    const closeSession = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'download-window-close',
      network: { allowedOrigins: [server.origin] },
    })
    url = server.origin + '/document?phase=window-close'
    const windowReady = ready(url)
    const closeView = await backend.createView({
      window: closingWindow,
      session: closeSession,
      url,
      trust: { kind: 'remote' },
    })
    await windowReady.wait(closeView)
    await grant(closeView)
    const windowClose = await tracked(
      closeView,
      'window-close-cancel',
      request('window-close.bin', '/slow.bin')
    )
    await windowClose.progressed()
    await bounded(backend.closeWindow(closingWindow))
    assert.equal((await windowClose.complete()).status, 'cancelled')
    await backend.disposeSession(closeSession)
    settledBaseline = await native()
    for (const [key, value] of Object.entries(settledBaseline))
      assert.equal(value, key === 'windows' ? 1 : 0)

    // The final transfer remains owned while quit cancels it; its terminal
    // receipt must arrive before the ordinary private native shutdown receipt.
    const quitSession = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'download-quit',
      network: { allowedOrigins: [server.origin] },
    })
    url = server.origin + '/document?phase=quit'
    const quitReady = ready(url)
    const quitView = await backend.createView({
      window,
      session: quitSession,
      url,
      trust: { kind: 'remote' },
    })
    await quitReady.wait(quitView)
    await grant(quitView)
    quit = await tracked(quitView, 'quit-cancel', request('quit.bin', '/slow.bin'))
    await quit.progressed()
    nativeBeforeQuit = await native()
    for (const [key, value] of Object.entries(nativeBeforeQuit))
      assert.equal(value, ['views', 'sessions', 'windows', 'downloads'].includes(key) ? 1 : 0)
  } catch (error) {
    failure = failureText(error)
  } finally {
    disposing = true
    for (const item of readiness) item.close()
    readiness.clear()
    try {
      phase = 'native-shutdown'
      await backend.dispose()
      shutdownSucceeded = true
      phase = 'quit-settlement'
      if (quit) assert.equal((await quit.complete()).status, 'cancelled')
      assert.ok(
        downloadShutdown && shutdownReceipts === 1,
        'Missing unique native download shutdown receipt'
      )
      assert.deepEqual(
        steps.map((step) => step.name),
        downloadFixtureSteps
      )
      phase = 'sentinel-preservation'
      cleanStage()
      assert.equal(readFileSync(join(root, 'sentinel.txt'), 'utf8'), sentinel)
      checks['sentinelPreserved'] = true
    } catch (error) {
      failure ??= failureText(error)
    }
    stopShutdown()
    clearTimeout(deadline)
    if (server) {
      try {
        phase = 'fixture-server-shutdown'
        await server.close()
      } catch (error) {
        failure ??= failureText(error)
      }
    }
    const network = server?.observations() ?? null
    if (shutdownSucceeded) {
      try {
        phase = 'temporary-root-cleanup'
        rmSync(root, { recursive: true })
        temporaryCleanup = true
      } catch (error) {
        failure ??= failureText(error)
      }
    }
    const final = backend.diagnostics()
    if (shutdownSucceeded)
      for (const key of ['views', 'windows', 'sessions', 'listeners', 'listenerErrors'] as const) {
        if (final[key] !== 0) failure ??= `Final SDK ${key} did not settle`
      }
    const workloadMs = performance.now() - started
    if (controller.signal.aborted || workloadMs > DOWNLOAD_WORKLOAD_MS)
      failure ??= 'workload-deadline: Error'
    const serialized = JSON.stringify({
      event: 'bunly.native.file-downloads',
      schema: 1,
      passed: failure === null,
      workloadMs,
      // The unchanged exact-key acceptance parser intentionally excludes this probe.
      diagnosticTiming: {
        schema: 1,
        diagnosticOnly: true,
        firstRequestTimeoutMs: 12_000,
        replacementRequestTimeoutMs: 6_000,
        firstRequestElapsedMs,
        replacementRequestElapsedMs,
      },
      observations: {
        steps,
        checks,
        documents,
        settledBaseline,
        network,
        downloadShutdown,
        shutdownSucceeded,
        temporaryCleanup,
        final,
      },
      // Last live native snapshot intentionally owns one active quit transfer.
      nativeBeforeQuit,
      failure,
      physicalInputQualified: false,
      hardwareDpiQualified: false,
      assistiveTechnologyQualified: false,
      performanceEligible: false,
    })
    assert.ok(
      Buffer.byteLength(serialized) <= 16 * 1024,
      'Download receipt exceeds native diagnostic bound'
    )
    console.error(serialized)
  }
  if (failure !== null) throw new Error(failure)
}
