import assert from 'node:assert/strict'
import { packagedPageReadiness, pageTimeout } from './page-readiness.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { cefRpcSchema } from './rpc-contract.ts'
import { nativeRpcProbeReadiness } from './rpc-readiness.ts'
import { qualifyRpcSessions } from './rpc-sessions.ts'
export default async function main(backend: CefBackend): Promise<void> {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 5)
  const pageDeadlineMs = pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
  const page = packagedPageReadiness((listener) => backend.observe(listener), pageDeadlineMs)
  const probes = nativeRpcProbeReadiness((listener) => backend.observe(listener), pageDeadlineMs)
  const waits = new Map<string, { started: boolean; aborted: boolean; viewId: string }>()
  const evidence: { renderer?: unknown; hostile: boolean; stale: boolean; protocol: Set<string> } =
    { hostile: false, stale: false, protocol: new Set() }
  const offEvidence = backend.observe((event) => {
    const message = event.data?.['message']
    if (event.event === 'view.console' && typeof message === 'string') {
      // Preserve the exact bounded JS outcome even when the following assertion
      // fails. Native provenance is separately emitted by the diagnostic build.
      if (message.startsWith('BUNLY_RPC_BORROW_DIAGNOSTIC:')) console.error(message)
      if (message.startsWith('BUNLY_RPC_EVIDENCE:'))
        evidence.renderer = JSON.parse(message.slice('BUNLY_RPC_EVIDENCE:'.length))
      if (message === 'BUNLY_RPC_HOSTILE_OK') evidence.hostile = true
      if (message === 'BUNLY_RPC_STALE_DELIVERED') evidence.stale = true
    }
    if (event.event === 'rpc.qualification' && typeof event.data?.['case'] === 'string')
      evidence.protocol.add(event.data['case'])
  })
  function consoleWait(marker: string) {
    let off = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectWait!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      rejectWait = reject
      off = backend.observe((event) => {
        if (event.event === 'view.console' && event.data?.['message'] === marker) {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
      timer = setTimeout(() => {
        off()
        reject(new Error('Native RPC fixture missing: ' + marker))
      }, pageDeadlineMs)
    })
    void promise.catch(() => {})
    return {
      promise,
      close() {
        clearTimeout(timer)
        off()
        rejectWait(new Error('Native RPC fixture closed'))
      },
    }
  }
  const stopRpc = backend.serveRpc(
    cefRpcSchema,
    {
      echo: { capability: 'rpc.echo', handle: (value) => `bun:${value}` },
      binary: { capability: 'rpc.binary', handle: (value) => value },
      wait: {
        capability: 'rpc.wait',
        handle: (value, context) => {
          if (waits.size >= 16 && !waits.has(value)) throw new Error('Fixture wait capacity')
          const state = { started: true, aborted: false, viewId: context.identity.viewId }
          waits.set(value, state)
          return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              context.signal.removeEventListener('abort', abort)
              resolve(value)
            }, 5000)
            const abort = () => {
              state.aborted = true
              clearTimeout(timer)
              if (value === 'cancel') reject(context.signal.reason)
              else queueMicrotask(() => resolve('stale-result-after-revocation'))
            }
            context.signal.addEventListener('abort', abort, { once: true })
            if (context.signal.aborted) abort()
          })
        },
      },
      waitStarted: {
        capability: 'rpc.wait',
        handle: (value) => (waits.get(value)?.started ? 'started' : 'missing'),
      },
      waitAborted: {
        capability: 'rpc.wait',
        handle: (value) => (waits.get(value)?.aborted ? 'aborted' : 'missing'),
      },
    },
    ['app://ui'],
    ['rpc.echo', 'rpc.binary', 'rpc.wait'],
    { limits: { maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 } }
  )
  try {
    const session = await backend.createSession({ partition: 'smoke', persistence: 'ephemeral' })
    const window = await backend.createWindow({
      title: 'Bunly CEF',
      bounds: { x: 0, y: 0, width: 960, height: 640 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await page.wait()
    // Only the explicit adversarial qualifier requires compile-time native probes.
    // Ordinary smoke builds retain all real RPC/lifecycle/session work.
    if (process.env['BUNLY_RPC_QUALIFICATION'] === '1') await probes.wait()
    assert.deepEqual(evidence.renderer, {
      schema: 2,
      json: 'bun:renderer',
      binary: [0, 1, 2, 127, 128, 255],
      cancellation: 'backend-started-and-aborted',
      validation: 'backend-rejected-invalid-input',
    })
    assert.equal(evidence.hostile, true)
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const action of ['navigate', 'close'] as const) {
        const mode = action + cycle
        const started = consoleWait('BUNLY_RPC_LIFECYCLE_STARTED:' + mode)
        let child
        try {
          child = await backend.createView({
            window,
            session,
            url: 'app://ui/rpc-lifecycle.html?mode=' + mode,
            trust: { kind: 'application', origin: 'app://ui' },
          })
          await started.promise
        } finally {
          started.close()
        }
        if (action === 'navigate') {
          await backend.navigate(child, 'app://ui/next.html')
          const unprivileged = consoleWait('BUNLY_RPC_UNPRIVILEGED')
          try {
            await backend.navigate(child, 'app://ui/rpc-lifecycle.html?mode=unprivileged')
            await unprivileged.promise
          } finally {
            unprivileged.close()
          }
          assert.equal(backend.state(child).trust.kind, 'remote')
        }
        await backend.disposeView(child)
        // Disposing a BrowserView must not close its shared native Window or
        // revoke the sibling document. Exercise the actual CEF ownership path.
        assert.equal(backend.diagnostics().windows, 1, 'View disposal closed its parent window')
        assert.equal(backend.diagnostics().views, 1, 'View disposal removed a sibling')
        assert.equal(backend.state(view).trust.kind, 'application')
        await backend.focusView(view)
        assert.equal(
          waits.get(mode)?.aborted,
          true,
          'Native revoke must abort the active Bun handler'
        )
        assert.equal(evidence.stale, false)
      }
      const remoteReady = consoleWait('BUNLY_RPC_UNPRIVILEGED')
      let remote
      try {
        remote = await backend.createView({
          window,
          session,
          url: 'app://ui/rpc-lifecycle.html?mode=unprivileged',
          trust: { kind: 'remote' },
        })
        await remoteReady.promise
      } finally {
        remoteReady.close()
      }
      await backend.disposeView(remote)
      assert.equal(backend.diagnostics().views, 1)
    }
    await qualifyRpcSessions(backend, window, view, session, consoleWait, (mode) => waits.get(mode))
    assert.equal(evidence.stale, false)
    assert.ok(ticks > 0, 'Bun timers must progress while CEF runs')
    await backend.resizeWindow(window, 1000, 700)
    await backend.showWindow(window, false)
    await backend.showWindow(window, true)
    await backend.focusView(view)
    let detachedEvents = 0
    const detach = backend.observe(() => {
      detachedEvents++
    })
    detach()
    for (let cycle = 0; cycle < 20; cycle++) {
      console.error(JSON.stringify({ event: 'bunly.native.cycle', cycle }))
      const w = await backend.createWindow({
        title: 'Lifecycle ' + cycle,
        bounds: { x: -10, y: 20, width: 400, height: 300 },
      })
      const children = await Promise.all(
        Array.from({ length: 2 }, () =>
          backend.createView({
            window: w,
            session,
            url: 'app://ui/next.html',
            trust: { kind: 'application', origin: 'app://ui' },
          })
        )
      )
      await backend.focusView(children[0]!)
      const pending = backend.navigate(children[1]!, 'app://ui/index.html')
      void pending.catch(() => {})
      await Promise.all([
        backend.closeWindow(w),
        backend.closeWindow(w),
        backend.disposeView(children[0]!),
      ])
      await pending.catch(() => {})
      await backend.closeWindow(w)
      await assert.rejects(backend.navigate(children[1]!, 'app://ui/next.html'))
      assert.equal(backend.diagnostics().windows, 1)
      assert.equal(backend.diagnostics().views, 1)
    }
    assert.equal(detachedEvents, 0)
    await assert.rejects(backend.navigate(view, 'https://blocked.invalid/'))
    await assert.rejects(
      backend.createWindow({ title: 'bad', bounds: { x: 0, y: 0, width: 0, height: 1 } })
    )
    await assert.rejects(
      backend.createView({ window, session, url: 'file:///tmp/secret', trust: { kind: 'remote' } })
    )
    const second = await backend.createWindow({
      title: 'Bunly second window',
      bounds: { x: 30, y: 30, width: 600, height: 400 },
    })
    const other = await backend.createView({
      window: second,
      session,
      url: 'app://ui/next.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    // Do not wait for the initial next.html load: this reproduces the callback
    // race that previously attributed its ERR_ABORTED to the new navigation.
    const navigated = await backend.navigate(other, 'app://ui/index.html')
    assert.equal(navigated.url, 'app://ui/index.html')
    const firstDocument = navigated.documentId
    const reloaded = await backend.navigate(other, 'app://ui/index.html')
    assert.equal(reloaded.url, 'app://ui/index.html')
    assert.notEqual(reloaded.documentId, firstDocument)
    await assert.rejects(
      backend.navigate(other, 'app://ui/index.html#fragment'),
      /same-document navigation/
    )
    assert.equal((await backend.navigate(other, 'app://ui/next.html')).url, 'app://ui/next.html')
    await backend.closeWindow(second)
    await assert.rejects(backend.navigate(other, 'app://ui/next.html'))
    await backend.navigate(view, 'app://ui/next.html')
    await assert.rejects(backend.disposeSession(session))
    const rpcResources = (await backend.nativeDiagnostics()) as Record<string, unknown>
    assert.equal(rpcResources['rpcBindings'], 0)
    assert.equal(rpcResources['rpcIncomingBytes'], 0)
    // Lost renderer receipts remain charged until host teardown, not silently
    // released on revoke. Even repeated close/navigation must stay within caps.
    assert.ok(Number.isSafeInteger(rpcResources['rpcDeliveryPackets']))
    assert.ok(Number(rpcResources['rpcDeliveryPackets']) <= 128)
    assert.ok(Number.isSafeInteger(rpcResources['rpcDeliveryBytes']))
    assert.ok(Number(rpcResources['rpcDeliveryBytes']) <= 128 * 24 * 1024)
    console.log(
      JSON.stringify({
        event: 'bunly.native.rpc',
        schema: 4,
        sessionAuthority: 'native-owner-isolation-and-partition-reuse',
        viewDisposal: 'isolated-and-parent-close',
        renderer: evidence.renderer,
        hostileExternalScript: evidence.hostile,
        lifecycleCycles: 2,
        navigationPending: true,
        closePending: true,
        returnUnprivileged: true,
        remoteUnprivileged: true,
        staleDelivered: evidence.stale,
        resourcesBounded: true,
        protocolCases: [...evidence.protocol].sort(),
      })
    )
    console.log(
      JSON.stringify({
        event: 'bunly.native.smoke',
        pageDeadlineMs,
        passed: true,
        rpcQualified: process.env['BUNLY_RPC_QUALIFICATION'] === '1',
        cycles: 20,
        timers: ticks,
        diagnostics: await backend.nativeDiagnostics(),
      })
    )
    if (process.env['BUNLY_TEST_LAST_WINDOW'] === '1') {
      await backend.closeWindow(window)
      await backend.closed
      assert.equal(backend.diagnostics().windows, 0)
      assert.equal(backend.diagnostics().views, 0)
      console.error(JSON.stringify({ event: 'bunly.native.last-window', passed: true }))
    } else await backend.dispose()
  } finally {
    offEvidence()
    stopRpc()
    clearInterval(timer)
    page.close()
    probes.close()
  }
}
