/** Read-only replay of retained M6 archives. Never launches a desktop or fetches source. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { nativeEvents } from '../benchmarks/lib/cef-acceptance.ts'
import { observeNativeShutdown } from '../benchmarks/foundation/native-shutdown.ts'
import {
  assertCleanCommand,
  validateCommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import {
  MANAGED_PROFILE,
  acceptManagedDevelopmentReport,
  acceptManagedDevelopmentWorkload,
  managedSourceSelectors,
} from '../benchmarks/reload/managed-acceptance.ts'
import { MANAGED_COMPARISON_PROFILE } from '../benchmarks/reload/managed-comparison.ts'
import { acceptManagedComparisonReport } from '../benchmarks/reload/managed-comparison-report.ts'

const root = resolve(import.meta.dir, '..')
const MAX_ARCHIVE = 64 * 1024 * 1024,
  MAX_EXPANDED = 128 * 1024 * 1024
const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
const object = (
  value: unknown,
  message = 'Expected retained evidence object'
): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), message)
  return value as Record<string, unknown>
}
const checksum = (value: unknown, length = 64): string => {
  assert.ok(
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    'Invalid retained evidence digest'
  )
  return value
}
function size(value: unknown, maximum: number): number {
  assert.ok(
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum,
    'Invalid retained evidence byte bound'
  )
  return Number(value)
}
function relativePath(value: unknown): string {
  assert.ok(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 512 &&
      !value.startsWith('/') &&
      !/[\\\0\r\n:]/.test(value) &&
      !value.split('/').some((part) => !part || part === '.' || part === '..'),
    'Invalid retained source path'
  )
  return value
}
const required = {
  'startup-public-map-failure': {
    profile: MANAGED_PROFILE,
    passed: false,
    source: '4b211e762bba2cbca8ca33b4c9f4ae3f08c85012',
    failureClass: 'public-asset-rejection-before-ui',
  },
  'clone-metadata-failure': {
    profile: MANAGED_PROFILE,
    passed: false,
    source: 'a05f0ed4ffb51ce880c9e3545edade6a736b56d1',
    failureClass: 'prepared-host-status-time-mismatch',
  },
  'last-window-quit-failure': {
    profile: MANAGED_PROFILE,
    passed: false,
    source: 'bbefea37828fef4746589a4d319d1d09b8ec8a03',
    failureClass: 'normal-shutdown-raced-redundant-quit',
  },
  'native-managed-acceptance': { profile: MANAGED_PROFILE, passed: true },
  'common-workload-comparison': {
    profile: MANAGED_COMPARISON_PROFILE,
    passed: true,
    source: 'db22f4e3f338b176a2a430f0b486b417232f9fbe',
  },
} as const
export interface ManagedRetainedRun {
  readonly id: string
  readonly profile: string
  readonly archive: string
  readonly archiveSha256: string
  readonly archiveBytes: number
  readonly expandedSha256: string
  readonly expandedBytes: number
  readonly source: string
  readonly reportOriginal: { readonly sha256: string; readonly bytes: number }
  readonly passed: boolean
  readonly redactions: readonly string[]
  readonly failureClass?: string
}
export function parseManagedRetainedRun(input: unknown): ManagedRetainedRun {
  const value = object(input)
  assert.ok(
    typeof value['id'] === 'string' && /^[a-z][a-z0-9-]{1,95}$/.test(value['id']),
    'Invalid retained run identity'
  )
  assert.ok(
    [MANAGED_PROFILE, MANAGED_COMPARISON_PROFILE].includes(String(value['profile'])),
    'Unknown retained M6 profile'
  )
  assert.equal(
    value['archive'],
    value['id'] + '.json.gz',
    'Archive must be a single run-local filename'
  )
  checksum(value['archiveSha256'])
  checksum(value['expandedSha256'])
  checksum(value['source'], 40)
  size(value['archiveBytes'], MAX_ARCHIVE)
  size(value['expandedBytes'], MAX_EXPANDED)
  const original = object(value['reportOriginal'])
  assert.deepEqual(Object.keys(original).sort(), ['bytes', 'sha256'])
  checksum(original['sha256'])
  size(original['bytes'], MAX_EXPANDED)
  assert.notEqual(
    original['sha256'],
    value['expandedSha256'],
    'Raw original and redacted archive identities must remain distinct'
  )
  assert.equal(typeof value['passed'], 'boolean')
  assert.deepEqual(
    value['redactions'],
    value['profile'] === MANAGED_COMPARISON_PROFILE || value['id'] === 'last-window-quit-failure'
      ? ['fixture-nonces', 'local-paths', 'runtime-version']
      : ['fixture-nonces', 'runtime-version']
  )
  const fixed = (required as Record<string, Readonly<Record<string, unknown>>>)[value['id']]
  if (fixed)
    for (const [field, expected] of Object.entries(fixed))
      assert.equal(value[field], expected, `Changed required outcome: ${value['id']}`)
  else
    assert.equal(
      value['passed'],
      false,
      'Extra attempts cannot replace the required successful captures'
    )
  if (value['passed']) assert.equal(value['failureClass'], undefined)
  else
    assert.ok(
      typeof value['failureClass'] === 'string' &&
        /^[a-z][a-z0-9-]{1,95}$/.test(value['failureClass']),
      'Failed attempts require an explicit retained failure class'
    )
  return value as unknown as ManagedRetainedRun
}
export function parseManagedRetainedManifest(input: unknown): readonly ManagedRetainedRun[] {
  const manifest = object(input)
  assert.equal(manifest['schema'], 1)
  assert.equal(manifest['classification'], 'retained-managed-development-and-comparison')
  assert.equal(manifest['performanceEligible'], false)
  assert.equal(manifest['releaseApproved'], false)
  assert.ok(
    Array.isArray(manifest['runs']) &&
      manifest['runs'].length >= 5 &&
      manifest['runs'].length <= 32,
    'Require all three retained failures, native acceptance, and the common-workload comparison'
  )
  const runs = manifest['runs'].map(parseManagedRetainedRun)
  for (const field of ['id', 'archiveSha256'] as const)
    assert.equal(
      new Set(runs.map((entry) => entry[field])).size,
      runs.length,
      'A retained attempt was duplicated'
    )
  assert.equal(
    new Set(runs.map((entry) => entry.reportOriginal.sha256)).size,
    runs.length,
    'An original capture was reused under another identity'
  )
  for (const id of Object.keys(required))
    assert.ok(
      runs.some((entry) => entry.id === id),
      `Required retained run missing: ${id}`
    )
  assert.ok(
    runs.reduce((bytes, entry) => bytes + entry.expandedBytes, 0) <= 256 * 1024 * 1024,
    'Retained evidence exceeds aggregate replay bound'
  )
  return runs
}
async function regularFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true })
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
    'Expected a bounded regular evidence file'
  )
  const bytes = await readFile(path)
  const after = await lstat(path, { bigint: true })
  assert.ok(after.isFile() && !after.isSymbolicLink())
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.equal(BigInt(bytes.length), before.size, 'Evidence changed during read')
  return bytes
}
export async function readManagedRetainedArchive(
  directory: string,
  input: unknown
): Promise<Record<string, unknown>> {
  const entry = parseManagedRetainedRun(input)
  const compressed = await regularFile(join(directory, entry.archive), entry.archiveBytes)
  assert.equal(compressed.length, entry.archiveBytes)
  assert.equal(hash(compressed), entry.archiveSha256, 'Compressed archive digest differs')
  const expanded = gunzipSync(compressed, { maxOutputLength: entry.expandedBytes })
  assert.equal(expanded.length, entry.expandedBytes, 'Expanded archive length differs')
  assert.equal(hash(expanded), entry.expandedSha256, 'Expanded archive digest differs')
  const report = decodeExportedNativeReport(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded))
  )
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], entry.profile)
  assert.equal(report['passed'], entry.passed, 'Manifest changed a captured outcome')
  assert.equal(report['performanceEligible'], false)
  return report
}
const comparisonSelectors = [
  'package.json',
  'bun.lock',
  'packages/runtime/src',
  'packages/cli/src',
  'packages/contracts/src',
  'benchmarks/fixtures',
  'benchmarks/lib',
  'benchmarks/reload',
  'benchmarks/foundation',
  'benchmarks/adapters',
  'scripts',
  'native/cef-host',
] as const
function git(repository: string, args: readonly string[]): Buffer {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  assert.equal(
    result.exitCode,
    0,
    'Required historical Git object unavailable; supply the recorded commit locally before replay. No fetch is performed.'
  )
  return result.stdout
}
export function verifyManagedHistoricalSource(
  repository: string,
  entry: ManagedRetainedRun,
  report: Record<string, unknown>
): number {
  const before = object(report['sourceBefore'])
  assert.equal(before['commit'], entry.source)
  assert.equal(before['clean'], true)
  assert.equal(before['reason'], 'clean-checkout')
  assert.deepEqual(report['sourceAfter'], before, 'Capture source changed during execution')
  const hashes = report['sourceHashes']
  assert.ok(
    Array.isArray(hashes) && hashes.length > 0 && hashes.length <= 4096,
    'Missing bounded source inventory'
  )
  assert.deepEqual(report['sourceHashesAfter'], hashes)
  const selected = hashes.map((value) => {
    const row = object(value)
    return { path: relativePath(row['path']), sha256: checksum(row['sha256']) }
  })
  assert.equal(
    new Set(selected.map((row) => row.path)).size,
    selected.length,
    'Duplicate historical source path'
  )
  const paths = git(repository, [
    'ls-tree',
    '-r',
    '--name-only',
    entry.source,
    '--',
    ...(entry.profile === MANAGED_PROFILE ? managedSourceSelectors : comparisonSelectors),
  ])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(
    selected.map((row) => row.path).sort(),
    paths.sort(),
    'Retained historical source inventory is incomplete'
  )
  for (const row of selected)
    assert.equal(
      hash(git(repository, ['show', `${entry.source}:${row.path}`])),
      row.sha256,
      `Historical source digest differs: ${row.path}`
    )
  const native = object(report['nativeSource'])
  const declared = checksum(native['declaredCommit'], 40),
    tree = checksum(native['tree'], 40)
  assert.equal(
    git(repository, ['rev-parse', `${declared}:native/cef-host`])
      .toString()
      .trim(),
    tree
  )
  assert.equal(
    git(repository, ['rev-parse', `${entry.source}:native/cef-host`])
      .toString()
      .trim(),
    tree
  )
  return selected.length
}
function singleNativeTrial(report: Record<string, unknown>): Record<string, unknown> {
  const trials = report['trials']
  assert.ok(
    Array.isArray(trials) && trials.length === 1,
    'Historical native capture must retain its one actual trial'
  )
  const trial = object(trials[0])
  assert.equal(trial['index'], 0)
  return trial
}
function rawWorkload(trial: Record<string, unknown>) {
  const rows = trial['rowsText'],
    result = trial['resultText']
  assert.ok(typeof rows === 'string' && typeof result === 'string')
  assert.ok(Buffer.byteLength(rows) > 0 && Buffer.byteLength(rows) <= 8 * 1024 * 1024)
  assert.ok(Buffer.byteLength(result) > 0 && Buffer.byteLength(result) <= 2 * 1024 * 1024)
  assert.equal(trial['rowsBytes'], Buffer.byteLength(rows))
  assert.equal(trial['resultBytes'], Buffer.byteLength(result))
  assert.equal(trial['rowsSha256'], hash(rows))
  assert.equal(trial['resultSha256'], hash(result))
  return { rows, result }
}
export function replayManagedRetainedReport(
  entry: ManagedRetainedRun,
  report: Record<string, unknown>
) {
  assert.equal(report['passed'], entry.passed)
  if (entry.id === 'native-managed-acceptance')
    return {
      id: entry.id,
      passed: true,
      acceptance: acceptManagedDevelopmentReport(report, { allowRedactedRuntime: true }),
    }
  if (entry.id === 'common-workload-comparison')
    return {
      id: entry.id,
      passed: true,
      acceptance: acceptManagedComparisonReport(report, { allowRedactedRuntime: true }),
    }
  assert.equal(report['passed'], false, 'Retained failures cannot be promoted by later fixes')
  if (entry.id === 'startup-public-map-failure') {
    const trial = singleNativeTrial(report),
      observation = validateCommandObservation(trial['observation'])
    assert.equal(trial['passed'], false)
    assertCleanCommand(observation, 78)
    const events = nativeEvents(observation)
    assert.equal(
      events.filter(
        (event) =>
          event['event'] === 'bunly.host.error' && event['error'] === 'invalid public asset'
      ).length,
      1
    )
    assert.equal(
      events.some(
        (event) =>
          event['event'] === 'bunly.managed-development' ||
          event['event'] === 'bunly.managed-restart'
      ),
      false
    )
    assert.equal(trial['rowsMissing'], true)
    assert.equal(trial['resultMissing'], true)
    assert.equal(trial['rowsText'], undefined)
    assert.equal(trial['resultText'], undefined)
    return {
      id: entry.id,
      passed: false,
      failureClass: entry.failureClass,
      nativeExitCode: 78,
      workloadStarted: false,
    }
  }
  if (entry.id === 'clone-metadata-failure') {
    const trial = singleNativeTrial(report)
    assert.equal(trial['passed'], true)
    const raw = rawWorkload(trial)
    // Recompute actual workload outcomes. The historical stored acceptance shape
    // predates additional current derived metrics and is not rewritten or trusted.
    const workload = acceptManagedDevelopmentWorkload(trial['observation'], raw.rows, raw.result)
    assert.ok(
      typeof report['failure'] === 'string' &&
        report['failure'].startsWith(
          'Prepared host file identity/timestamps changed across ordinary edits'
        )
    )
    assert.deepEqual(report['preparedArtifactAfter'], report['preparedArtifact'])
    const before = report['preparedFileMetadataBefore'],
      after = report['preparedFileMetadataAfter']
    assert.ok(
      Array.isArray(before) &&
        Array.isArray(after) &&
        before.length > 0 &&
        before.length === after.length
    )
    const changed: string[] = []
    for (let index = 0; index < before.length; index++) {
      const old = object(before[index]),
        current = object(after[index])
      assert.deepEqual(Object.keys(old).sort(), ['ctimeNs', 'mtimeNs', 'path', 'size'])
      assert.deepEqual(Object.keys(current).sort(), Object.keys(old).sort())
      for (const field of ['path', 'size', 'mtimeNs']) assert.equal(current[field], old[field])
      for (const value of [old['ctimeNs'], current['ctimeNs']])
        assert.match(String(value), /^[0-9]{1,24}$/)
      if (old['ctimeNs'] !== current['ctimeNs']) changed.push(relativePath(old['path']))
    }
    assert.deepEqual(changed, ['Contents/MacOS/bunly_host'])
    assert.equal(report['target'], 'darwin-arm64')
    return {
      id: entry.id,
      passed: false,
      failureClass: entry.failureClass,
      successfulReplacements: workload.successfulReplacements,
      rendererChecks: workload.rendererChecks,
      ordinaryNativeExit: true,
      retainedMetadataFailure: true,
    }
  }
  if (entry.id === 'last-window-quit-failure') {
    const trial = singleNativeTrial(report),
      observation = validateCommandObservation(trial['observation'])
    assert.equal(trial['passed'], false)
    assertCleanCommand(observation, 1)
    const raw = rawWorkload(trial),
      result = object(JSON.parse(raw.result))
    assert.equal(result['event'], 'bunly.managed-development')
    assert.equal(result['schema'], 1)
    assert.equal(result['passed'], true)
    assert.equal(result['successfulReplacements'], 500)
    assert.equal(result['rendererChecks'], 508)
    assert.equal(result['failureCode'], undefined)
    assert.ok(raw.rows.endsWith('\n'))
    const rows = raw.rows
      .trimEnd()
      .split('\n')
      .map((line) => object(JSON.parse(line)))
    assert.ok(rows.length >= 1000 && rows.length <= 1600)
    rows.forEach((row, index) => {
      assert.equal(row['schema'], 1)
      assert.equal(row['index'], index)
      assert.equal(row['passed'], true)
    })
    assert.deepEqual(
      rows.filter((row) => row['kind'] === 'replacement').map((row) => row['revision']),
      Array.from({ length: 500 }, (_, index) => index + 1)
    )
    assert.equal(rows.filter((row) => row['kind'] === 'renderer').length, 508)
    const events = nativeEvents(observation)
    const completion = events.filter((event) => event['event'] === 'bunly.managed-development')
    assert.deepEqual(completion, [
      {
        event: 'bunly.managed-development',
        schema: 1,
        passed: true,
        successfulReplacements: 500,
        rendererChecks: 508,
        failureCode: null,
      },
    ])
    const exits = events.filter((event) => event['event'] === 'bunly.backend.exit')
    assert.equal(exits.length, 1)
    assert.equal(exits[0]!['code'], 1)
    assert.equal(exits[0]!['forced'], false)
    const host = events.filter((event) => event['event'] === 'bunly.host.shutdown')
    assert.equal(host.length, 1)
    assert.equal(host[0]!['clean'], false)
    assert.ok(events.indexOf(completion[0]!) < events.indexOf(exits[0]!))
    assert.ok(events.indexOf(exits[0]!) < events.indexOf(host[0]!))
    const shutdown = observeNativeShutdown(observation)
    assert.equal(shutdown.malformed, false)
    assert.equal(shutdown.pendingPhase, null)
    assert.equal(shutdown.backendExitedNormally, false)
    assert.equal(shutdown.hostReportedClean, false)
    assert.ok(
      Object.values(shutdown.durationsMs).every((duration) => duration !== null && duration >= 0)
    )
    assert.equal(
      events.some((event) => event['event'] === 'bunly.managed-restart'),
      false
    )
    const restart = object(report['restart'])
    assert.equal(restart['attempted'], false)
    assert.equal(restart['passed'], false)
    assert.equal(restart['observation'], undefined)
    // This failed export additionally redacts absolute stack-trace prefixes.
    // Keep both original observation digests as provenance; the archive digest
    // binds the exported bytes. Do not claim their post-redaction recomputation.
    checksum(trial['observationSha256'])
    checksum(trial['observationContentSha256'])
    return {
      id: entry.id,
      passed: false,
      failureClass: entry.failureClass,
      successfulReplacements: 500,
      rendererChecks: 508,
      nativeExitCode: 1,
      backendExitCode: 1,
      hostReportedClean: false,
      cefShutdownMs: shutdown.durationsMs['cef-shutdown'],
      restartAttempted: false,
      observationContentDigestScope: 'original-before-local-path-redaction',
    }
  }
  // Additional failed attempts remain explicit and do not contribute an accepted
  // run. Keep all available process observations and require a recorded failure.
  const diagnostics: string[] = []
  const recordFailure = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 65536)
      diagnostics.push(value)
  }
  recordFailure(report['failure'])
  let observedCommands = 0
  if (entry.profile === MANAGED_PROFILE) {
    const trials = report['trials']
    assert.ok(Array.isArray(trials) && trials.length <= 1)
    for (const value of trials) {
      const trial = object(value)
      recordFailure(trial['failure'])
      if (trial['observation']) {
        validateCommandObservation(trial['observation'])
        observedCommands++
      }
    }
    if (report['restart']) {
      const restart = object(report['restart'])
      recordFailure(restart['failure'])
      if (restart['observation']) {
        validateCommandObservation(restart['observation'])
        observedCommands++
      }
    }
  } else {
    const frameworks = report['frameworks']
    assert.ok(Array.isArray(frameworks) && frameworks.length <= 3)
    for (const value of frameworks) {
      const framework = object(value)
      recordFailure(framework['failure'])
      assert.ok(Array.isArray(framework['commands']) && framework['commands'].length <= 64)
      for (const command of framework['commands']) {
        validateCommandObservation(object(command)['observation'])
        observedCommands++
      }
    }
  }
  assert.ok(diagnostics.length > 0, 'Additional failed attempt has no retained failure diagnostic')
  return {
    id: entry.id,
    passed: false,
    failureClass: entry.failureClass,
    observedCommands,
    failureDiagnosticsRetained: diagnostics.length,
  }
}
export async function verifyManagedRetainedEvidence(
  directory = join(root, 'evidence/m6-managed-development'),
  repository = root
) {
  const manifest = JSON.parse(
    (await regularFile(join(directory, 'manifest.json'), 1024 * 1024)).toString()
  )
  const entries = parseManagedRetainedManifest(manifest)
  const outcomes = []
  for (const entry of entries) {
    const report = await readManagedRetainedArchive(directory, entry)
    const verifiedSourceFiles = verifyManagedHistoricalSource(repository, entry, report)
    outcomes.push({
      ...replayManagedRetainedReport(entry, report),
      source: entry.source,
      verifiedSourceFiles,
      reportOriginal: entry.reportOriginal,
      expandedSha256: entry.expandedSha256,
    })
  }
  return {
    schema: 1,
    classification: 'retained-managed-development-and-comparison',
    verified: true,
    acceptedRuns: outcomes.filter((row) => row.passed).length,
    retainedFailedRuns: outcomes.filter((row) => !row.passed).length,
    nativeExecution: false,
    sourceFetch: false,
    performanceEligible: false,
    releaseApproved: false,
    outcomes,
  }
}
if (import.meta.main) {
  assert.equal(Bun.version, '1.4.4', 'Use pinned Bun 1.4.4')
  assert.ok(process.argv.length <= 3, 'Use verify-managed-acceptance.ts [EVIDENCE_DIRECTORY]')
  console.log(
    JSON.stringify(
      await verifyManagedRetainedEvidence(process.argv[2] ? resolve(process.argv[2]) : undefined)
    )
  )
}
