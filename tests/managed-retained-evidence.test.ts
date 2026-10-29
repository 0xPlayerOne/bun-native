import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { MANAGED_PROFILE } from '../benchmarks/reload/managed-acceptance.ts'
import { MANAGED_COMPARISON_PROFILE } from '../benchmarks/reload/managed-comparison.ts'
import {
  parseManagedRetainedManifest,
  parseManagedRetainedRun,
  readManagedRetainedArchive,
  replayManagedRetainedReport,
  verifyManagedHistoricalSource,
} from '../scripts/verify-managed-acceptance.ts'

const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
const list = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[]
const sources = {
  startup: '4b211e762bba2cbca8ca33b4c9f4ae3f08c85012',
  metadata: 'a05f0ed4ffb51ce880c9e3545edade6a736b56d1',
  comparison: 'db22f4e3f338b176a2a430f0b486b417232f9fbe',
  shutdown: 'bbefea37828fef4746589a4d319d1d09b8ec8a03',
}
/** Small synthetic parser input, never native execution or a published capture. */
function archiveFixture() {
  const source = { commit: sources.startup, clean: true, reason: 'clean-checkout' }
  const encoded: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_PROFILE,
    passed: false,
    performanceEligible: false,
    sourceBefore: source,
    sourceAfter: { ...source },
    sourceHashes: [{ path: 'package.json', sha256: hash('source') }],
    sourceHashesAfter: [{ path: 'package.json', sha256: hash('source') }],
    trials: [
      {
        index: 0,
        passed: false,
        rowsMissing: true,
        resultMissing: true,
        failure: 'Workload did not finish its fixed evidence files',
        observation: {
          schema: 1,
          observationExport: { schema: 1, correlation: 'omitted' },
          exitCode: 78,
          timedOut: false,
          cancelled: false,
          outputOverflow: false,
          observedOrphans: [],
          cleanupSurvivors: [],
          elapsedMs: 1,
          peakTreeRssBytes: 1,
          peakTreeThreads: 1,
          stdoutTail: [],
          stderr: [],
          samples: [],
          environment: { os: 'Darwin' },
          nativeDiagnostics: [
            JSON.stringify({ event: 'bunly.host.error', error: 'invalid public asset' }),
          ],
        },
      },
    ],
    nativeEvidenceExport: {
      schema: 1,
      correlation: 'not-retained',
      redactions: ['fixture-nonces'],
    },
  }
  const expanded = Buffer.from(JSON.stringify(encoded)),
    compressed = gzipSync(expanded)
  const entry = {
    id: 'startup-public-map-failure',
    profile: MANAGED_PROFILE,
    archive: 'startup-public-map-failure.json.gz',
    archiveBytes: compressed.length,
    archiveSha256: hash(compressed),
    expandedBytes: expanded.length,
    expandedSha256: hash(expanded),
    source: sources.startup,
    reportOriginal: {
      bytes: expanded.length + 100,
      sha256: hash('private original parser fixture'),
    },
    passed: false,
    redactions: ['fixture-nonces', 'runtime-version'],
    failureClass: 'public-asset-rejection-before-ui',
  }
  return { entry, encoded, compressed, expanded, report: decodeExportedNativeReport(encoded) }
}
function manifestFixture(): Record<string, unknown> {
  const first = archiveFixture().entry
  const entry = (id: string, changes: Record<string, unknown>) => ({
    ...first,
    id,
    archive: `${id}.json.gz`,
    archiveSha256: hash(id + ' compressed'),
    expandedSha256: hash(id + ' expanded'),
    reportOriginal: { bytes: 1000, sha256: hash(id + ' original') },
    ...changes,
  })
  return {
    schema: 1,
    classification: 'retained-managed-development-and-comparison',
    performanceEligible: false,
    releaseApproved: false,
    runs: [
      first,
      entry('clone-metadata-failure', {
        source: sources.metadata,
        failureClass: 'prepared-host-status-time-mismatch',
      }),
      entry('native-managed-acceptance', {
        source: 'f'.repeat(40),
        passed: true,
        failureClass: undefined,
      }),
      entry('common-workload-comparison', {
        source: sources.comparison,
        profile: MANAGED_COMPARISON_PROFILE,
        passed: true,
        failureClass: undefined,
        redactions: ['fixture-nonces', 'local-paths', 'runtime-version'],
      }),
      entry('last-window-quit-failure', {
        source: sources.shutdown,
        failureClass: 'normal-shutdown-raced-redundant-quit',
        redactions: ['fixture-nonces', 'local-paths', 'runtime-version'],
      }),
    ],
  }
}
test('manifest requires all three failures and both named successful captures without promotion', () => {
  expect(parseManagedRetainedManifest(manifestFixture())).toHaveLength(5)
  const changes: ((value: Record<string, unknown>) => void)[] = [
    (value) => {
      value['performanceEligible'] = true
    },
    (value) => {
      value['releaseApproved'] = true
    },
    (value) => {
      list(value['runs']).splice(0, 1)
    },
    (value) => {
      list(value['runs'])[0]!['passed'] = true
    },
    (value) => {
      list(value['runs'])[1]!['failureClass'] = 'later-fixed-so-now-passes'
    },
    (value) => {
      list(value['runs'])[0]!['source'] = 'a'.repeat(40)
    },
    (value) => {
      list(value['runs'])[3]!['redactions'] = ['fixture-nonces']
    },
    (value) => {
      list(value['runs']).push({ ...list(value['runs'])[0] })
    },
    (value) => {
      list(value['runs'])[3]!['archiveSha256'] = list(value['runs'])[2]!['archiveSha256']
    },
    (value) => {
      list(value['runs'])[3]!['reportOriginal'] = list(value['runs'])[2]!['reportOriginal']
    },
    (value) => {
      list(value['runs']).pop()
    },
    (value) => {
      list(value['runs'])[4]!['redactions'] = ['fixture-nonces']
    },
  ]
  for (const change of changes) {
    const value = manifestFixture()
    change(value)
    expect(() => parseManagedRetainedManifest(value)).toThrow()
  }
})
test('additional named failed attempts remain explicit and cannot replace success captures', () => {
  const value = manifestFixture(),
    original = archiveFixture().entry
  const extra = {
    ...original,
    id: 'additional-native-failure',
    archive: 'additional-native-failure.json.gz',
    archiveSha256: hash('another compressed'),
    expandedSha256: hash('another expanded'),
    reportOriginal: { sha256: hash('another original'), bytes: 1000 },
    failureClass: 'native-workload-failure',
  }
  list(value['runs']).push(extra)
  expect(parseManagedRetainedManifest(value)).toHaveLength(6)
  const changed = { ...extra, passed: true, failureClass: undefined }
  expect(() => parseManagedRetainedRun(changed)).toThrow('cannot replace')
  expect(() => parseManagedRetainedRun({ ...extra, failureClass: undefined })).toThrow(
    'explicit retained failure class'
  )
})
test('archive parser checks compressed/expanded sizes, hashes and explicit export schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-managed-retained-'))
  try {
    const fixture = archiveFixture()
    await writeFile(join(directory, fixture.entry.archive), fixture.compressed)
    expect(await readManagedRetainedArchive(directory, fixture.entry)).toEqual(fixture.report)
    for (const change of [
      { archiveBytes: fixture.entry.archiveBytes + 1 },
      { archiveSha256: 'a'.repeat(64) },
      { expandedBytes: fixture.entry.expandedBytes - 1 },
      { expandedBytes: fixture.entry.expandedBytes + 1 },
      { expandedSha256: 'a'.repeat(64) },
      { archive: '../escape.json.gz' },
      { archiveBytes: 64 * 1024 * 1024 + 1 },
      { expandedBytes: 128 * 1024 * 1024 + 1 },
    ])
      await expect(
        readManagedRetainedArchive(directory, { ...fixture.entry, ...change })
      ).rejects.toThrow()
    const corrupted = { ...fixture.encoded, nativeEvidenceExport: { schema: 999 } }
    const expanded = Buffer.from(JSON.stringify(corrupted)),
      compressed = gzipSync(expanded)
    await writeFile(join(directory, fixture.entry.archive), compressed)
    await expect(
      readManagedRetainedArchive(directory, {
        ...fixture.entry,
        archiveBytes: compressed.length,
        archiveSha256: hash(compressed),
        expandedBytes: expanded.length,
        expandedSha256: hash(expanded),
      })
    ).rejects.toThrow('export schema')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test.skipIf(process.platform === 'win32')(
  'retained archive inputs must be regular files, not symlinks',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunly-managed-retained-link-'))
    try {
      const fixture = archiveFixture()
      await writeFile(join(directory, 'actual.gz'), fixture.compressed)
      await symlink('actual.gz', join(directory, fixture.entry.archive))
      await expect(readManagedRetainedArchive(directory, fixture.entry)).rejects.toThrow(
        'regular evidence file'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
test('historical startup failure remains exit78 before UI with no fabricated workload result', () => {
  const fixture = archiveFixture(),
    entry = parseManagedRetainedRun(fixture.entry)
  expect(replayManagedRetainedReport(entry, fixture.report)).toEqual({
    id: entry.id,
    passed: false,
    failureClass: 'public-asset-rejection-before-ui',
    nativeExitCode: 78,
    workloadStarted: false,
  })
  const changes: ((value: Record<string, unknown>) => void)[] = [
    (value) => {
      value['passed'] = true
    },
    (value) => {
      list(value['trials'])[0]!['passed'] = true
    },
    (value) => {
      object(list(value['trials'])[0]!['observation'])['exitCode'] = 0
    },
    (value) => {
      object(list(value['trials'])[0]!['observation'])['timedOut'] = true
    },
    (value) => {
      object(list(value['trials'])[0]!['observation'])['nativeDiagnostics'] = []
    },
    (value) => {
      list(value['trials'])[0]!['rowsText'] = 'invented'
    },
  ]
  for (const change of changes) {
    const value = structuredClone(fixture.report)
    change(value)
    expect(() => replayManagedRetainedReport(entry, value)).toThrow()
  }
})
test('completed500 workload cannot hide the retained nonzero last-window shutdown outcome', () => {
  const fixture = archiveFixture(),
    report = fixture.report
  const entry = parseManagedRetainedRun({
    ...fixture.entry,
    id: 'last-window-quit-failure',
    archive: 'last-window-quit-failure.json.gz',
    source: sources.shutdown,
    failureClass: 'normal-shutdown-raced-redundant-quit',
    redactions: ['fixture-nonces', 'local-paths', 'runtime-version'],
  })
  const trial = list(report['trials'])[0]!,
    observation = object(trial['observation'])
  const rows = [
    ...Array.from({ length: 500 }, (_, index) => ({ kind: 'replacement', revision: index + 1 })),
    ...Array.from({ length: 508 }, (_, index) => ({
      kind: 'renderer',
      revision: Math.min(500, index),
    })),
  ].map((row, index) => ({ schema: 1, passed: true, index, ...row }))
  const rowsText = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const resultText = JSON.stringify({
    event: 'bunly.managed-development',
    schema: 1,
    passed: true,
    successfulReplacements: 500,
    rendererChecks: 508,
  })
  Object.assign(trial, {
    rowsText,
    rowsBytes: Buffer.byteLength(rowsText),
    rowsSha256: hash(rowsText),
    resultText,
    resultBytes: Buffer.byteLength(resultText),
    resultSha256: hash(resultText),
    observationSha256: 'a'.repeat(64),
    observationContentSha256: 'b'.repeat(64),
  })
  delete trial['rowsMissing']
  delete trial['resultMissing']
  observation['exitCode'] = 1
  const events = [
    {
      event: 'bunly.managed-development',
      schema: 1,
      passed: true,
      successfulReplacements: 500,
      rendererChecks: 508,
      failureCode: null,
    },
    ...['process-stop', 'host-release', 'asset-service-stop', 'cef-shutdown'].flatMap(
      (phase, index) => [
        { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
        ...(index === 0 ? [{ event: 'bunly.backend.exit', code: 1, forced: false }] : []),
        {
          event: 'bunly.host.shutdown-phase',
          phase,
          state: 'complete',
          durationMs: phase === 'cef-shutdown' ? 44 : 1,
        },
      ]
    ),
    { event: 'bunly.host.shutdown', clean: false },
  ]
  observation['nativeDiagnostics'] = events.map((event) => JSON.stringify(event))
  report['restart'] = { attempted: false, passed: false }
  expect(replayManagedRetainedReport(entry, report)).toMatchObject({
    passed: false,
    successfulReplacements: 500,
    rendererChecks: 508,
    nativeExitCode: 1,
    backendExitCode: 1,
    hostReportedClean: false,
    cefShutdownMs: 44,
    restartAttempted: false,
    observationContentDigestScope: 'original-before-local-path-redaction',
  })
  const changes: ((value: Record<string, unknown>) => void)[] = [
    (value) => {
      value['passed'] = true
    },
    (value) => {
      list(value['trials'])[0]!['passed'] = true
    },
    (value) => {
      object(list(value['trials'])[0]!['observation'])['exitCode'] = 0
    },
    (value) => {
      object(list(value['trials'])[0]!['observation'])['timedOut'] = true
    },
    (value) => {
      object(value['restart'])['attempted'] = true
    },
    (value) => {
      const target = object(list(value['trials'])[0]!['observation'])
      target['nativeDiagnostics'] = (target['nativeDiagnostics'] as string[]).map((line) =>
        line.replace('"clean":false', '"clean":true')
      )
    },
    (value) => {
      const target = object(list(value['trials'])[0]!['observation'])
      target['nativeDiagnostics'] = (target['nativeDiagnostics'] as string[]).filter(
        (line) => !line.includes('"event":"bunly.managed-development"')
      )
    },
    (value) => {
      const target = list(value['trials'])[0]!,
        result = JSON.parse(String(target['resultText']))
      result.successfulReplacements = 499
      target['resultText'] = JSON.stringify(result)
      target['resultBytes'] = Buffer.byteLength(String(target['resultText']))
      target['resultSha256'] = hash(String(target['resultText']))
    },
  ]
  for (const change of changes) {
    const value = structuredClone(report)
    change(value)
    expect(() => replayManagedRetainedReport(entry, value)).toThrow()
  }
})
test('historical source verification rejects identity drift, traversal and missing local objects without fetching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-managed-missing-git-'))
  try {
    const fixture = archiveFixture(),
      entry = parseManagedRetainedRun(fixture.entry)
    expect(() => verifyManagedHistoricalSource(directory, entry, fixture.report)).toThrow(
      'No fetch is performed'
    )
    for (const change of [
      { sourceAfter: { commit: 'a'.repeat(40), clean: true, reason: 'clean-checkout' } },
      {
        sourceHashes: [{ path: '../outside', sha256: 'a'.repeat(64) }],
        sourceHashesAfter: [{ path: '../outside', sha256: 'a'.repeat(64) }],
      },
      { sourceHashes: [], sourceHashesAfter: [] },
    ])
      expect(() =>
        verifyManagedHistoricalSource(directory, entry, { ...fixture.report, ...change })
      ).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('committed M6 archives retain every actual outcome and verify digests without historical Git objects', async () => {
  const directory = join(import.meta.dir, '../evidence/m6-managed-development')
  const entries = parseManagedRetainedManifest(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  )
  const reports = await Promise.all(
    entries.map((entry) => readManagedRetainedArchive(directory, entry))
  )
  let accepted = 0,
    failed = 0
  for (const [index, report] of reports.entries()) {
    const entry = entries[index]!,
      before = object(report['sourceBefore'])
    expect(before['commit']).toBe(entry.source)
    expect(before['clean']).toBe(true)
    expect(before['reason']).toBe('clean-checkout')
    expect(report['sourceAfter']).toEqual(before)
    expect(report['sourceHashesAfter']).toEqual(report['sourceHashes'])
    const hashes = list(report['sourceHashes'])
    expect(Array.isArray(hashes) && hashes.length > 10).toBe(true)
    expect(new Set(hashes.map((row) => row['path'])).size).toBe(hashes.length)
    expect(
      hashes.every(
        (row) =>
          typeof row['path'] === 'string' &&
          !row['path'].startsWith('/') &&
          !row['path'].split('/').includes('..') &&
          /^[a-f0-9]{64}$/.test(String(row['sha256']))
      )
    ).toBe(true)
    // Replays recorded process/workload evidence only. Historical blob lookup is
    // intentionally reserved for the explicit retained-evidence command.
    const outcome = replayManagedRetainedReport(entry, report)
    expect(outcome.passed).toBe(entry.passed)
    if (outcome.passed) accepted++
    else failed++
  }
  expect(accepted).toBe(2)
  expect(failed).toBe(entries.length - 2)
  expect(failed).toBeGreaterThanOrEqual(3)
})
