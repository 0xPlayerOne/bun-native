import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { PolicyScope, ViewHandle } from '../../packages/contracts/src/index.ts'
import type {
  FileInteractionKind,
  FileInteractionOperation,
  FileInteractionResult,
} from '../../packages/contracts/src/programmatic-files.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { remoteDocumentReadiness } from '../file-downloads/readiness.ts'
import { FileFixtureDiagnostic } from './diagnostics.ts'
import { fileFixtureServer, type UploadCase } from './server.ts'

/** Uses actual CEF documents and HTTP multipart requests. The page receives only
 * synthetic File interactions; no OS picker or physical drag is exercised.
 */
export default async function programmaticFiles(backend: CefBackend): Promise<void> {
  const started = performance.now()
  const checks: Record<string, boolean> = {}
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('File fixture deadline')), 45_000)
  const server = fileFixtureServer()
  const diagnostic = new FileFixtureDiagnostic()
  let phase = 'setup',
    failure: string | null = null
  let nativeSettled: Record<string, unknown> | null = null
  let localSettled: Readonly<{ operations: number; bytes: number }> | null = null
  let partialExposure: FileInteractionResult | null = null
  const closed = new Set<number>()
  const unobserve = backend.observe((event) => {
    if (event.event === 'view.closed' && event.target !== undefined) closed.add(event.target)
  })
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    if (abort.signal.aborted) throw abort.signal.reason
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const stopped = () => reject(abort.signal.reason)
        abort.signal.addEventListener('abort', stopped, { once: true })
        void promise
          .finally(() => abort.signal.removeEventListener('abort', stopped))
          .catch(() => {})
      }),
    ])
  }
  const ready = async (view: ViewHandle, name: string) => {
    const receipt = remoteDocumentReadiness(
      backend,
      server.url(name),
      backend.state(view).documentId
    )
    try {
      await backend.navigate(view, server.url(name))
      await wait(receipt.wait(view))
    } finally {
      receipt.close()
    }
  }
  const grant = async (view: ViewHandle, kind: FileInteractionKind, elementId: string) => {
    const scope = await backend.capturePolicyScope(view)
    await backend.grantNativeCapability(scope, { name: kind, elementId })
    return scope
  }
  const prepare = (
    scope: PolicyScope,
    kind: FileInteractionKind,
    name: string,
    bytes: Uint8Array,
    type = 'text/plain'
  ) =>
    wait(
      backend.prepareFileInteraction(
        scope,
        {
          kind,
          elementId: kind === 'file-input' ? 'upload' : 'drop',
          file: { name, type, bytes },
        },
        { signal: abort.signal }
      )
    )
  const cancelled = (result: FileInteractionResult) => {
    assert.notEqual(result.status, 'completed')
    assert.equal(result.synthetic, true)
    assert.equal(result.mayHaveExposedFile, false)
  }
  const zeroOwners = async (trackUpload = false) => {
    if (trackUpload) diagnostic.step('native-owners-read')
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    const files = native['programmaticFiles'] as Record<string, unknown>
    if (trackUpload) {
      diagnostic.native(files)
      diagnostic.step('native-owners-check')
    }
    for (const key of [
      'operations',
      'registrations',
      'callbacks',
      'privateControllers',
      'objectGroups',
      'chunkBytes',
      'reservedBytes',
      'deadlineWorkers',
    ])
      assert.equal(files[key], 0, key)
    if (trackUpload) diagnostic.step('local-owners-read')
    const local = backend.viewControlDiagnostics()
    if (trackUpload) {
      diagnostic.local(local)
      diagnostic.step('local-owners-check')
    }
    assert.deepEqual(local, { operations: 0, bytes: 0 })
    return { native: files, local }
  }
  const upload = async (
    view: ViewHandle,
    name: UploadCase,
    kind: FileInteractionKind,
    bytes: Uint8Array,
    mime: string,
    cookie: string
  ) => {
    diagnostic.begin(name)
    await ready(view, name)
    diagnostic.step('grant')
    const scope = await grant(view, kind, kind === 'file-input' ? 'upload' : 'drop')
    const filename = name + '.bin'
    diagnostic.step('prepare')
    const operation = await prepare(scope, kind, filename, bytes, mime)
    diagnostic.step('commit')
    const result = await wait(operation.commit())
    diagnostic.result(result)
    diagnostic.step('commit-result')
    assert.deepEqual(result, {
      status: 'completed',
      failure: null,
      synthetic: true,
      mayHaveExposedFile: true,
    })
    diagnostic.step('http-receipt')
    const received = await wait(server.receipt(name))
    const expected = {
      case: name,
      name: filename,
      mime,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cookie,
      kind,
      trusted: false as const,
    }
    diagnostic.receipt(received, expected)
    diagnostic.step('http-fields')
    assert.deepEqual(received, expected)
    await zeroOwners(true)
    diagnostic.step('complete')
  }
  const prepared = async (view: ViewHandle, name: string): Promise<FileInteractionOperation> => {
    await ready(view, name)
    return prepare(
      await grant(view, 'file-input', 'upload'),
      'file-input',
      'pending.txt',
      new TextEncoder().encode('pending')
    )
  }
  try {
    for (const capability of ['view.file-input', 'view.file-drop'] as const)
      assert.ok(backend.descriptor.capabilities.includes(capability))
    const control = await backend.createWindow({
      title: 'File fixture control',
      bounds: { x: 20, y: 20, width: 320, height: 240 },
    })
    const windows = [],
      sessions = [],
      views = []
    for (const partition of ['alpha', 'beta']) {
      const session = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'file-' + partition,
        network: { allowedOrigins: [server.origin] },
      })
      await backend.setCookie(session, server.origin, {
        name: 'partition',
        value: partition,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      })
      const window = await backend.createWindow({
        title: 'Synthetic files ' + partition,
        bounds: { x: 80, y: 80, width: 640, height: 400 },
      })
      const receipt = remoteDocumentReadiness(backend, server.url('denied'))
      const view = await backend.createView({
        session,
        window,
        url: server.url('denied'),
        trust: { kind: 'remote' },
      })
      try {
        await wait(receipt.wait(view))
      } finally {
        receipt.close()
      }
      windows.push(window)
      sessions.push(session)
      views.push(view)
    }
    const [alpha, beta] = views as [ViewHandle, ViewHandle]
    phase = 'denial'
    const denied = await backend.capturePolicyScope(alpha)
    await assert.rejects(
      prepare(denied, 'file-input', 'denied.txt', new Uint8Array()),
      /permission|grant/i
    )
    await backend.grantNativeCapability(denied, { name: 'file-input', elementId: 'other' })
    await assert.rejects(
      prepare(denied, 'file-input', 'denied.txt', new Uint8Array()),
      /permission|grant/i
    )
    await backend.grantNativeCapability(denied, { name: 'file-drop', elementId: 'upload' })
    await assert.rejects(
      prepare(denied, 'file-input', 'denied.txt', new Uint8Array()),
      /permission|grant/i
    )
    const other = await backend.capturePolicyScope(beta)
    await assert.rejects(
      prepare(other, 'file-input', 'denied.txt', new Uint8Array()),
      /permission|grant/i
    )
    await zeroOwners()
    checks['exactGrantDenial'] = true
    phase = 'five-http-uploads'
    await upload(
      alpha,
      'text',
      'file-input',
      new TextEncoder().encode('fixture text Ω'),
      'text/plain',
      'partition=alpha'
    )
    const maximum = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 17 + 31) % 256)
    await upload(
      alpha,
      'maximum',
      'file-input',
      maximum,
      'application/octet-stream',
      'partition=alpha'
    )
    await upload(
      alpha,
      'empty',
      'file-drop',
      new Uint8Array(),
      'application/x-empty',
      'partition=alpha'
    )
    await upload(
      beta,
      'isolated',
      'file-input',
      new Uint8Array([0, 255, 128, 1]),
      'application/octet-stream',
      'partition=beta'
    )
    await upload(
      beta,
      'drop',
      'file-drop',
      new Uint8Array([7, 9, 11]),
      'application/x-bunly-fixture',
      'partition=beta'
    )
    checks['fiveUploads'] = true
    checks['mimeAndHashes'] = true
    checks['cookiePartitions'] = true
    checks['oneMiBBoundary'] = true
    checks['syntheticInputAndDrop'] = true
    phase = 'cancel-before-commit'
    cancelled(await wait((await prepared(alpha, 'cancel')).cancel()))
    await zeroOwners()
    checks['cancelBeforeCommit'] = true
    phase = 'reload-revocation'
    const reloading = await prepared(alpha, 'reload')
    const oldScope = await backend.capturePolicyScope(alpha)
    await ready(alpha, 'reload')
    cancelled(await wait(reloading.commit()))
    await assert.rejects(
      backend.grantNativeCapability(oldScope, { name: 'file-input', elementId: 'upload' }),
      /scope|stale|document|revoked/i
    )
    await assert.rejects(
      prepare(
        await backend.capturePolicyScope(alpha),
        'file-input',
        'denied.txt',
        new Uint8Array()
      ),
      /permission|grant/i
    )
    await zeroOwners()
    checks['reloadRevokesGrant'] = true
    phase = 'navigation-race'
    const navigating = await prepared(alpha, 'navigating')
    const navigation = ready(alpha, 'replacement')
    cancelled(await wait(navigating.commit()))
    await navigation
    await zeroOwners()
    checks['navigationSettled'] = true
    phase = 'close-prepared-view'
    const closing = await prepared(beta, 'closing')
    const before = closed.size
    await wait(backend.disposeView(beta))
    cancelled(await wait(closing.completed))
    assert.equal(closed.size, before + 1)
    await backend.windowState(control)
    await zeroOwners()
    checks['closeSettled'] = true
    phase = 'partial-exposure'
    await ready(alpha, 'partial')
    const partial = await prepare(
      await grant(alpha, 'file-input', 'upload'),
      'file-input',
      'partial.txt',
      new TextEncoder().encode('partial')
    )
    partialExposure = await wait(partial.commit())
    assert.equal(partialExposure.status, 'failed')
    assert.equal(partialExposure.failure, 'stale-target')
    assert.equal(partialExposure.mayHaveExposedFile, true)
    assert.deepEqual(await wait(server.exposure), {
      name: 'partial.txt',
      mime: 'text/plain',
      bytes: 7,
      trusted: false,
    })
    checks['partialExposureReported'] = true
    const settled = await zeroOwners()
    nativeSettled = settled.native
    localSettled = settled.local
    assert.equal(nativeSettled['admitted'], 10)
    assert.equal(nativeSettled['prepared'], 10)
    assert.equal(nativeSettled['committed'], 6)
    assert.equal(nativeSettled['dispatched'], 5)
    assert.equal(nativeSettled['completed'], 5)
    assert.equal(nativeSettled['released'], 10)
    checks['zeroOwners'] = true
    await backend.disposeView(alpha)
    for (const window of windows) await backend.closeWindow(window)
    for (const session of sessions) await backend.disposeSession(session)
  } catch (error) {
    failure = `${phase}:${error instanceof Error ? error.name : 'Error'}`
  } finally {
    clearTimeout(timer)
    unobserve()
    try {
      await backend.dispose()
    } catch {
      failure ??= 'shutdown:Error'
    }
    await server.stop()
    const http = server.snapshot()
    if (http.failures.length || http.uploads.length !== 5 || !http.exposed)
      failure ??= 'http-receipts:Error'
    const final = backend.diagnostics()
    for (const key of ['views', 'windows', 'sessions', 'listeners', 'listenerErrors'] as const)
      if (final[key] !== 0) failure ??= `final-${key}:Error`
    if (abort.signal.aborted || performance.now() - started >= 45_000)
      failure ??= 'workload-deadline:Error'
    if (failure) console.error(JSON.stringify(diagnostic.failure(failure)))
    console.error(
      JSON.stringify({
        event: 'bunly.native.programmatic-files',
        schema: 1,
        passed: failure === null,
        failure,
        workloadMs: performance.now() - started,
        checks,
        uploads: http.uploads,
        partialExposure,
        nativeSettled,
        localSettled,
        final,
        synthetic: true,
        osPickerQualified: false,
        physicalDropQualified: false,
        rollbackGuaranteed: false,
        performanceEligible: false,
      })
    )
  }
  if (failure) throw new Error(failure)
}
