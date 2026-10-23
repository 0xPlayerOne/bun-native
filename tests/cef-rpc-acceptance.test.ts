import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { acceptNativeRpc, nativeRpcCases } from '../benchmarks/lib/cef-rpc-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

test('native RPC acceptance rejects old smoke, incomplete attacks, unstarted cancellation and stale successes', () => {
  // Synthetic parser inputs, explicitly not a native execution claim.
  const rpc = {
    event: 'bunly.native.rpc',
    schema: 2,
    renderer: {
      schema: 2,
      json: 'bun:renderer',
      binary: [0, 1, 2, 127, 128, 255],
      cancellation: 'backend-started-and-aborted',
      validation: 'backend-rejected-invalid-input',
    },
    hostileExternalScript: true,
    lifecycleCycles: 2,
    navigationPending: true,
    closePending: true,
    returnUnprivileged: true,
    remoteUnprivileged: true,
    staleDelivered: false,
    resourcesBounded: true,
    protocolCases: nativeRpcCases,
  }
  const report: CommandObservation = {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cleanupSurvivors: [],
    outputOverflow: false,
    observedOrphans: [],
    elapsedMs: 1,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    stdoutTail: [],
    samples: [],
    environment: { classification: 'synthetic-unit-input-not-native-evidence' },
    stderr: [
      JSON.stringify({
        event: 'bunly.native.smoke',
        passed: true,
        rpcQualified: true,
        cycles: 20,
        timers: 1,
        diagnostics: { windows: 1, views: 1, sessions: 1 },
      }),
      JSON.stringify({ event: 'bunly.backend.exit', code: 0, forced: false }),
      JSON.stringify({ event: 'bunly.host.shutdown', clean: true }),
    ],
  }
  assert.throws(() => acceptNativeRpc(report))
  const withRpc = (value: unknown) => ({
    ...report,
    stderr: [...report.stderr, JSON.stringify(value)],
  })
  acceptNativeRpc(withRpc(rpc))
  for (const change of [
    { protocolCases: [] },
    { hostileExternalScript: false },
    { lifecycleCycles: 0 },
    { staleDelivered: true },
    { resourcesBounded: false },
    { renderer: { ...rpc.renderer, cancellation: 'locally-cancelled' } },
  ])
    assert.throws(() => acceptNativeRpc(withRpc({ ...rpc, ...change })))
})
