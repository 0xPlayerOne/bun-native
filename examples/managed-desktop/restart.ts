import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DevelopmentSession } from '../../packages/cli/src/dev-host.ts'
import type { SessionHandle, ViewHandle, WindowHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../../packages/runtime/src/managed-generations.ts'
import type { RpcContext, RpcHandlers } from '../../packages/runtime/src/rpc.ts'
import { ServiceReloadHost } from '../../packages/runtime/src/service-reload.ts'
import { ManagedDiagnostics } from './diagnostics.ts'
import { managedDocumentReadiness } from './document-readiness.ts'
import {
  RESTART_DEADLINE_MS,
  restartBackendReceipt,
  restartRpcLimits,
  restartSchema,
  type ManagedRestartResult,
  type RestartBackendReceipt,
  type RestartInitialReceipt,
  type RestartRendererReceipt,
} from './restart-contract.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function environment(name: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) throw new Error('RESTART_ENVIRONMENT_INVALID')
  return value
}
async function configurationHash(root: string): Promise<string> {
  const path = join(root, 'bunly-dev.json')
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 4096)
    throw new Error('RESTART_CONFIGURATION_INVALID')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size ||
    bytes.length !== before.size
  )
    throw new Error('RESTART_CONFIGURATION_CHANGED')
  assert.deepEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), {
    changedNativeConfiguration: true,
  })
  return createHash('sha256').update(bytes).digest('hex')
}

/** A fresh native launch after the completed soak; never resets or rewrites its edited inputs. */
export default async function managedRestartFixture(backend: CefBackend): Promise<void> {
  const root = environment('BUNLY_MANAGED_ROOT')
  const runner = environment('BUNLY_SERVICE_RUNNER')
  const resultPath = environment('BUNLY_MANAGED_RESTART_RESULT')
  const diagnostics = new ManagedDiagnostics()
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const broker = new ServiceReloadHost({
    owner,
    runner,
    stateSchema: 'managed-restart:1',
    permissions: ['restart-fixture'],
    initialState: '{}',
    mechanism: 'worker',
    readyTimeoutMs: 5000,
    requestTimeoutMs: 10_000,
    onDiagnostic: (event) => diagnostics.broker(event),
  })
  const started = deferred<RestartInitialReceipt>(),
    ready = deferred<void>(),
    completed = deferred<RestartRendererReceipt>()
  let window: WindowHandle | undefined,
    view: ViewHandle | undefined,
    session: SessionHandle | undefined
  let development: DevelopmentSession | undefined
  let initial: RestartInitialReceipt | undefined
  let response: RestartBackendReceipt | null = null,
    renderer: RestartRendererReceipt | null = null
  let identities: ManagedRestartResult['identities'] = null
  let accepted = 0,
    settled = 0,
    expectedConfiguration = '',
    failureCode: string | undefined
  let nativeFinal: Record<string, unknown> = {}
  const admit = async <T>(context: RpcContext, work: () => Promise<T>): Promise<T> => {
    assert.equal(context.identity.viewId, view?.id)
    accepted++
    try {
      return await work()
    } finally {
      settled++
    }
  }
  const readback = async () => {
    assert.ok(view && session)
    const result = restartBackendReceipt(JSON.parse(await broker.request('readback', 'null')))
    assert.equal(result.revision, 500)
    assert.equal(result.shared, 1)
    assert.equal(result.configurationApplied, true)
    assert.equal(result.configurationSha256, expectedConfiguration)
    assert.equal(result.loginAbsent, true)
    assert.equal(result.document, backend.state(view).documentId)
    assert.equal(result.url, 'app://ui/restart.html')
    assert.equal(result.session, session.id)
    response = result
    return result
  }
  const handlers: RpcHandlers<typeof restartSchema> = {
    begin: {
      capability: 'managed-restart-fixture',
      handle: (receipt, context) =>
        admit(context, async () => {
          assert.equal(initial, undefined)
          assert.equal(receipt.formEmpty, true)
          assert.equal(receipt.sessionAbsent, true)
          assert.equal(receipt.loginAbsent, true)
          initial = receipt
          started.resolve(receipt)
          await ready.promise
          return readback()
        }),
    },
    finish: {
      capability: 'managed-restart-fixture',
      handle: (receipt, context) =>
        admit(context, async () => {
          assert.ok(initial && response)
          assert.equal(receipt.instance, initial.instance)
          assert.equal(receipt.formEmpty, true)
          assert.equal(receipt.sessionAbsent, true)
          assert.equal(receipt.loginAbsent, true)
          assert.equal(receipt.revision, response.revision)
          assert.equal(receipt.shared, response.shared)
          assert.equal(receipt.configurationApplied, true)
          assert.equal(receipt.configurationSha256, expectedConfiguration)
          completed.resolve(receipt)
          return null
        }),
    },
    fail: {
      capability: 'managed-restart-fixture',
      handle: (_code, context) =>
        admit(context, async () => {
          const error = new Error('RESTART_RENDERER_ASSERTION')
          started.reject(error)
          completed.reject(error)
          return null
        }),
    },
  }
  const stopRpc = backend.serveRpc(
    restartSchema,
    handlers,
    ['app://ui'],
    ['managed-restart-fixture'],
    { limits: restartRpcLimits }
  )
  const documentReady = managedDocumentReadiness(backend, 'app://ui/restart.html')
  const deadline = setTimeout(() => {
    const error = new Error('RESTART_FIXTURE_DEADLINE')
    documentReady.close(error)
    started.reject(error)
    ready.reject(error)
    completed.reject(error)
  }, RESTART_DEADLINE_MS)
  try {
    expectedConfiguration = await configurationHash(root)
    // Same partition name as the first launch. A fresh ephemeral session must not retain its cookie.
    session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'managed-desktop',
    })
    window = await backend.createWindow({
      title: 'Bunly controlled restart',
      bounds: { x: 24, y: 24, width: 800, height: 480 },
    })
    view = await backend.createView({
      window,
      session,
      url: 'app://ui/restart.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await Promise.all([started.promise, documentReady.wait(view)])
    const authority = await desktop.captureAuthority(view)
    const retainedSession = desktop.registerSession('session', session, {
      authority,
      permission: 'restart-fixture',
      operations: ['identity', 'cookies'],
    })
    const retainedWindow = desktop.registerWindow('window', window, {
      authority,
      permission: 'restart-fixture',
      operations: ['state'],
    })
    desktop.registerView('view', view, {
      authority,
      permission: 'restart-fixture',
      operations: ['state'],
      dependsOn: [retainedSession, retainedWindow],
    })
    identities = {
      window: window.id,
      view: view.id,
      session: session.id,
      document: backend.state(view).documentId,
      url: backend.state(view).url,
    }
    development = await DevelopmentSession.start({
      projectRoot: root,
      entrypoint: 'backend/restart-service.ts',
      backendRoots: ['backend'],
      sharedRoots: ['shared'],
      frontendRoots: ['frontend'],
      cacheRoot: '.cache',
      configurationFile: 'bunly-dev.json',
      watch: false,
      debounceMs: 0,
      reload: async (bundle) => {
        const resources = await diagnostics.observe('bindings', () => desktop.prepare())
        return diagnostics.observe('reload', () =>
          broker.reload({ entry: bundle.entry, resources })
        )
      },
      shutdown: () => broker.close(),
      onDiagnostic: (event) => diagnostics.development(event),
    })
    ready.resolve()
    renderer = await completed.promise
    await backend.drainRpc(view)
    assert.equal(accepted, 2)
    assert.equal(settled, accepted)
    assert.equal(
      development.diagnostics().restartRequired,
      false,
      'The new owner must apply the changed configuration at startup'
    )
    assert.equal(
      await configurationHash(root),
      expectedConfiguration,
      'Restart must not rewrite the edited configuration'
    )
  } catch (error) {
    diagnostics.failure('fixture', error)
    failureCode =
      error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
        ? error.message
        : 'RESTART_FIXTURE_ASSERTION'
    ready.reject(new Error(failureCode))
    console.error('BUNLY_MANAGED_RESTART_FAILED', error)
  } finally {
    documentReady.close()
    clearTimeout(deadline)
    try {
      await development?.close()
      if (!development) await broker.close()
      if (view) await backend.disposeView(view)
      if (session) await backend.disposeSession(session)
      await stopRpc()
      const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
      for (const key of [
        'windows',
        'views',
        'sessions',
        'pending',
        'nativeDeliveryPackets',
        'nativeDeliveryBytes',
        'rpcIncomingBytes',
        'streamIncomingBytes',
      ])
        nativeFinal[key] = native[key]
      await desktop.dispose()
      owner.dispose()
      assert.equal(owner.diagnostics().resources, 0)
      assert.equal(owner.diagnostics().generations, 0)
    } catch (error) {
      failureCode ??= 'RESTART_CLEANUP_FAILED'
      console.error('BUNLY_MANAGED_RESTART_CLEANUP_FAILED', error)
    }
    try {
      // Always attempt shutdown, including when managed resource cleanup failed.
      // Native sends its shutdown receipt after writing process-stop/start to shared stderr.
      // Await that receipt before emitting our completion marker into the same stream.
      await backend.dispose()
    } catch (error) {
      failureCode ??= 'RESTART_CLEANUP_FAILED'
      console.error('BUNLY_MANAGED_RESTART_CLEANUP_FAILED', error)
    }
    const result: ManagedRestartResult = {
      event: 'bunly.managed-restart',
      schema: 1,
      passed: failureCode === undefined,
      backend: response,
      renderer,
      identities,
      final: {
        owner: owner.diagnostics(),
        broker: broker.diagnostics(),
        desktop: desktop.diagnostics(),
        development: development?.diagnostics() ?? {},
        native: nativeFinal,
        nativeSnapshotPhase: 'before-last-window-close',
      },
      requests: { accepted, settled, pending: accepted - settled },
      diagnostics: diagnostics.snapshot(),
      ...(failureCode ? { failureCode } : {}),
    }
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.error(
      JSON.stringify({
        event: result.event,
        schema: 1,
        passed: result.passed,
        revision: result.backend?.revision ?? null,
        shared: result.backend?.shared ?? null,
        configurationApplied: result.backend?.configurationApplied ?? false,
        failureCode: failureCode ?? null,
      })
    )
  }
  if (failureCode) throw new Error(failureCode)
}
