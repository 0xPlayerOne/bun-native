import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptNativePolicy,
  nativePolicyCallbacks,
} from '../benchmarks/lib/cef-policy-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

function fixture() {
  const evidence = {
    event: 'bunly.native.development',
    schema: 2,
    passed: true,
    scopeRevoked: true,
    activation: 'native-fixed-fixture',
    policyCallbacks: [...nativePolicyCallbacks],
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
    samples: [],
    environment: {},
    stderr: [...phases, { event: 'bunly.host.shutdown', clean: true }].map((value) =>
      JSON.stringify(value)
    ),
  }
  return {
    evidence,
    observation,
    withEvidence: (value: unknown) => ({
      ...observation,
      stderr: [JSON.stringify(value), ...observation.stderr],
    }),
  }
}

test('policy acceptance requires every actual callback and exact lifecycle evidence', () => {
  const { evidence, observation, withEvidence } = fixture()
  acceptNativePolicy(withEvidence(evidence), 0)
  assert.throws(() => acceptNativePolicy(observation, 0))
  for (const value of [
    { ...evidence, schema: 1 },
    { ...evidence, passed: false },
    { ...evidence, scopeRevoked: false },
    { ...evidence, activation: 'script-only' },
    { ...evidence, policyCallbacks: nativePolicyCallbacks.slice(1) },
    { ...evidence, policyCallbacks: [...nativePolicyCallbacks, nativePolicyCallbacks[0]] },
    { ...evidence, unexpected: 'native-output' },
  ])
    assert.throws(() => acceptNativePolicy(withEvidence(value), 0))
  assert.throws(() =>
    acceptNativePolicy({ ...withEvidence(evidence), stdoutTail: [JSON.stringify(evidence)] }, 0)
  )
})

test('policy success cannot erase forbidden traffic, an exit failure or incomplete teardown', () => {
  const { evidence, withEvidence } = fixture()
  for (const traffic of [1, -1, NaN, Infinity])
    assert.throws(() => acceptNativePolicy(withEvidence(evidence), traffic))
  for (const change of [
    { exitCode: 2 },
    { timedOut: true },
    { cancelled: true },
    { outputOverflow: true },
    { observedOrphans: [1] },
    { cleanupSurvivors: [1] },
    { stderr: [JSON.stringify(evidence)] },
    { stderr: withEvidence(evidence).stderr.slice(0, -2) },
  ])
    assert.throws(() => acceptNativePolicy({ ...withEvidence(evidence), ...change }, 0))
})
