import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptNativeNetwork,
  nativeNetworkCases,
} from '../benchmarks/lib/cef-network-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

function fixture() {
  // Synthetic parser input only, never native execution evidence.
  const evidence = {
    event: 'bunly.native.network',
    schema: 1,
    passed: true,
    cases: nativeNetworkCases,
    certificatePolicy: 'ordinary-verifier-no-exception',
    fixture: 'loopback-public-https-and-untrusted-tls',
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
    stderr: [...phases, { event: 'bunly.host.shutdown', clean: true }].map((value) =>
      JSON.stringify(value)
    ),
    samples: [],
    environment: {},
  }
  const withEvidence = (value: unknown) => ({
    ...observation,
    stderr: [JSON.stringify(value), ...observation.stderr],
  })
  const traffic = {
    forbidden: 0,
    untrustedTls: 0,
    child: 2,
    worker: 2,
    isolatedLeak: 0,
    allowedData: 4,
  }
  return { evidence, observation, withEvidence, traffic }
}
test('network acceptance requires every exact native scenario and certificate policy', () => {
  const f = fixture()
  acceptNativeNetwork(f.withEvidence(f.evidence), f.traffic)
  assert.throws(() => acceptNativeNetwork(f.observation, f.traffic))
  for (const change of [
    { schema: 0 },
    { passed: false },
    { cases: nativeNetworkCases.slice(1) },
    { cases: [...nativeNetworkCases, nativeNetworkCases[0]] },
    { certificatePolicy: 'ignored' },
    { fixture: 'mock' },
    { unexpected: true },
  ])
    assert.throws(() =>
      acceptNativeNetwork(f.withEvidence({ ...f.evidence, ...change }), f.traffic)
    )
  assert.throws(() =>
    acceptNativeNetwork(
      { ...f.withEvidence(f.evidence), stdoutTail: [JSON.stringify(f.evidence)] },
      f.traffic
    )
  )
})
test('network acceptance cannot hide forbidden traffic, missing work or failed teardown', () => {
  const f = fixture()
  for (const key of ['forbidden', 'untrustedTls', 'isolatedLeak'] as const)
    for (const value of [1, -1, NaN, Infinity])
      assert.throws(() =>
        acceptNativeNetwork(f.withEvidence(f.evidence), { ...f.traffic, [key]: value })
      )
  for (const key of ['child', 'worker', 'allowedData'] as const)
    for (const value of [0, -1, NaN, Infinity, 0.5, 1000])
      assert.throws(() =>
        acceptNativeNetwork(f.withEvidence(f.evidence), { ...f.traffic, [key]: value })
      )
  for (const change of [
    { exitCode: 2 },
    { timedOut: true },
    { cancelled: true },
    { outputOverflow: true },
    { observedOrphans: [1] },
    { cleanupSurvivors: [1] },
    { stderr: [JSON.stringify(f.evidence)] },
    { stderr: f.withEvidence(f.evidence).stderr.slice(0, -2) },
  ])
    assert.throws(() =>
      acceptNativeNetwork({ ...f.withEvidence(f.evidence), ...change }, f.traffic)
    )
})
