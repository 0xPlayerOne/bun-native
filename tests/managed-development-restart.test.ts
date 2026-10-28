import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { managedRestartParserFixture } from './fixtures/managed-restart.ts'
import { acceptManagedRestartReport } from '../benchmarks/reload/managed-restart-acceptance.ts'
import { managedObservationContentSha256 } from '../benchmarks/reload/managed-observation.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { runManagedRestartCheck } from '../scripts/managed-restart-check.ts'

const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
test('controlled relaunch requires a fresh browser/native owner and actually applied changed config', () => {
  const fixture = managedRestartParserFixture()
  const result = acceptManagedRestartReport(fixture.report, fixture.context)
  expect(result.admittedRevision).toBe(500)
  expect(result.freshNativeHandles).toBe(true)
  expect(result.unsavedFormRestored).toBe(false)
  expect(result.ephemeralLoginRestored).toBe(false)
  // Native document IDs are intentionally process-local and may repeat.
  expect(object(fixture.result['identities'])['document']).toBe(
    fixture.context.previousIdentities['document']
  )
})
test('restart rejects old UUIDs, retained browser state, unapplied config, leaked resources and pending RPC', () => {
  const changes: ((value: ReturnType<typeof managedRestartParserFixture>) => void)[] = [
    (value) => {
      object(value.result['identities'])['window'] = value.context.previousIdentities['window']
    },
    (value) => {
      object(value.result['renderer'])['instance'] = value.context.previousRendererInstance
    },
    (value) => {
      object(value.result['renderer'])['formEmpty'] = false
    },
    (value) => {
      object(value.result['renderer'])['sessionAbsent'] = false
    },
    (value) => {
      object(value.result['backend'])['loginAbsent'] = false
    },
    (value) => {
      object(value.result['backend'])['configurationSha256'] = 'a'.repeat(64)
    },
    (value) => {
      object(value.result['backend'])['revision'] = 499
    },
    (value) => {
      object(value.result['requests'])['settled'] = 1
    },
    (value) => {
      object(object(value.result['final'])['owner'])['resources'] = 1
    },
    (value) => {
      object(object(value.result['final'])['broker'])['forcedTerminations'] = 1
    },
    (value) => {
      object(object(value.result['final'])['development'])['restartRequired'] = true
    },
  ]
  for (const change of changes) {
    const value = managedRestartParserFixture()
    change(value)
    expect(value.accept).toThrow()
  }
})
test('restart uses the existing ordinary exit, output-drain and helper qualification gates', () => {
  for (const change of [
    { exitCode: 78 },
    { timedOut: true },
    { cleanupSurvivors: [9] },
    { observedOrphans: [9] },
    { environment: { os: 'Darwin' } },
  ]) {
    const value = managedRestartParserFixture()
    Object.assign(value.observation, change)
    expect(value.accept).toThrow()
  }
  for (const mode of ['missing', 'duplicate', 'late', 'mismatch']) {
    const value = managedRestartParserFixture(),
      events = value.observation['nativeDiagnostics'] as string[]
    const marker = events.shift()!
    if (mode === 'duplicate') events.unshift(marker, marker)
    if (mode === 'late') events.push(marker)
    if (mode === 'mismatch')
      events.unshift(JSON.stringify({ ...JSON.parse(marker), configurationApplied: false }))
    expect(value.accept).toThrow()
  }
})
test('restart report rejects a retry, changed observations, result hashes and shortened fixed plan', () => {
  for (const change of [
    { launches: 2 },
    { attempted: false },
    { observerTimeoutMs: 60000 },
    { fixtureDeadlineMs: 30000 },
    { configurationUnchanged: false },
    { resultSha256: 'a'.repeat(64) },
  ]) {
    const value = managedRestartParserFixture()
    Object.assign(value.report, change)
    expect(() => acceptManagedRestartReport(value.report, value.context)).toThrow()
  }
  const value = managedRestartParserFixture()
  value.observation['elapsedMs'] = 999
  expect(() => acceptManagedRestartReport(value.report, value.context)).toThrow(
    'Embedded restart observation'
  )
})
test('canonical embedded observation digest survives explicit nonce redaction without ignoring outcomes', () => {
  const value = managedRestartParserFixture()
  value.observation['stderr'] = ['fixture token ' + 'e'.repeat(48)]
  const digest = managedObservationContentSha256(value.observation)
  const exported = structuredClone(value.observation)
  delete exported['observationId']
  exported['observationExport'] = { schema: 1, correlation: 'omitted' }
  exported['stderr'] = ['fixture token [fixture-nonce]']
  const decoded = decodeExportedNativeReport({
    nativeEvidenceExport: {
      schema: 1,
      correlation: 'not-retained',
      redactions: ['fixture-nonces'],
    },
    observation: exported,
  })
  expect(managedObservationContentSha256(decoded['observation'])).toBe(digest)
  object(decoded['observation'])['exitCode'] = 2
  expect(managedObservationContentSha256(decoded['observation'])).not.toBe(digest)
})
test('restart controller retains a preflight failure and refuses to reuse its evidence directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-restart-controller-'))
  try {
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'bunly-dev.json'), '{}\n')
    const options = {
      executable: process.execPath,
      cwd: root,
      project,
      serviceRunner: join(root, 'runner.js'),
      previousIdentities: { window: 'w', view: 'v', session: 's' },
      previousRendererInstance: 'old-browser',
    }
    const failed = await runManagedRestartCheck(options)
    expect(failed['passed']).toBe(false)
    expect(failed['attempted']).toBe(false)
    expect(failed['launches']).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'restart/report.json'), 'utf8'))).toEqual(failed)
    await expect(runManagedRestartCheck(options)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
