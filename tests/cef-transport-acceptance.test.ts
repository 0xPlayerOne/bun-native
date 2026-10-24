import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptNativeTransport,
  idleKernelObservation,
} from '../benchmarks/lib/cef-transport-acceptance.ts'
import { RPC_TRANSPORT_WORKLOAD, assertComparable } from '../benchmarks/rpc-transport-comparison.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'
function fixture() {
  const evidence = {
    event: 'bunly.native.transport',
    schema: 1,
    passed: true,
    candidate: 'authenticated-loopback',
    workload: RPC_TRANSPORT_WORKLOAD,
    metrics: { handoffMs: 1, structuredMs: 1, binaryMs: 1, cancellationMs: 1, throttledMs: 1 },
    queuePeaks: { clientFrames: 16, clientBytes: 65536, serverFrames: 16, serverBytes: 65536 },
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
      crossViewCredentialDenied: 'native-confirmation-rejected',
    },
    nativeConfirmation: { accepted: 2, rejected: 1 },
    fragmentBudget: { retainedBytes: 0, peakRetainedBytes: 0, maxRetainedBytes: 3 * 1024 * 1024 },
    idleProfile: 'two-seconds-with-one-admitted-control-waiter-no-polling',
  }
  const phases = ['process-stop', 'host-release', 'asset-service-stop', 'cef-shutdown'].flatMap(
    (phase, index) => [
      { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
      ...(index === 0 ? [{ event: 'bunly.backend.exit', code: 0, forced: false }] : []),
      { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: 1 },
    ]
  )
  const observation: CommandObservation = {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    elapsedMs: 10,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    observedOrphans: [],
    cleanupSurvivors: [],
    stdoutTail: [],
    stderr: [
      { event: 'bunly.native.transport-throttle', rate: 4, completed: true },
      { event: 'bunly.native.transport-throttle', rate: 1, completed: true },
      ...phases,
      { event: 'bunly.host.shutdown', clean: true },
    ].map((value) => JSON.stringify(value)),
    samples: [],
    environment: {},
  }
  const withEvidence = (value: unknown) => ({
    ...observation,
    stderr: [JSON.stringify(value), ...observation.stderr],
  })
  return { evidence, observation, withEvidence }
}
test('transport acceptance requires all real native work, throttle completion, denial and teardown', () => {
  const f = fixture()
  const accepted = acceptNativeTransport(f.withEvidence(f.evidence), 'authenticated-loopback', 0)
  assert.equal(accepted.binaryMs, 1)
  assert.throws(() => acceptNativeTransport(f.observation, 'authenticated-loopback', 0))
  for (const change of [
    { passed: false },
    { schema: 0 },
    { candidate: 'native-mediated' },
    { extra: true },
    { validation: { ...f.evidence.validation, navigationRevocation: false } },
    { validation: { ...f.evidence.validation, crossViewCredentialDenied: 'not-attempted' } },
    { nativeConfirmation: { accepted: 2, rejected: 0 } },
    { metrics: { ...f.evidence.metrics, binaryMs: NaN } },
    { queuePeaks: { ...f.evidence.queuePeaks, serverBytes: 3 * 1024 * 1024 } },
    { fragmentBudget: { ...f.evidence.fragmentBudget, retainedBytes: 1 } },
  ])
    assert.throws(() =>
      acceptNativeTransport(
        f.withEvidence({ ...f.evidence, ...change }),
        'authenticated-loopback',
        0
      )
    )
  for (const change of [
    { exitCode: 2 },
    { timedOut: true },
    { observedOrphans: [1] },
    { cleanupSurvivors: [1] },
    { stderr: f.withEvidence(f.evidence).stderr.slice(0, -2) },
    {
      stderr: f
        .withEvidence(f.evidence)
        .stderr.filter((line) => !line.includes('transport-throttle')),
    },
    { stdoutTail: [JSON.stringify(f.evidence)] },
  ])
    assert.throws(() =>
      acceptNativeTransport(
        { ...f.withEvidence(f.evidence), ...change },
        'authenticated-loopback',
        0
      )
    )
})
test('paired transport gate rejects duplicates, unknown candidates and malformed numeric observations', () => {
  const f = fixture(),
    value = acceptNativeTransport(f.withEvidence(f.evidence), 'authenticated-loopback', 0)
  const trials = (['native-mediated', 'authenticated-loopback'] as const).flatMap((candidate) =>
    Array.from({ length: 5 }, (_, trial) => ({ ...value, candidate, trial }))
  )
  assert.doesNotThrow(() => assertComparable(trials))
  assert.throws(() => assertComparable([...trials, trials[0]!]))
  for (const update of [
    { trial: -1 },
    { trial: 0.5 },
    { binaryMs: Infinity },
    { candidate: 'invented' },
    { queuePeaks: { ...value.queuePeaks, clientFrames: 129 } },
  ])
    assert.throws(() =>
      assertComparable([{ ...trials[0]!, ...update } as typeof value, ...trials.slice(1)])
    )
})
test('idle counters preserve unavailable and provider-specific sampled values rather than inventing zeros', () => {
  assert.equal(idleKernelObservation(undefined).status, 'unavailable')
  assert.equal(
    idleKernelObservation({
      status: 'unavailable',
      metrics: [],
      limitations: ['Windows collector not implemented'],
    }).status,
    'unavailable'
  )
  const observed = idleKernelObservation({
    status: 'observed',
    metrics: [
      {
        phase: 'transport-idle',
        provider: 'darwin-rusage-v0',
        metric: 'interruptWakeups',
        observedDelta: 8,
        sampledDurationMs: 1000,
        matchedScopeIntervals: 5,
      },
    ],
    limitations: [],
  })
  assert.equal(observed.status, 'observed')
  assert.equal(observed.metrics[0]!.observedPerSecond, 8)
  assert.throws(() =>
    idleKernelObservation({
      status: 'observed',
      metrics: [
        {
          phase: 'transport-idle',
          provider: 'fixture',
          metric: 'x',
          observedDelta: -1,
          sampledDurationMs: 1000,
          matchedScopeIntervals: 1,
        },
      ],
    })
  )
})

test('idle metrics reject contradictory availability, empty matches and duplicated provider counters', () => {
  const metric = {
    phase: 'transport-idle',
    provider: 'darwin-proc-rusage-v0',
    metric: 'interruptWakeups',
    observedDelta: 0,
    sampledDurationMs: 1000,
    matchedScopeIntervals: 5,
  }
  // An actual zero delta with matched observations is valid; no samples is not zero.
  assert.equal(idleKernelObservation({ status: 'observed', metrics: [metric] }).status, 'observed')
  for (const value of [
    { status: 'unavailable', metrics: [metric] },
    { status: 'observed', metrics: [{ ...metric, matchedScopeIntervals: 0 }] },
    { status: 'observed', metrics: [{ ...metric, provider: '' }] },
    { status: 'observed', metrics: [{ ...metric, metric: '' }] },
    { status: 'observed', metrics: [metric, { ...metric }] },
    {
      status: 'observed',
      metrics: [{ ...metric, observedDelta: 1, sampledDurationMs: Number.MIN_VALUE }],
    },
  ])
    assert.throws(() => idleKernelObservation(value))
  assert.equal(
    idleKernelObservation({
      status: 'observed',
      metrics: [{ ...metric, phase: 'startup' }],
    }).status,
    'unavailable'
  )
})
