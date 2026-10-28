import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  validateCommandObservation,
  assertCleanCommand,
} from '../benchmarks/lib/observed-command.ts'
import {
  decodeExportedNativeReport,
  validateExportedCommandObservation,
} from '../benchmarks/lib/exported-native-evidence.ts'
import { acceptNativeCredentials } from '../benchmarks/lib/cef-credential-acceptance.ts'

function observation() {
  return {
    schema: 1,
    observationId: 'a'.repeat(48),
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    cleanupSurvivors: [],
    observedOrphans: [],
    elapsedMs: 1,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    stdoutTail: [],
    stderr: [],
    samples: [],
    environment: {},
    nativeDiagnostics: [
      {
        event: 'bunly.native.credentials',
        schema: 1,
        mode: 'seed',
        passed: true,
        admitted: true,
        browserChecks: 3,
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
    ].map((record) => JSON.stringify(record)),
  }
}
async function exported(input: unknown): Promise<Record<string, unknown>> {
  const child = Bun.spawn(
    [process.env['PYTHON'] ?? 'python3', 'scripts/export_native_evidence.py'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(error)
  return JSON.parse(text) as Record<string, unknown>
}
test('Python export replays exact native receipts without inventing live correlation', async () => {
  const original = observation()
  const report = await exported({
    passed: true,
    observation: original,
    sha256: 'b'.repeat(64),
    token: 'c'.repeat(48),
  })
  expect(JSON.stringify(report)).not.toContain('a'.repeat(48))
  expect(report['sha256']).toBe('b'.repeat(64))
  expect(report['token']).toBe('[fixture-nonce]')
  expect(() => validateCommandObservation(report['observation'])).toThrow(
    'exported-observation validator'
  )
  const decoded = decodeExportedNativeReport(report)
  const result = validateCommandObservation(decoded['observation'])
  expect(result.observationId).toBeUndefined()
  expect(result.nativeDiagnostics).toEqual(original.nativeDiagnostics)
  acceptNativeCredentials(result, 'seed')
  expect(await exported(report)).toEqual(report)
  expect(original.observationId).toBe('a'.repeat(48))
})
test('public export preserves download timeout evidence and its failed outcome', async () => {
  const receipt = JSON.stringify({
    event: 'bunly.host.download-timeout',
    schema: 1,
    before: true,
    callbackOwned: true,
    callbackCount: 5,
    callbackCountSaturated: false,
    quarantineObservedLaunches: 1,
    lastCallback: {
      phase: 'updated',
      valid: true,
      inProgress: true,
      paused: false,
      complete: false,
      cancelled: false,
      interrupted: false,
      interruptReason: 'none',
      bytesReceived: 32768,
      totalBytes: 32768,
      percentComplete: 100,
      pathState: 'owned-stage',
    },
  })
  const report = await exported({
    passed: false,
    observation: { ...observation(), exitCode: 1, nativeDiagnostics: [receipt] },
  })
  const result = validateCommandObservation(decodeExportedNativeReport(report)['observation'])
  expect(result.nativeDiagnostics).toEqual([receipt])
  expect(report['passed']).toBe(false)
  expect(() => assertCleanCommand(result)).toThrow()
})
test('exported failures remain failures and corrupt receipts do not become successful', async () => {
  for (const change of [
    { exitCode: 2 },
    { timedOut: true },
    { cancelled: true },
    { outputOverflow: true },
    { observedOrphans: [123] },
    { cleanupSurvivors: [123] },
  ]) {
    const report = await exported({ observation: { ...observation(), ...change } })
    const result = validateCommandObservation(decodeExportedNativeReport(report)['observation'])
    expect(() => assertCleanCommand(result)).toThrow()
  }
  const raw = observation()
  for (const lines of [
    raw.nativeDiagnostics.slice(1),
    raw.nativeDiagnostics.slice(0, -1),
    [...raw.nativeDiagnostics, raw.nativeDiagnostics[0]!],
  ]) {
    const report = await exported({ observation: { ...raw, nativeDiagnostics: lines } })
    expect(() =>
      acceptNativeCredentials(
        validateCommandObservation(decodeExportedNativeReport(report)['observation']),
        'seed'
      )
    ).toThrow()
  }
})
test('export markers are explicit and malformed source identities are never laundered', async () => {
  await expect(
    exported({ observation: { ...observation(), observationId: 'bad' } })
  ).rejects.toThrow('Invalid source observation identity')
  const report = await exported({ observation: observation() })
  const obs = report['observation'] as Record<string, unknown>
  for (const marker of [
    undefined,
    { schema: 2, correlation: 'omitted' },
    { schema: 1, correlation: 'invented' },
    { schema: 1, correlation: 'omitted', extra: true },
  ])
    expect(() =>
      validateExportedCommandObservation({ ...obs, observationExport: marker })
    ).toThrow()
  expect(() =>
    validateExportedCommandObservation({ ...obs, observationId: 'a'.repeat(48) })
  ).toThrow()
  expect(() => decodeExportedNativeReport({ observation: obs })).toThrow()
  expect(() =>
    decodeExportedNativeReport({ ...report, nativeEvidenceExport: { schema: 2 } })
  ).toThrow()
})
