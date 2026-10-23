import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'
import { cefRpcSchema } from './rpc-contract.ts'
import { nativeNetworkCases } from '../../benchmarks/lib/cef-network-acceptance.ts'

export default async function network(backend: CefBackend): Promise<void> {
  const first = process.env['BUNLY_NETWORK_FIRST']
  const second = process.env['BUNLY_NETWORK_SECOND']
  const blocked = process.env['BUNLY_NETWORK_BLOCKED']
  const tls = process.env['BUNLY_NETWORK_TLS']
  const publicHttps = process.env['BUNLY_NETWORK_PUBLIC_HTTPS']
  assert.ok(
    first && second && blocked && tls && publicHttps,
    'Private network fixture origins missing'
  )
  const pendingWaiters = new Set<() => void>()
  let stale = false
  const offStale = backend.observe((event) => {
    if (event.event === 'view.console' && event.data?.['message'] === 'BUNLY_RPC_STALE_DELIVERED')
      stale = true
  })
  function waiting(label: string, matches: (event: NativeEvent) => boolean) {
    let remove = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectWait!: (e: Error) => void
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      remove()
      pendingWaiters.delete(close)
      if (error) rejectWait(error)
    }
    const close = () => finish(new Error('Network waiter disposed: ' + label))
    const promise = new Promise<void>((resolve, reject) => {
      rejectWait = reject
      remove = backend.observe((event) => {
        const message = event.event === 'view.console' ? event.data?.['message'] : undefined
        if (typeof message === 'string' && message.startsWith('BUNLY_NETWORK_FAILED:'))
          finish(new Error(message))
        else if (matches(event)) {
          finish()
          resolve()
        }
      })
      timer = setTimeout(
        () => finish(new Error('Missing native network evidence: ' + label)),
        10000
      )
    })
    void promise.catch(() => {})
    pendingWaiters.add(close)
    return { promise, close }
  }
  const marker = (text: string) =>
    waiting(text, (event) => event.event === 'view.console' && event.data?.['message'] === text)
  const waits = new Map<string, { view: string; aborted: boolean }>()
  const stopRpc = backend.serveRpc(
    cefRpcSchema,
    {
      echo: { capability: 'echo', handle: (value) => value },
      binary: { capability: 'binary', handle: (value) => value },
      wait: {
        capability: 'wait',
        handle: (value, context) => {
          assert.equal(value, 'network-revoke')
          assert.equal(waits.size, 0)
          const state = { view: context.identity.viewId, aborted: false }
          waits.set(value, state)
          return new Promise<string>((resolve) => {
            const abort = () => {
              state.aborted = true
              resolve('late-after-revocation')
            }
            context.signal.addEventListener('abort', abort, { once: true })
            if (context.signal.aborted) abort()
          })
        },
      },
      waitStarted: {
        capability: 'wait',
        handle: (value) => (waits.has(value) ? 'started' : 'missing'),
      },
      waitAborted: {
        capability: 'wait',
        handle: (value) => (waits.get(value)?.aborted ? 'aborted' : 'missing'),
      },
    },
    ['app://ui'],
    ['echo', 'binary', 'wait'],
    { limits: { maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 } }
  )
  try {
    const window = await backend.createWindow({
      title: 'Bunly network authority qualification',
      bounds: { x: 10, y: 10, width: 700, height: 500 },
    })
    const restricted = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'network-default',
    })
    const defaults = { window, session: restricted, trust: { kind: 'remote' } as const }
    await assert.rejects(
      backend.createView({ ...defaults, url: first + '/remote' }),
      /session origin/
    )
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'network-allowed',
      network: { allowedOrigins: [first, second, tls, publicHttps] },
    })
    const onlyFirst = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'network-isolated',
      network: { allowedOrigins: [first] },
    })
    await assert.rejects(
      backend.createView({
        window,
        session: onlyFirst,
        url: second + '/landing',
        trust: { kind: 'remote' },
      }),
      /session origin/
    )
    await assert.rejects(
      backend.createView({
        window,
        session,
        url: first + '/remote',
        trust: { kind: 'application', origin: first },
      }),
      /application RPC is limited/
    )
    const isolatedReady = marker('BUNLY_NETWORK_ISOLATED_OK')
    const isolatedView = await backend.createView({
      window,
      session: onlyFirst,
      url: first + '/isolated',
      trust: { kind: 'remote' },
    })
    await isolatedReady.promise
    isolatedReady.close()
    await backend.disposeView(isolatedView)
    const deniedChild = waiting(
      'blocked child navigation',
      (event) => event.event === 'network.navigation-denied' && event.data?.['main'] === false
    )
    const ready = marker('BUNLY_NETWORK_REMOTE_OK:initial')
    const loaded = waiting(
      'initial main frame',
      (event) =>
        event.event === 'view.loaded' && event.data?.['url'] === first + '/remote?phase=initial'
    )
    const view = await backend.createView({
      window,
      session,
      url: first + '/remote?phase=initial',
      trust: { kind: 'remote' },
    })
    await Promise.all([ready.promise, loaded.promise, deniedChild.promise])
    ready.close()
    deniedChild.close()
    loaded.close()
    assert.equal(backend.state(view).trust.kind, 'remote')
    const scope = await backend.capturePolicyScope(view)
    await backend.setBrowserApplicationPolicy(scope, 'notifications', 'granted')
    const landed = marker('BUNLY_NETWORK_LANDING_OK')
    assert.equal(
      (await backend.navigate(view, first + '/redirect-allowed')).url,
      second + '/landing'
    )
    await landed.promise
    landed.close()
    await assert.rejects(backend.recordBrowserUserDecision(scope, 'camera', 'granted'), /stale/)
    await assert.rejects(backend.navigate(view, first + '/redirect-denied'))
    await assert.rejects(backend.navigate(view, blocked + '/main'))
    const certificate = waiting(
      'certificate denial',
      (event) => event.event === 'policy.certificate-denied'
    )
    await assert.rejects(backend.navigate(view, tls + '/'))
    await certificate.promise
    certificate.close()
    const recovered = marker('BUNLY_NETWORK_LANDING_OK')
    await backend.navigate(view, second + '/landing')
    await recovered.promise
    recovered.close()
    const httpsLoaded = waiting(
      'ordinary HTTPS verification',
      (event) =>
        event.event === 'view.loaded' &&
        event.data?.['url'] === publicHttps + '/' &&
        Number(event.data['status']) >= 200 &&
        Number(event.data['status']) < 300
    )
    await backend.navigate(view, publicHttps + '/')
    await httpsLoaded.promise
    httpsLoaded.close()
    assert.equal(backend.state(view).trust.kind, 'remote')
    assert.equal(((await backend.nativeDiagnostics()) as Record<string, unknown>)['rpcBindings'], 0)
    await backend.disposeView(view)
    const started = marker('BUNLY_RPC_LIFECYCLE_STARTED:network-revoke')
    const trusted = await backend.createView({
      window,
      session,
      url: 'app://ui/rpc-lifecycle.html?mode=network-revoke',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await started.promise
    started.close()
    assert.equal(waits.get('network-revoke')?.view, trusted.id)
    const deniedAfter = waiting(
      'blocked child after trust revocation',
      (event) => event.event === 'network.navigation-denied' && event.data?.['main'] === false
    )
    const remote = marker('BUNLY_NETWORK_REMOTE_OK:after-trust')
    await backend.navigate(trusted, first + '/remote?phase=after-trust')
    await Promise.all([remote.promise, deniedAfter.promise])
    remote.close()
    deniedAfter.close()
    assert.equal(waits.get('network-revoke')?.aborted, true)
    assert.equal(backend.state(trusted).trust.kind, 'remote')
    const unprivileged = marker('BUNLY_RPC_UNPRIVILEGED')
    await backend.navigate(trusted, 'app://ui/rpc-lifecycle.html?mode=unprivileged')
    await unprivileged.promise
    unprivileged.close()
    assert.equal(backend.state(trusted).trust.kind, 'remote')
    assert.equal(stale, false)
    await backend.disposeView(trusted)
    for (const value of [session, onlyFirst, restricted]) await backend.disposeSession(value)
    const diagnostics = (await backend.nativeDiagnostics()) as Record<string, unknown>
    assert.equal(diagnostics['windows'], 1)
    for (const key of ['views', 'sessions', 'rpcBindings', 'rpcIncomingBytes'])
      assert.equal(diagnostics[key], 0, key)
    // Lost renderer receipts can remain conservatively charged until host teardown.
    offStale()
    stopRpc()
    assert.equal(pendingWaiters.size, 0)
    assert.equal(backend.diagnostics().listeners, 0)
    console.error(
      JSON.stringify({
        event: 'bunly.native.network',
        schema: 1,
        passed: true,
        cases: nativeNetworkCases,
        certificatePolicy: 'ordinary-verifier-no-exception',
        fixture: 'loopback-public-https-and-untrusted-tls',
      })
    )
  } finally {
    for (const close of pendingWaiters) close()
    offStale()
    stopRpc()
    await backend.dispose()
  }
}
