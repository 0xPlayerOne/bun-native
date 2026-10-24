import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptNativeRpc,
  acceptNativeRpcSuite,
  nativeRpcCases,
  nativeRpcLaunchNames,
} from '../benchmarks/lib/cef-rpc-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

function fixture() {
  // Synthetic parser inputs, explicitly not a native execution claim.
  const rpc = {
    event: 'bunly.native.rpc',
    schema: 5,
    controlAdmission: {
      ordinaryRequests: 96,
      ordinaryOverflowDenied: true,
      control: 'session.dispose',
      controlCompleted: true,
      controlAdmittedWhileFull: true,
      fifoPreserved: true,
      nativeBudgetBounded: true,
      finalSessions: 0,
      priorTaskReservationsReleased: true,
    },
    sessionAuthority: 'native-owner-isolation-and-partition-reuse',
    viewDisposal: 'isolated-and-parent-close',
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
      JSON.stringify({ event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start' }),
      JSON.stringify({ event: 'bunly.backend.exit', code: 0, forced: false }),
      JSON.stringify({
        event: 'bunly.host.shutdown-phase',
        phase: 'process-stop',
        state: 'complete',
        durationMs: 1,
      }),
      ...['host-release', 'asset-service-stop', 'cef-shutdown'].flatMap((phase) => [
        JSON.stringify({ event: 'bunly.host.shutdown-phase', phase, state: 'start' }),
        JSON.stringify({
          event: 'bunly.host.shutdown-phase',
          phase,
          state: 'complete',
          durationMs: 0,
        }),
      ]),
      JSON.stringify({ event: 'bunly.host.shutdown', clean: true }),
    ],
  }
  const withRpc = (value: unknown) => ({
    ...report,
    stderr: [...report.stderr, JSON.stringify(value)],
  })
  return { rpc, report, withRpc }
}

test('native RPC acceptance rejects old smoke, incomplete attacks, unstarted cancellation and stale successes', () => {
  const { rpc, report, withRpc } = fixture()
  assert.throws(() => acceptNativeRpc(report))
  acceptNativeRpc(withRpc(rpc))
  assert.throws(() => acceptNativeRpc(withRpc(rpc), true), /helper\/clone/)
  const complete = withRpc(rpc)
  assert.throws(() =>
    acceptNativeRpc({
      ...complete,
      stderr: complete.stderr.filter((line) => !line.includes('shutdown-phase')),
    })
  )
  assert.throws(() =>
    acceptNativeRpc({
      ...complete,
      stderr: complete.stderr.filter((line) => !line.includes('cef-shutdown')),
    })
  )
  assert.throws(() =>
    acceptNativeRpc({ ...complete, stderr: [...complete.stderr, complete.stderr[1]!] })
  )
  for (const change of [
    { schema: 4 },
    { controlAdmission: undefined },
    { controlAdmission: { ...rpc.controlAdmission, controlAdmittedWhileFull: false } },
    { controlAdmission: { ...rpc.controlAdmission, controlCompleted: false } },
    { controlAdmission: { ...rpc.controlAdmission, fifoPreserved: false } },
    { controlAdmission: { ...rpc.controlAdmission, priorTaskReservationsReleased: false } },
    { protocolCases: [] },
    { protocolCases: nativeRpcCases.filter((name) => name !== 'wrong-frame') },
    { sessionAuthority: undefined },
    { sessionAuthority: 'mock-only' },
    { viewDisposal: undefined },
    { hostileExternalScript: false },
    { lifecycleCycles: 0 },
    { staleDelivered: true },
    { resourcesBounded: false },
    { renderer: { ...rpc.renderer, cancellation: 'locally-cancelled' } },
  ])
    assert.throws(() => acceptNativeRpc(withRpc({ ...rpc, ...change })))
})

function cleanup(qualified: boolean, passed = true) {
  return {
    schema: 1,
    profile: 'macos-verified-code-sign-clone-v1',
    passed,
    qualified: qualified && passed,
    status: !passed ? 'failed' : qualified ? 'completed' : 'not-observed',
    elapsedMs: 100,
    limitMs: 3000,
    observedClones: 1,
    cloneInventory: {
      prelaunchEntries: 0,
      entryLimit: 256,
      scope: 'new-names-after-prelaunch-snapshot',
    },
    helpers: qualified
      ? [
          {
            pid: 123,
            creationTime: 1,
            role: 'code-sign-clone-cleanup',
            executableSha256: 'a'.repeat(64),
            ownership: 'observed-root-child-and-matching-clone-inode',
            processExited: passed,
            cloneRemoved: passed,
            completed: passed,
          },
        ]
      : [],
  }
}
function suite() {
  const { rpc, withRpc } = fixture()
  return nativeRpcLaunchNames.map((name, index) => ({
    name: String(name),
    observation: { ...withRpc(rpc), schema: 1, postExitCleanup: cleanup(index === 0) },
  }))
}
test('native RPC suite reports sampling gaps without calling them qualified helper completions', () => {
  const trials = suite()
  const result = acceptNativeRpcSuite(trials, true)
  assert.equal(result.acceptedLaunches, 5)
  assert.deepEqual(result.helperCleanup.qualifiedLaunches, ['installed-0'])
  assert.deepEqual(result.helperCleanup.unobservedLaunches, nativeRpcLaunchNames.slice(1))
  assert.equal(trials[1]!.observation.postExitCleanup.qualified, false)
  assert.equal(trials[1]!.observation.postExitCleanup.status, 'not-observed')
})
test('native RPC suite never hides a failed helper, command, or missing proof behind another good launch', () => {
  for (const index of [0, 1, 4]) {
    const trials = suite()
    trials[index]!.observation.postExitCleanup = cleanup(true, false)
    assert.throws(() => acceptNativeRpcSuite(trials, true), /cleanup failed/)
  }
  const none = suite().map((trial) => ({
    ...trial,
    observation: { ...trial.observation, postExitCleanup: cleanup(false) },
  }))
  assert.throws(() => acceptNativeRpcSuite(none, true), /no verified/)
  const missing = suite().map((trial) => ({
    ...trial,
    observation: { ...trial.observation, postExitCleanup: undefined },
  }))
  assert.throws(() => acceptNativeRpcSuite(missing, true), /unavailable/)
  const forged = suite()
  forged[1]!.observation.postExitCleanup.qualified = true
  assert.throws(() => acceptNativeRpcSuite(forged, true), /Inconsistent/)
  const exit = suite()
  exit[1]!.observation.exitCode = 2
  assert.throws(() => acceptNativeRpcSuite(exit, true), /unexpected exit/)
})
test('native RPC suite requires the complete unique launch matrix on every platform', () => {
  const trials = suite()
  assert.throws(() => acceptNativeRpcSuite(trials.slice(1)), /incomplete/)
  assert.throws(() => acceptNativeRpcSuite([...trials, trials[0]!]), /incomplete/)
  assert.throws(
    () => acceptNativeRpcSuite([trials[0]!, trials[0]!, ...trials.slice(2)]),
    /Duplicate/
  )
  const unknown = suite()
  unknown[0]!.name = 'installed-invented'
  assert.throws(() => acceptNativeRpcSuite(unknown))
  const nonMac = suite().map((trial) => ({
    ...trial,
    observation: { ...trial.observation, postExitCleanup: undefined },
  }))
  assert.equal(acceptNativeRpcSuite(nonMac).helperCleanup.scope, 'not-applicable')
})
