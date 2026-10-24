import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptNativeCredentials,
  credentialModes,
} from '../benchmarks/lib/cef-credential-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'

function fixture(mode: (typeof credentialModes)[number]): CommandObservation {
  const admitted = mode !== 'unavailable' && mode !== 'intent-denied'
  const events = [
    {
      event: 'bunly.native.credentials',
      schema: 1,
      mode,
      passed: true,
      admitted,
      browserChecks: admitted ? 3 : 0,
      applicationSessions: 0,
    },
    ...['process-stop', 'host-release', 'asset-service-stop', 'cef-shutdown'].flatMap(
      (phase, index) => [
        { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
        ...(index === 0 ? [{ event: 'bunly.backend.exit', code: 0, forced: false }] : []),
        { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: 1 },
      ]
    ),
    { event: 'bunly.host.shutdown', clean: true },
  ]
  return {
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
    stderr: events.map((event) => JSON.stringify(event)),
    samples: [],
    environment: {},
  }
}
test('credential acceptance requires exact native workload, denial and ordered clean teardown', () => {
  for (const mode of credentialModes) {
    const valid = fixture(mode)
    acceptNativeCredentials(valid, mode)
    for (const change of [
      { exitCode: 1 },
      { timedOut: true },
      { outputOverflow: true },
      { observedOrphans: [123] },
      { cleanupSurvivors: [123] },
      { stderr: valid.stderr.slice(1) },
      { stderr: valid.stderr.slice(0, -1) },
      { stderr: [...valid.stderr, valid.stderr[0]!] },
    ])
      assert.throws(() => acceptNativeCredentials({ ...valid, ...change }, mode))
    const event = JSON.parse(valid.stderr[0]!)
    for (const change of [
      { passed: false },
      { admitted: !event.admitted },
      { browserChecks: 4 },
      { applicationSessions: 1 },
      { extra: true },
      { schema: 2 },
    ])
      assert.throws(() =>
        acceptNativeCredentials(
          { ...valid, stderr: [JSON.stringify({ ...event, ...change }), ...valid.stderr.slice(1)] },
          mode
        )
      )
  }
})
test('personal-workstation credential qualification refuses before fixture or provider setup', async () => {
  const child = Bun.spawn([process.execPath, 'scripts/qualify-cef-credentials.ts', '/not-used'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'local' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  assert.notEqual(code, 0)
  assert.match(stderr, /restricted to disposable GitHub-hosted runners/)
})
