import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { NativeEvent } from '../../packages/runtime/src/native-transport.ts'
import type { RpcHandlers } from '../../packages/runtime/src/rpc.ts'
import {
  transportSchema,
  transportLimits,
  RPC_TRANSPORT_WORKLOAD,
  type TransportPageReport,
} from './transport-contract.ts'

export default async function transport(backend: CefBackend): Promise<void> {
  // Keep failure diagnostics within the maintained bounded stderr tail.
  Error.stackTraceLimit = 3
  const candidate = process.env['BUNLY_RPC_TRANSPORT']
  assert.ok(candidate === 'native-mediated' || candidate === 'authenticated-loopback')
  const pending = new Set<() => void>()
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  void failure.catch(() => {})
  let reachabilityGrants = 0
  const consoleFailures: string[] = []
  const nativeEvents: string[] = []
  const offFailure = backend.observe((event) => {
    if (event.event === 'policy.loopback-fixture-network' && ++reachabilityGrants > 8)
      rejectFailure(new Error('Excessive fixture network permission receipts'))
    if (event.event.startsWith('policy.')) {
      consoleFailures.push(event.event + ':' + String(event.data?.['permissions']))
      if (consoleFailures.length > 4) consoleFailures.shift()
    }
    if (['rpc.connected', 'rpc.revoked', 'view.loaded', 'view.navigating'].includes(event.event)) {
      nativeEvents.push(event.event)
      if (nativeEvents.length > 8) nativeEvents.shift()
    }
    if (event.event !== 'view.console' || typeof event.data?.['message'] !== 'string') return
    const message = event.data['message']
    if (
      message.includes('WebSocket') ||
      message.includes('Content Security Policy') ||
      message.includes('not allowed') ||
      message.startsWith('BUNLY_TRANSPORT_CSP:')
    ) {
      consoleFailures.push(message.slice(0, 256))
      if (consoleFailures.length > 4) consoleFailures.shift()
    }
    if (message.startsWith('BUNLY_TRANSPORT_FAILED:'))
      rejectFailure(
        new Error(
          message +
            '; transport=' +
            JSON.stringify(backend.rpcDiagnostics()) +
            '; nativeEvents=' +
            nativeEvents.join(',') +
            '; browser=' +
            JSON.stringify(consoleFailures)
        )
      )
  })
  function wait(label: string, match: (event: NativeEvent) => boolean) {
    let remove = () => {},
      timer: ReturnType<typeof setTimeout> | undefined,
      rejectWait!: (error: Error) => void,
      done = false
    const close = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      remove()
      pending.delete(close)
      rejectWait(new Error('Transport wait cancelled: ' + label))
    }
    const promise = new Promise<void>((resolve, reject) => {
      rejectWait = reject
      remove = backend.observe((event) => {
        if (!done && match(event)) {
          done = true
          clearTimeout(timer)
          remove()
          pending.delete(close)
          resolve()
        }
      })
      timer = setTimeout(() => {
        close()
        rejectFailure(new Error('Missing transport evidence: ' + label))
      }, 15000)
    })
    void promise.catch(() => {})
    pending.add(close)
    return { promise: Promise.race([promise, failure]), close }
  }
  const marker = (label: string) =>
    wait(label, (event) => event.event === 'view.console' && event.data?.['message'] === label)
  const structured = new Set<number>(),
    throttled = new Set<number>(),
    cancelled = new Map<number, boolean>(),
    held = new Map<string, { aborted: boolean; view: string }>()
  let firstCalls = 0,
    binaryCalls = 0,
    forbiddenCalls = 0,
    reported: TransportPageReport | undefined
  const barriers = new Map<string, (value: string) => void>()
  const handlers: RpcHandlers<typeof transportSchema> = {
    structured: {
      capability: 'transport',
      handle: (value) => {
        if (value.label === 'must-not-run') {
          forbiddenCalls++
          throw new Error('Stolen credential was admitted')
        }
        if (value.label === 'handoff') {
          assert.equal(value.index, 0)
          assert.equal(++firstCalls, 1)
        } else {
          const set =
            value.label === 'timed'
              ? structured
              : value.label === 'throttled'
                ? throttled
                : undefined
          assert.ok(set)
          assert.ok(!set.has(value.index))
          assert.ok(value.index < (value.label === 'timed' ? 100 : 20))
          set.add(value.index)
        }
        return value
      },
    },
    binary: {
      capability: 'transport',
      handle: (bytes) => {
        assert.ok(++binaryCalls <= 50)
        for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], i & 255)
        return bytes
      },
    },
    cancel: {
      capability: 'transport',
      handle: (index, context) => {
        assert.ok(index < 20 && !cancelled.has(index))
        cancelled.set(index, false)
        return new Promise<null>((resolve) => {
          const abort = () => {
            cancelled.set(index, true)
            resolve(null)
          }
          context.signal.addEventListener('abort', abort, { once: true })
          if (context.signal.aborted) abort()
        })
      },
    },
    cancelState: {
      capability: 'transport',
      handle: (index) =>
        cancelled.has(index) ? (cancelled.get(index) ? 'aborted' : 'started') : 'missing',
    },
    barrier: {
      capability: 'transport',
      handle: (label, context) => {
        assert.ok(['throttle', 'restore'].includes(label) && !barriers.has(label))
        return new Promise<string>((resolve, reject) => {
          barriers.set(label, resolve)
          context.signal.addEventListener(
            'abort',
            () => {
              barriers.delete(label)
              reject(new Error('Barrier retired'))
            },
            { once: true }
          )
        })
      },
    },
    report: {
      capability: 'transport',
      handle: (value) => {
        assert.equal(reported, undefined)
        assert.equal(firstCalls, 1)
        assert.equal(structured.size, 100)
        assert.equal(throttled.size, 20)
        assert.equal(binaryCalls, 50)
        assert.equal(cancelled.size, 20)
        assert.ok([...cancelled.values()].every(Boolean))
        reported = value
        return null
      },
    },
    hold: {
      capability: 'transport',
      handle: (label, context) => {
        assert.ok(['navigate', 'disconnect'].includes(label) && !held.has(label))
        const state = { aborted: false, view: context.identity.viewId }
        held.set(label, state)
        return new Promise<string>((resolve) => {
          const abort = () => {
            state.aborted = true
            resolve('late')
          }
          context.signal.addEventListener('abort', abort, { once: true })
          if (context.signal.aborted) abort()
        })
      },
    },
    holdState: {
      capability: 'transport',
      handle: (label) =>
        held.has(label) ? (held.get(label)?.aborted ? 'aborted' : 'started') : 'missing',
    },
  }
  let stop: (() => void | Promise<void>) | undefined
  try {
    stop =
      candidate === 'native-mediated'
        ? backend.serveRpc(transportSchema, handlers, ['app://ui'], ['transport'], {
            limits: transportLimits,
          })
        : await backend.serveLoopbackRpc(transportSchema, handlers, ['app://ui'], ['transport'], {
            limits: transportLimits,
          })
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'transport',
    })
    const window = await backend.createWindow({
      title: 'Bunly transport qualification',
      bounds: { x: 10, y: 10, width: 700, height: 500 },
    })
    const create = (role: string) =>
      backend.createView({
        window,
        session,
        url: `app://ui/transport.html?candidate=${candidate}&role=${role}`,
        trust: { kind: 'application', origin: 'app://ui' },
      })
    const loaded = wait(
      'main document ready',
      (event) => event.event === 'view.loaded' && String(event.data?.['url']).endsWith('&role=main')
    )
    const throttle = marker('BUNLY_TRANSPORT_THROTTLE_READY'),
      restore = marker('BUNLY_TRANSPORT_RESTORE_READY'),
      completed = marker('BUNLY_TRANSPORT_WORK_DONE'),
      disconnectStarted = marker('BUNLY_TRANSPORT_DISCONNECT_STARTED'),
      disconnected = marker('BUNLY_TRANSPORT_DISCONNECTED')
    const view = await create('main')
    await Promise.all([loaded.promise, throttle.promise])
    loaded.close()
    throttle.close()
    const scope = await backend.capturePolicyScope(view)
    await backend.qualifyTransportThrottle(scope, 4)
    assert.ok(barriers.has('throttle'))
    barriers.get('throttle')!('throttled')
    barriers.delete('throttle')
    await restore.promise
    restore.close()
    await backend.qualifyTransportThrottle(scope, 1)
    assert.ok(barriers.has('restore'))
    barriers.get('restore')!('restored')
    barriers.delete('restore')
    await completed.promise
    completed.close()
    await disconnectStarted.promise
    disconnectStarted.close()
    assert.ok(reported)
    assert.equal(held.get('disconnect')?.view, view.id)
    const diagnostics = backend.rpcDiagnostics()
    assert.equal(diagnostics.servers.length, 1)
    const server = diagnostics.servers[0]!
    assert.ok(server.peakQueuedBytes <= 2 * 1024 * 1024 && server.peakQueuedFrames <= 128)
    // Same bounded control waiter is present in both idle observations. There is
    // no application polling; one future deadline and one backend sleep exist.
    console.error(
      JSON.stringify({ event: 'bunly.transport.phase', schema: 1, phase: 'transport-idle' })
    )
    await Promise.race([Bun.sleep(2000), failure])
    console.error(
      JSON.stringify({ event: 'bunly.transport.phase', schema: 1, phase: 'transport-work' })
    )
    const navigationStarted = marker('BUNLY_TRANSPORT_NAVIGATION_STARTED')
    const navigating = await create('revoke')
    await navigationStarted.promise
    navigationStarted.close()
    assert.equal(held.get('navigate')?.view, navigating.id)
    await backend.navigate(navigating, 'about:blank')
    assert.equal(held.get('navigate')?.aborted, true)
    const unprivileged = marker('BUNLY_TRANSPORT_UNPRIVILEGED')
    await backend.navigate(
      navigating,
      `app://ui/transport.html?candidate=${candidate}&role=unprivileged`
    )
    await unprivileged.promise
    unprivileged.close()
    assert.equal(backend.state(navigating).trust.kind, 'remote')
    await backend.disposeView(navigating)
    if (candidate === 'authenticated-loopback') {
      const ready = marker('BUNLY_TRANSPORT_ATTACK_READY'),
        denied = marker('BUNLY_TRANSPORT_ATTACK_DENIED')
      const foreign = await create('attack-foreign')
      await ready.promise
      ready.close()
      const owner = await create('attack-owner')
      await denied.promise
      denied.close()
      assert.equal(backend.rpcDiagnostics().nativeConfirmationRejections, 1)
      assert.equal(forbiddenCalls, 0)
      await backend.disposeView(foreign)
      await backend.disposeView(owner)
    }
    const beforeStop = backend.rpcDiagnostics()
    await stop()
    stop = undefined
    await disconnected.promise
    disconnected.close()
    assert.equal(held.get('disconnect')?.aborted, true)
    const afterStop = backend.rpcDiagnostics()
    assert.equal(afterStop.connections, 0)
    assert.equal(afterStop.fragments.retainedBytes, 0)
    assert.equal(afterStop.loopback, null)
    assert.equal(afterStop.servers.length, 0)
    await backend.disposeView(view)
    await backend.disposeSession(session)
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    for (const key of ['views', 'sessions', 'rpcBindings', 'rpcIncomingBytes'])
      assert.equal(native[key], 0)
    assert.equal(native['windows'], 1)
    offFailure()
    assert.equal(pending.size, 0)
    assert.equal(backend.diagnostics().listeners, 0)
    assert.ok(
      candidate === 'authenticated-loopback' ? reachabilityGrants > 0 : reachabilityGrants === 0
    )
    console.error(
      JSON.stringify({
        event: 'bunly.native.transport',
        schema: 2,
        networkPermission: {
          scope:
            candidate === 'authenticated-loopback'
              ? 'contributor-only-top-origin-reachability'
              : 'not-requested',
          observedGrants: reachabilityGrants,
        },
        passed: true,
        candidate,
        workload: RPC_TRANSPORT_WORKLOAD,
        metrics: {
          handoffMs: reported.handoffMs,
          structuredMs: reported.structuredMs,
          binaryMs: reported.binaryMs,
          cancellationMs: reported.cancellationMs,
          throttledMs: reported.throttledMs,
        },
        queuePeaks: {
          clientFrames: reported.clientFrames,
          clientBytes: reported.clientBytes,
          serverFrames: server.peakQueuedFrames,
          serverBytes: server.peakQueuedBytes,
        },
        validation: {
          structured: 100,
          binaryCalls: 50,
          binaryBytes: 65536,
          cancellations: 20,
          throttledCalls: 20,
          nativeThrottleRate: 4,
          throttleRestored: true,
          navigationRevocation: true,
          returnDenied: true,
          serviceDisconnect: true,
          serverClose: true,
          resourcesReleased: true,
          crossViewCredentialDenied:
            candidate === 'authenticated-loopback'
              ? 'native-confirmation-rejected'
              : 'no-loopback-listener',
        },
        nativeConfirmation: {
          accepted: beforeStop.nativeConfirmations,
          rejected: beforeStop.nativeConfirmationRejections,
        },
        fragmentBudget: afterStop.fragments,
        idleProfile: 'two-seconds-with-one-admitted-control-waiter-no-polling',
      })
    )
    console.error(
      JSON.stringify({ event: 'bunly.transport.phase', schema: 1, phase: 'transport-complete' })
    )
  } finally {
    for (const close of pending) close()
    offFailure()
    await stop?.()
    await backend.dispose()
  }
}
