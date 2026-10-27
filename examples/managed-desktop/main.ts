import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DevelopmentSession } from '../../packages/cli/src/dev-host.ts'
import type { ViewHandle, WindowHandle, SessionHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { RpcContext, RpcHandlers } from '../../packages/runtime/src/rpc.ts'
import { ManagedGenerationOwner } from '../../packages/runtime/src/managed-generations.ts'
import { ManagedDesktopResources } from '../../packages/runtime/src/managed-desktop.ts'
import { ServiceReloadError, ServiceReloadHost } from '../../packages/runtime/src/service-reload.ts'
import {
  TerminalService,
  type TerminalHandle,
  type TerminalObservation,
  type TerminalProcessExit,
  type TerminalClosure,
} from '../../packages/runtime/src/terminal.ts'
import {
  FORM_MARKER,
  LOGIN_MARKER,
  SESSION_MARKER,
  byteHashText,
  managedRpcLimits,
  managedSchema,
  updateByteHash,
  type ManagedAction,
  type RendererReceipt,
  type TerminalReceipt,
} from './contract.ts'
import {
  MANAGED_PLAN,
  type ManagedFailureCase,
  type ManagedFrontendSource,
  type ManagedIdentities,
  type ManagedResult,
  type ManagedRow,
} from './evidence.ts'
import { readManagedFrontendSource } from './frontend-source.ts'
import managedRestartFixture from './restart.ts'

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
function environment(name: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) throw new Error('Missing absolute fixture environment path')
  return value
}
const failureRevision: Readonly<Record<ManagedFailureCase, number>> = {
  syntax: 100,
  import: 200,
  initialization: 300,
  'closed-resource': 425,
  'runtime-handler': 450,
}

/** Actual native fixture: the runner supplies a prepared CEF app and a private copied project. */
export default async function managedDesktopFixture(backend: CefBackend): Promise<void> {
  if (process.env['BUNLY_MANAGED_MODE'] === 'restart-check') return managedRestartFixture(backend)
  if (
    process.env['BUNLY_MANAGED_MODE'] !== undefined &&
    process.env['BUNLY_MANAGED_MODE'] !== 'soak'
  )
    throw new Error('MANAGED_MODE_INVALID')
  const root = environment('BUNLY_MANAGED_ROOT')
  const runner = environment('BUNLY_SERVICE_RUNNER')
  const rowsPath = environment('BUNLY_MANAGED_ROWS')
  const resultPath = environment('BUNLY_MANAGED_RESULT')
  await writeFile(rowsPath, '', { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'bunly-dev.json'), '{}\n', { mode: 0o600 })
  let rowIndex = 0,
    rowTail = Promise.resolve()
  const row = (value: Omit<ManagedRow, 'schema' | 'index'>) => {
    const record: ManagedRow = { schema: 1, index: rowIndex++, ...value }
    const pending = rowTail.then(() => appendFile(rowsPath, JSON.stringify(record) + '\n'))
    rowTail = pending
    return pending
  }
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend)
  const pageStarted = deferred<void>(),
    ready = deferred<void>(),
    complete = deferred<TerminalReceipt>(),
    pendingStarted = deferred<void>()
  const terminalReady = deferred<{ handle: TerminalHandle; observation: TerminalObservation }>()
  let window: WindowHandle | undefined,
    view: ViewHandle | undefined,
    session: SessionHandle | undefined
  let development: DevelopmentSession | undefined
  let accepted = 0,
    settled = 0,
    successful = 0,
    revision = 0,
    shared = 0
  let frontendNotifications = 0,
    frontendAcknowledged = 0,
    rendererChecks = 0
  let firstRenderer: RendererReceipt | undefined
  let frontendSource: ManagedFrontendSource | undefined
  const frontendSources: ManagedFrontendSource[] = []
  let pendingTiming:
    | { revision: number; started: number; kind: 'backend' | 'shared' | 'frontend' }
    | undefined
  const refreshFrontend = async () => {
    const next = await readManagedFrontendSource(root)
    assert.equal(next.version, frontendSources.length)
    assert.ok(frontendSources.length < 3)
    if (frontendSource) assert.notEqual(next.sha256, frontendSource.sha256)
    frontendSource = next
    frontendSources.push(next)
    frontendNotifications = next.version
  }
  let launches = 0,
    sourceBytes = 0,
    sourceHash = 0x811c9dc5
  let terminalExit: TerminalProcessExit | null = null,
    terminalClose: TerminalClosure | null = null
  let terminalReleased = false,
    outputOk = false
  let rendererTerminal: TerminalReceipt | undefined
  let identitiesBefore: ManagedIdentities | null = null,
    identitiesAfter: ManagedIdentities | null = null
  let pendingAccepted = 0,
    pendingSettled = 0,
    pendingOutcome = 'NOT_RUN',
    staleMutations = 0
  let closeDuringPrepare = false,
    temporaryClosed: Promise<void> | undefined
  let restartRequired = false,
    failureCode: string | undefined,
    changing = false
  const failures: Partial<Record<ManagedFailureCase, boolean>> = {}
  const native = await backend.createTerminalDriver({ profile: 'non-detaching' })
  const terminals = new TerminalService({
    driver: {
      spawn(options, observer) {
        launches++
        assert.equal(launches, 1, 'The retained native child must never respawn')
        return native.spawn(options, {
          ...observer,
          output(bytes) {
            sourceBytes += bytes.byteLength
            assert.ok(sourceBytes <= 4 * 1024 * 1024)
            sourceHash = updateByteHash(sourceHash, bytes)
            observer.output(bytes)
          },
        })
      },
    },
    limits: {
      maxTerminals: 1,
      maxTerminalsPerOwner: 1,
      maxOutputBytes: 64 * 1024,
      maxOutputBytesPerOwner: 32 * 1024,
      maxOutputBytesPerTerminal: 32 * 1024,
      closeTimeoutMs: 5000,
      operationTimeoutMs: 5000,
    },
  })
  const probe = owner.register({
    kind: 'process',
    schema: 'fixture-probe:1',
    permission: 'fixture',
    authorize: () => true,
    invoke(operation) {
      if (operation === 'pending') pendingStarted.resolve()
      else if (operation === 'stale') staleMutations++
      else throw new Error('Unknown fixture probe')
      return 'null'
    },
    dispose() {},
  })
  const bindings = async () => ({
    ...(await desktop.prepare()),
    probe: { resource: probe, schema: 'fixture-probe:1' },
  })
  const broker = new ServiceReloadHost({
    owner,
    runner,
    stateSchema: 'managed-desktop:1',
    permissions: ['fixture'],
    mechanism: 'worker',
    initialState: '{"retained":"workspace"}',
    readyTimeoutMs: 5000,
    quiesceTimeoutMs: 100,
    retireTimeoutMs: 1000,
    exitTimeoutMs: 2000,
    requestTimeoutMs: 15_000,
    onDiagnostic(event) {
      if (closeDuringPrepare && event.event === 'stage' && event.stage === 'prepare') {
        closeDuringPrepare = false
        temporaryClosed = desktop.close('temporary')
        void temporaryClosed.catch(() => {})
      }
    },
  })
  const currentIdentities = async (): Promise<ManagedIdentities> => {
    assert.ok(view && window && session)
    const terminal = await terminalReady.promise
    const state = backend.state(view)
    return {
      window: window.id,
      view: view.id,
      session: session.id,
      terminal: terminal.handle.id,
      document: state.documentId,
      url: state.url,
    }
  }
  const stable = async () => {
    const identities = await currentIdentities()
    assert.deepEqual(identities, identitiesBefore)
    return identities
  }
  const readback = async () => {
    const value = JSON.parse(await broker.request('readback', 'null')) as Record<string, unknown>
    assert.equal(value['revision'], revision)
    assert.equal(value['shared'], shared)
    assert.equal(value['login'], LOGIN_MARKER)
    assert.equal(value['document'], identitiesBefore?.document)
    assert.equal(value['session'], identitiesBefore?.session)
    assert.equal(value['terminal'], identitiesBefore?.terminal)
    await stable()
    return JSON.stringify({ ...value, frontend: frontendNotifications })
  }
  const checkpoint = async () => {
    Bun.gc(true)
    const memory = process.memoryUsage()
    assert.ok(development)
    await row({
      kind: 'checkpoint',
      revision,
      elapsedMs: 0,
      passed: true,
      snapshot: {
        heapUsed: memory.heapUsed,
        rss: memory.rss,
        external: memory.external,
        owner: owner.diagnostics(),
        broker: broker.diagnostics(),
        desktop: desktop.diagnostics(),
        terminal: terminals.diagnostics(),
        development: development.diagnostics(),
        accepted,
        settled,
      },
    })
  }
  const controlled = async (action: ManagedAction, requested: number): Promise<string> => {
    await ready.promise
    assert.equal(changing, false, 'Only one fixed edit is admitted at a time')
    changing = true
    const begin = performance.now()
    try {
      assert.ok(development)
      const dependency = join(root, 'backend/dependency.ts')
      if (action === 'advance') {
        assert.equal(requested, revision + 1)
        assert.ok(requested <= MANAGED_PLAN.replacements)
        if (requested === MANAGED_PLAN.pendingAt) await pendingStarted.promise
        assert.equal(pendingTiming, undefined)
        pendingTiming = {
          revision: requested,
          started: performance.now(),
          kind: requested === MANAGED_PLAN.sharedAt ? 'shared' : 'backend',
        }
        await writeFile(dependency, `export const revision = ${requested}\n`)
        const paths = [dependency]
        if (requested === MANAGED_PLAN.sharedAt) {
          await writeFile(join(root, 'shared/value.ts'), 'export const shared = 1\n')
          paths.push(join(root, 'shared/value.ts'))
        }
        const change = await development.invalidate(paths)
        assert.equal(change.action, requested === MANAGED_PLAN.sharedAt ? 'both' : 'reloaded')
        assert.equal(change.backendReplaced, true)
        revision = requested
        shared = revision >= MANAGED_PLAN.sharedAt ? 1 : 0
        successful++
        await stable()
        await broker.request('emit', JSON.stringify(revision))
        assert.equal(staleMutations, 0)
        await row({
          kind: 'replacement',
          revision,
          elapsedMs: change.durationMs,
          passed: true,
          action: change.action,
          shared,
        })
        if (revision % MANAGED_PLAN.checkpointEvery === 0) await checkpoint()
        return JSON.stringify({ action: change.action, revision })
      }
      assert.equal(requested, revision)
      if (action === 'frontend') {
        assert.equal(revision, MANAGED_PLAN.frontendAfter)
        const before = broker.diagnostics().active
        assert.equal(pendingTiming, undefined)
        pendingTiming = { revision, started: performance.now(), kind: 'frontend' }
        await writeFile(join(root, 'frontend/style.css'), ':root { --fixture-revision: 1; }\n')
        const change = await development.invalidate([join(root, 'frontend/style.css')])
        assert.equal(change.action, 'frontend')
        assert.equal(change.backendReplaced, false)
        assert.equal(broker.diagnostics().active, before)
        await row({
          kind: 'frontend',
          revision,
          elapsedMs: change.durationMs,
          passed: true,
          action: change.action,
        })
        return JSON.stringify({ action: change.action, revision })
      }
      if (action === 'restart') {
        assert.equal(revision, MANAGED_PLAN.replacements)
        await writeFile(join(root, 'bunly-dev.json'), '{"changedNativeConfiguration":true}\n')
        const change = await development.invalidate([join(root, 'bunly-dev.json')])
        assert.equal(change.action, 'restart-required')
        assert.equal(change.backendReplaced, false)
        restartRequired = development.diagnostics().restartRequired
        assert.equal(restartRequired, true)
        await row({
          kind: 'restart',
          revision,
          elapsedMs: change.durationMs,
          passed: true,
          action: change.action,
        })
        return JSON.stringify({ action: change.action, revision })
      }
      assert.equal(revision, failureRevision[action])
      assert.equal(failures[action], undefined)
      const before = broker.diagnostics().active
      if (action === 'runtime-handler') {
        let failed = false
        try {
          await broker.request('runtimeFailure', 'null')
        } catch (error) {
          failed = error instanceof ServiceReloadError && error.code === 'APPLICATION_FAILED'
        }
        assert.equal(failed, true)
      } else {
        if (action === 'syntax') await writeFile(dependency, 'export const revision = ;\n')
        else if (action === 'import')
          await writeFile(dependency, "export { revision } from './intentionally-missing.ts'\n")
        else if (action === 'initialization')
          await writeFile(
            dependency,
            `throw new Error('Fixed initialization failure'); export const revision = ${revision}\n`
          )
        else {
          assert.ok(view)
          const temporary = await backend.createSession({
            persistence: 'ephemeral',
            partition: 'managed-temporary',
          })
          desktop.registerSession('temporary', temporary, {
            authority: await desktop.captureAuthority(view),
            permission: 'fixture',
            operations: ['identity'],
          })
          await writeFile(dependency, `export const revision = ${revision}\n`)
          closeDuringPrepare = true
        }
        const change = await development.invalidate([dependency])
        assert.equal(change.action, 'failed')
        assert.equal(change.backendReplaced, false)
        if (action === 'closed-resource') {
          assert.ok(temporaryClosed)
          await temporaryClosed
          assert.equal(closeDuringPrepare, false)
        }
      }
      assert.equal(broker.diagnostics().active, before)
      await readback()
      failures[action] = true
      await row({
        kind: 'failure',
        case: action,
        revision,
        servingRevision: revision,
        elapsedMs: performance.now() - begin,
        passed: true,
        action: 'failed',
      })
      return JSON.stringify({ action: 'failed', revision })
    } finally {
      changing = false
    }
  }
  const admit = async <T>(context: RpcContext, work: () => Promise<T>): Promise<T> => {
    assert.equal(context.identity.viewId, view?.id)
    accepted++
    try {
      return await work()
    } finally {
      settled++
    }
  }
  const handlers: RpcHandlers<typeof managedSchema> = {
    begin: {
      capability: 'managed-fixture',
      handle: (_input, context) =>
        admit(context, async () => {
          pageStarted.resolve()
          await ready.promise
          await broker.request('emit', '0')
          return readback()
        }),
    },
    step: {
      capability: 'managed-fixture',
      handle: (input, context) => admit(context, () => controlled(input.action, input.revision)),
    },
    readback: {
      capability: 'managed-fixture',
      handle: (_input, context) => admit(context, readback),
    },
    frontend: {
      capability: 'managed-fixture',
      handle: (_input, context) =>
        admit(context, async () => {
          await ready.promise
          assert.ok(frontendSource)
          return JSON.stringify(frontendSource)
        }),
    },
    verify: {
      capability: 'managed-fixture',
      handle: (receipt, context) =>
        admit(context, async () => {
          assert.equal(receipt.revision, revision)
          assert.equal(receipt.shared, shared)
          assert.equal(receipt.frontend, frontendNotifications)
          assert.ok(frontendSource)
          assert.equal(receipt.frontendHash, frontendSource.sha256)
          assert.equal(receipt.frontendStyle, frontendSource.frontend)
          assert.equal(receipt.sharedStyle, frontendSource.shared)
          assert.equal(receipt.form, FORM_MARKER)
          assert.equal(receipt.session, SESSION_MARKER)
          assert.equal(receipt.login, LOGIN_MARKER)
          assert.equal(receipt.terminalAck, revision)
          if (firstRenderer) assert.equal(receipt.instance, firstRenderer.instance)
          else firstRenderer = receipt
          frontendAcknowledged = receipt.frontend
          rendererChecks++
          const timing = pendingTiming
          if (timing) assert.equal(timing.revision, receipt.revision)
          pendingTiming = undefined
          await row({
            kind: 'renderer',
            revision,
            elapsedMs: 0,
            passed: true,
            renderer: receipt,
            ...(timing
              ? { editToRendererMs: performance.now() - timing.started, editKind: timing.kind }
              : {}),
          })
          return null
        }),
    },
    pending: {
      capability: 'managed-fixture',
      handle: (_input, context) =>
        admit(context, async () => {
          assert.equal(revision, MANAGED_PLAN.pendingAt - 1)
          assert.equal(pendingAccepted, 0)
          pendingAccepted++
          try {
            await broker.request('pending', 'null')
            throw new Error('Retired pending caller unexpectedly resolved')
          } catch (error) {
            assert.ok(error instanceof ServiceReloadError && error.code === 'RETIRED')
            pendingOutcome = error.code
            pendingSettled++
            await row({
              kind: 'retirement',
              revision: MANAGED_PLAN.pendingAt,
              elapsedMs: 0,
              passed: true,
              action: pendingOutcome,
            })
            return pendingOutcome
          }
        }),
    },
    endTerminal: {
      capability: 'managed-fixture',
      handle: (_input, context) =>
        admit(context, async () => {
          assert.equal(revision, MANAGED_PLAN.replacements)
          const terminal = await terminalReady.promise
          await terminals.write(terminal.handle, new TextEncoder().encode('exit\n'))
          terminalExit = await terminal.observation.processExited
          terminalClose = await terminal.observation.terminalClosed
          outputOk = (await terminal.observation.outputFinished).ok
          await terminal.observation.released
          terminalReleased = true
          assert.equal(terminalExit.exitCode, 0)
          assert.equal(terminalExit.signalCode, null)
          assert.equal(terminalExit.waitError, false)
          assert.equal(outputOk, true)
          return null
        }),
    },
    finish: {
      capability: 'managed-fixture',
      handle: (receipt, context) =>
        admit(context, async () => {
          complete.resolve(receipt)
          return null
        }),
    },
    fail: {
      capability: 'managed-fixture',
      handle: (_code, context) =>
        admit(context, async () => {
          complete.reject(new Error('RENDERER_ASSERTION'))
          return null
        }),
    },
  }
  const stopStreams = backend.serveStreams(['app://ui'], (connection) => {
    void (async () => {
      const sender = connection.sender({ timeoutMs: 15_000 })
      const writer = await sender.open('continuity', { signal: connection.signal })
      const handle = await terminals.create(connection.view, writer, {
        executable: process.execPath,
        cwd: root,
        argv: [fileURLToPath(new URL('./managed-child.js', import.meta.url))],
        cols: 100,
        rows: 24,
        signal: connection.signal,
        maxOutputBytes: 32 * 1024,
        maxQueuedOutputChunks: 8,
      })
      const observation = terminals.observe(handle)
      void observation.outputFinished.then((outcome) => {
        if (!outcome.ok) complete.reject(new Error('TERMINAL_OUTPUT_FAILED'))
      })
      terminalReady.resolve({ handle, observation })
    })().catch((error) => {
      const failure = error instanceof Error ? error : new Error('TERMINAL_START_FAILED')
      terminalReady.reject(failure)
      complete.reject(failure)
    })
  })
  const stopRpc = backend.serveRpc(managedSchema, handlers, ['app://ui'], ['managed-fixture'], {
    limits: managedRpcLimits,
  })
  const deadline = setTimeout(() => {
    const error = new Error('FIXTURE_DEADLINE')
    ready.reject(error)
    pageStarted.reject(error)
    terminalReady.reject(error)
    complete.reject(error)
    pendingStarted.reject(error)
  }, MANAGED_PLAN.deadlineMs)
  let nativeFinal: Record<string, unknown> = {}
  try {
    session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'managed-desktop',
    })
    await backend.setCookie(session, 'https://managed-fixture.invalid/', {
      name: 'bunly_managed_login',
      value: LOGIN_MARKER,
      secure: true,
      sameSite: 'strict',
    })
    window = await backend.createWindow({
      title: 'Bunly managed desktop',
      bounds: { x: 24, y: 24, width: 960, height: 680 },
    })
    view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await pageStarted.promise
    const terminal = await terminalReady.promise
    const authority = await desktop.captureAuthority(view)
    const retainedSession = desktop.registerSession('session', session, {
      authority,
      permission: 'fixture',
      operations: ['identity', 'cookies'],
    })
    const retainedWindow = desktop.registerWindow('window', window, {
      authority,
      permission: 'fixture',
      operations: ['state'],
    })
    const retainedView = desktop.registerView('view', view, {
      authority,
      permission: 'fixture',
      operations: ['state'],
      dependsOn: [retainedSession, retainedWindow],
    })
    desktop.registerTerminal('terminal', terminals, terminal.handle, {
      authority,
      permission: 'fixture',
      operations: ['identity', 'write'],
      dependsOn: [retainedView],
    })
    identitiesBefore = await currentIdentities()
    await refreshFrontend()
    development = await DevelopmentSession.start({
      projectRoot: root,
      entrypoint: 'backend/service.ts',
      backendRoots: ['backend'],
      frontendRoots: ['frontend'],
      sharedRoots: ['shared'],
      cacheRoot: '.cache',
      configurationFile: 'bunly-dev.json',
      watch: false,
      debounceMs: 0,
      reload: async (bundle) => broker.reload({ entry: bundle.entry, resources: await bindings() }),
      shutdown: () => broker.close(),
      frontendChanged: refreshFrontend,
    })
    await checkpoint()
    ready.resolve()
    rendererTerminal = await complete.promise
    await backend.drainRpc(view)
    assert.equal(accepted, settled)
    assert.equal(successful, MANAGED_PLAN.replacements)
    assert.equal(rendererChecks, MANAGED_PLAN.replacements + 8)
    assert.equal(frontendNotifications, 2)
    assert.equal(frontendAcknowledged, 2)
    assert.equal(pendingAccepted, 1)
    assert.equal(pendingSettled, 1)
    assert.equal(staleMutations, 0)
    for (const name of MANAGED_PLAN.failureCases) assert.equal(failures[name], true)
    assert.equal(rendererTerminal.bytes, sourceBytes)
    assert.equal(rendererTerminal.hash, byteHashText(sourceHash))
    assert.equal(rendererTerminal.acks, MANAGED_PLAN.replacements + 1)
    assert.equal(rendererTerminal.records, rendererTerminal.lastSequence + 1)
    assert.equal(pendingTiming, undefined)
    assert.equal(frontendSources.length, 3)
    identitiesAfter = await stable()
  } catch (error) {
    failureCode =
      error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
        ? error.message
        : 'FIXTURE_ASSERTION'
    ready.reject(new Error(failureCode))
    console.error('BUNLY_MANAGED_FIXTURE_FAILED', error)
  } finally {
    clearTimeout(deadline)
    try {
      await development?.close()
      if (!development) await broker.close()
      await terminals.dispose()
      if (view) await backend.disposeView(view)
      if (session) await backend.disposeSession(session)
      await stopRpc()
      stopStreams()
      const nativeState = (await backend.nativeDiagnostics()) as Record<string, unknown>
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
        nativeFinal[key] = nativeState[key]
      await desktop.dispose()
      await owner.disposeResource(probe)
      owner.dispose()
      assert.equal(owner.diagnostics().resources, 0)
      assert.equal(owner.diagnostics().generations, 0)
      assert.equal(terminals.diagnostics().terminals, 0)
    } catch (error) {
      failureCode ??= 'CLEANUP_FAILED'
      console.error('BUNLY_MANAGED_CLEANUP_FAILED', error)
    }
    const result: ManagedResult = {
      event: 'bunly.managed-development',
      schema: 1,
      passed: failureCode === undefined,
      successfulReplacements: successful,
      rendererChecks,
      failures,
      frontend: {
        notifications: frontendNotifications,
        acknowledged: frontendAcknowledged,
        sharedEdits: shared,
        externalHmr: false,
        sources: frontendSources,
      },
      retirement: {
        accepted: pendingAccepted,
        settled: pendingSettled,
        outcome: pendingOutcome,
        staleMutations,
      },
      identities: {
        before: identitiesBefore,
        after: identitiesAfter,
        stable:
          identitiesAfter !== null &&
          JSON.stringify(identitiesBefore) === JSON.stringify(identitiesAfter),
      },
      terminal: {
        launches,
        runtimeBytes: sourceBytes,
        rendererBytes: rendererTerminal?.bytes ?? 0,
        runtimeHash: byteHashText(sourceHash),
        rendererHash: rendererTerminal?.hash ?? '',
        records: rendererTerminal?.records ?? 0,
        lastSequence: rendererTerminal?.lastSequence ?? 0,
        acks: rendererTerminal?.acks ?? 0,
        released: terminalReleased,
        outputOk,
        processExit: terminalExit,
        terminalClose,
      },
      requests: { accepted, settled, pending: accepted - settled },
      final: {
        owner: owner.diagnostics(),
        broker: broker.diagnostics(),
        desktop: desktop.diagnostics(),
        terminal: terminals.diagnostics(),
        development: development?.diagnostics() ?? {},
        native: nativeFinal,
        nativeSnapshotPhase: 'before-last-window-close',
      },
      restartRequired,
      ...(failureCode ? { failureCode } : {}),
    }
    await rowTail
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.error(
      JSON.stringify({
        event: result.event,
        schema: 1,
        passed: result.passed,
        successfulReplacements: successful,
        rendererChecks,
        failureCode: failureCode ?? null,
      })
    )
    await backend.dispose()
  }
  if (failureCode) throw new Error(failureCode)
}
