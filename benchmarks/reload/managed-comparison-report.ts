/** Replays complete fixed-plan evidence; a precomputed passed/median field is never sufficient. */
import assert from 'node:assert/strict'
import {
  acceptComparisonRows,
  COMPARISON_PLAN,
  MANAGED_COMPARISON_PROFILE,
  type ComparisonFramework,
  type ComparisonRow,
} from './managed-comparison.ts'
import { cefIdentityFromObservation, parseCefIdentity } from '../lib/cef-identity.ts'
import { assertCleanCommand, validateCommandObservation } from '../lib/observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function acceptManagedComparisonReport(
  input: unknown,
  options: { allowRedactedRuntime?: boolean } = {}
) {
  const report = record(input)
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], MANAGED_COMPARISON_PROFILE)
  assert.equal(report['passed'], true)
  assert.equal(report['performanceEligible'], false)
  assert.equal(report['runClass'], 'local-smoke')
  assert.equal(report['target'], 'darwin-arm64')
  if (options.allowRedactedRuntime === true)
    assert.ok(['1.4.4', 'VERSION_REDACTED'].includes(String(report['bun'])))
  else assert.equal(report['bun'], '1.4.4')
  assert.deepEqual(report['plan'], COMPARISON_PLAN)
  const before = record(report['sourceBefore'])
  assert.equal(before['clean'], true)
  assert.match(String(before['commit']), /^[a-f0-9]{40}$/)
  assert.deepEqual(report['sourceAfter'], before)
  assert.ok(Array.isArray(report['sourceHashes']) && report['sourceHashes'].length > 0)
  assert.deepEqual(report['sourceHashesAfter'], report['sourceHashes'])
  assert.equal(
    new Set((report['sourceHashes'] as { path: string }[]).map((row) => row.path)).size,
    report['sourceHashes'].length
  )
  for (const row of report['sourceHashes']) {
    const value = record(row)
    assert.ok(
      typeof value['path'] === 'string' &&
        value['path'].length > 0 &&
        !value['path'].startsWith('/') &&
        !value['path'].split('/').includes('..')
    )
    assert.match(String(value['sha256']), /^[a-f0-9]{64}$/)
  }
  const native = record(report['nativeSource'])
  assert.match(String(native['declaredCommit']), /^[a-f0-9]{40}$/)
  assert.match(String(native['tree']), /^[a-f0-9]{40}$/)
  const values = report['frameworks']
  assert.ok(Array.isArray(values))
  assert.equal(values.length, 3)
  const summaries: Record<string, unknown> = {}
  let commonAssets: unknown
  for (const [index, name] of (['bunly', 'electrobun', 'mirin'] as const).entries()) {
    const framework = record(values[index])
    assert.equal(framework['framework'], name)
    assert.equal(framework['passed'], true)
    assert.equal(framework['failure'], null)
    assert.equal(framework['retainedFixture'], false)
    assert.equal(framework['processSandbox'], 'unverified')
    const engine = record(framework['engine'])
    parseCefIdentity(engine, String(engine['sha256']))
    const assets = record(framework['rendererAssets'])
    assert.deepEqual(Object.keys(assets).sort(), [
      'html',
      'javascript',
      'terminalCss',
      'terminalJs',
    ])
    for (const asset of Object.values(assets).map(record)) {
      assert.match(String(asset['sha256']), /^[a-f0-9]{64}$/)
      assert.ok(
        Number.isSafeInteger(asset['bytes']) &&
          Number(asset['bytes']) > 0 &&
          Number(asset['bytes']) <= 2 * 1024 * 1024
      )
    }
    if (commonAssets)
      assert.deepEqual(assets, commonAssets, 'Frameworks did not receive identical renderer assets')
    commonAssets = assets
    for (const [asset, source] of [
      ['html', 'index.html'],
      ['javascript', 'client.js'],
    ] as const) {
      const entry: { path: string; sha256: string } | undefined = (
        report['sourceHashes'] as { path: string; sha256: string }[]
      ).find((row) => row.path === `benchmarks/fixtures/managed-comparison/${source}`)
      assert.ok(entry, 'Common renderer source missing from retained source inventory')
      assert.equal(
        record(assets[asset])['sha256'],
        entry.sha256,
        'Served renderer differs from fingerprinted source'
      )
    }
    assert.ok(Array.isArray(framework['rows']))
    const acceptance = acceptComparisonRows(
      name as ComparisonFramework,
      framework['rows'] as ComparisonRow[],
      options
    )
    if (framework['acceptance'] !== null) assert.deepEqual(framework['acceptance'], acceptance)
    const commands = framework['commands']
    assert.ok(Array.isArray(commands) && commands.length > 0 && commands.length <= 64)
    const apps = commands.map(record).filter((row) => row['phase'] === 'app')
    const engines = commands.map(record).filter((row) => row['phase'] === 'cef-identity')
    assert.equal(engines.length, 1)
    assert.deepEqual(
      cefIdentityFromObservation(
        validateCommandObservation(engines[0]!['observation']),
        String(engine['sha256'])
      ),
      engine
    )
    assert.equal(apps.length, name === 'bunly' ? 1 : COMPARISON_PLAN.edits + 1)
    if (name !== 'bunly')
      assert.equal(
        commands.map(record).filter((row) => row['phase'] === 'build').length,
        COMPARISON_PLAN.edits + 1
      )
    for (const [ordinal, row] of commands.map(record).entries()) {
      assert.match(String(row['report']), /^\d{3}-[a-z-]+\.json$/)
      assert.equal(
        row['report'],
        `${String(ordinal).padStart(3, '0')}-${String(row['phase'])}.json`,
        'Command observations must have unique ordered report identities'
      )
      const observation = validateCommandObservation(row['observation'])
      assertCleanCommand(observation)
      if (name === 'bunly' && row['phase'] === 'app') {
        requireNativeShutdown(observeNativeShutdown(observation))
        assert.equal(observation.postExitCleanup?.qualified, true)
        assert.equal(observation.postExitCleanup?.status, 'completed')
      }
    }
    const artifacts = record(framework['artifacts'])
    const packaged = name === 'bunly' ? record(artifacts['prepared']) : artifacts
    assert.ok(Array.isArray(packaged['entries']) && packaged['entries'].length > 0)
    const library = packaged['entries']
      .map(record)
      .filter((entry) => entry['path'] === framework['engineLibrary'])
    assert.equal(library.length, 1, 'Actual inspected CEF binary is absent from packaged inventory')
    assert.equal(library[0]!['kind'], 'file')
    assert.equal(library[0]!['sha256'], engine['sha256'])
    if (name === 'bunly') {
      assert.equal(artifacts['nativeCopies'], 1)
      assert.equal(artifacts['nativeCompilations'], 0)
      assert.equal(artifacts['originalUnchanged'], true)
      assert.equal(artifacts['preparedUnchanged'], true)
    } else {
      const installation = record(framework['installation'])
      if (name === 'electrobun') {
        assert.equal(installation['version'], '2.0.3-beta.26')
        for (const field of ['manifestSha256', 'bootstrapSha256'])
          assert.match(String(installation[field]), /^[a-f0-9]{64}$/)
      } else {
        assert.equal(installation['sourceVerified'], false)
        assert.match(String(installation['lockSha256']), /^[a-f0-9]{64}$/)
        assert.ok(Array.isArray(installation['packages']) && installation['packages'].length === 2)
        for (const entry of installation['packages'].map(record)) {
          assert.equal(entry['version'], '0.1.0-alpha.26')
          assert.match(String(entry['entrySha256']), /^[a-f0-9]{64}$/)
          assert.match(String(entry['manifestSha256']), /^[a-f0-9]{64}$/)
        }
      }
    }
    summaries[name] = {
      ...acceptance,
      cefVersion: engine['cefVersion'],
      chromiumVersion: engine['chromiumVersion'],
      runtimeVersion: (framework['rows'] as ComparisonRow[])[0]!.observation!.host.runtimeVersion,
      processSandbox: 'unverified',
    }
  }
  return {
    passed: true,
    profile: MANAGED_COMPARISON_PROFILE,
    frameworks: summaries,
    performanceEligible: false,
    conclusion:
      'Matched selected user outcome; native persistence versus browser-state restoration remains explicit. Engine/security cohorts and local-smoke design do not permit proportional performance claims.',
  }
}
