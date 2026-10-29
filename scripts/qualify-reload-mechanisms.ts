/** Explicit bounded experiments; no native host/credential store or hidden runtime switch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { reloadCandidates } from '../benchmarks/reload/fixtures.ts'
import {
  acceptReloadProbe,
  acceptReloadMatrix,
  reloadSourcePaths,
  reloadProbeSummary,
  reloadObservationResources,
} from '../benchmarks/reload/acceptance.ts'
const root = resolve(import.meta.dir, '..')
assert.equal(
  process.argv.length,
  2,
  'Qualifier owns a fixed 20-generation plan and exclusive output'
)
assert.equal(Bun.version, '1.4.4')
const before = sourceIdentity(root)
assert.equal(before.clean, true, 'Clean committed source is required')
const sources = reloadSourcePaths
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const hashes = async () =>
  Promise.all(
    sources.map(async (path) => ({ path, sha256: sha(await readFile(join(root, path))) }))
  )
const parent = join(root, '.bunly/m6/reload')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const rows: Record<string, unknown>[] = []
const report: Record<string, unknown> = {
  schema: 1,
  profile: 'reload-mechanisms-matrix-v1',
  passed: false,
  sourceBefore: before,
  sourceHashes: await hashes(),
  bun: Bun.version,
  target: `${process.platform}-${process.arch}`,
  samples: 20,
  cases: rows,
  selection: 'not-a-production-loader-selection',
  limitations: [
    'Synthetic listeners/module state and timers, not native windows, browser sessions, PTYs or a 500-reload desktop soak.',
    'Import and graph synchronous loops lose the isolated owner process; forced exit is retained as failure and requires controlled restart.',
    'Worker/process cleanup observes the fixed directly owned generation only, not arbitrary native addons, unmanaged descriptors or detached descendants.',
    'Per-trial process memory scopes differ. Local sequential samples and explicit boundary GC are descriptive, not comparative wins or leak-free proof.',
    'Graph callbacks and pending promises require framework retirement and explicit unmanaged cleanup; graph disposal is not a sandbox.',
  ],
}
try {
  for (const hang of [false, true])
    for (const mode of reloadCandidates) {
      const name = `${mode}-${hang ? 'synchronous-loop' : 'repeated'}`
      const directory = join(work, name)
      await mkdir(directory)
      const processPath = join(work, name + '.process.json')
      const observed = await observedCommand(
        [
          process.execPath,
          join(root, 'benchmarks/reload/driver.ts'),
          mode,
          directory,
          '20',
          hang ? 'hang' : 'normal',
        ],
        {
          cwd: root,
          output: processPath,
          timeoutMs: hang && (mode === 'graph' || mode === 'import') ? 2000 : 30000,
        }
      ).result
      const raw = await readFile(processPath)
      const rawObservation = JSON.parse(raw.toString()) as Record<string, unknown>
      const environment = observed.environment
      const row: Record<string, unknown> = {
        name,
        mode,
        hang,
        passed: false,
        observation: {
          bytes: raw.length,
          sha256: sha(raw),
          exitCode: observed.exitCode,
          timedOut: observed.timedOut,
          cancelled: observed.cancelled,
          outputOverflow: observed.outputOverflow,
          observerFailure: rawObservation['observerFailure'],
          orphanCount: observed.observedOrphans.length,
          survivorCount: observed.cleanupSurvivors.length,
          elapsedMs: observed.elapsedMs,
          peakTreeRssBytes: observed.peakTreeRssBytes,
          peakTreeThreads: observed.peakTreeThreads,
          environment: Object.fromEntries(
            ['os', 'release', 'arch', 'python', 'psutil', 'runClass'].map((key) => [
              key,
              environment[key],
            ])
          ),
          resourceSamples: reloadObservationResources(rawObservation),
        },
      }
      rows.push(row)
      if (hang && (mode === 'graph' || mode === 'import')) {
        assert.equal(rawObservation['observerFailure'], null)
        assert.equal(observed.timedOut, true)
        assert.equal(observed.cancelled, false)
        assert.equal(observed.outputOverflow, false)
        assert.notEqual(observed.exitCode, 0)
        assert.equal(observed.cleanupSurvivors.length, 0)
        assert.equal(observed.observedOrphans.length, 0)
        const entered = observed.stdoutTail.filter((line) => {
          try {
            return JSON.parse(line).event === 'loop-entered'
          } catch {
            return false
          }
        })
        assert.equal(entered.length, 1)
        assert.deepEqual(JSON.parse(entered[0]!), {
          event: 'loop-entered',
          mode,
          stableListenerCreated: true,
        })
        row['loopEntryReceipt'] = JSON.parse(entered[0]!)
        row['outcome'] = 'owner-process-unresponsive-forced-restart-required'
        row['expectedApplicationFailure'] = true
      } else {
        assertCleanCommand(observed)
        const rawResult = await readFile(join(directory, 'result.json'))
        assert.ok(rawResult.length <= 256 * 1024)
        const result = JSON.parse(rawResult.toString()) as Record<string, unknown>
        row['result'] = result
        row['resultSha256'] = sha(rawResult)
        row['acceptance'] = acceptReloadProbe(result, mode, 20, hang)
        if (!hang) row['summary'] = reloadProbeSummary(result)
      }
      row['passed'] = true
      await writeFile(join(work, 'checkpoint.json'), JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      })
      console.log(
        JSON.stringify({
          case: name,
          acceptedObservation: true,
          outcome: row['outcome'] ?? row['acceptance'],
        })
      )
    }
  report['passed'] = true
} catch (error) {
  report['failureType'] = error instanceof Error ? error.name : 'UnknownError'
} finally {
  report['sourceAfter'] = sourceIdentity(root)
  report['sourceHashesAfter'] = await hashes()
  if (
    JSON.stringify(report['sourceBefore']) !== JSON.stringify(report['sourceAfter']) ||
    JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])
  )
    report['passed'] = false
  if (report['passed'] === true) {
    try {
      acceptReloadMatrix(report)
    } catch {
      report['passed'] = false
      report['failureType'] = 'MatrixAcceptanceFailed'
    }
  }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(JSON.stringify({ passed: report['passed'], report: join(work, 'report.json') }))
}
if (report['passed'] !== true) process.exitCode = 1
