/** Replay every follow-up outcome; historical/failed runs are never promoted. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import {
  acceptTerminalLoad,
  acceptLoadRows,
  assessTerminalLoad,
} from '../benchmarks/lib/terminal-load-acceptance.ts'
import {
  assertCleanCommand,
  validateCommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import { acceptGraphicalTerminal } from '../benchmarks/lib/cef-terminal-acceptance.ts'
const root = resolve(import.meta.dir, '..')
const base = join(root, 'evidence/m5-terminal-load-followup')
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'))
const compressed = await readFile(join(base, 'raw-evidence.json.gz'))
assert.equal(sha(compressed), manifest.archive.sha256)
const bytes = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 })
assert.equal(sha(bytes), manifest.expanded.sha256)
const archive = JSON.parse(bytes.toString())
assert.equal(
  sha(await readFile(join(root, 'evidence/m5-terminal-load/raw-evidence.json.gz'))),
  archive.historicalArchiveSha256
)
let passed = 0,
  failed = 0,
  snapshots = 0
const profiles = []
for (const run of archive.runs) {
  const report = decodeExportedNativeReport(run.files['report.json'].data)
  const source = report['sourceBefore'] as { clean: boolean; commit: string }
  const hashes = report['sourceHashes'] as Record<string, string>
  if (source.clean) {
    for (const [path, hash] of Object.entries(hashes)) {
      const content = Bun.spawnSync(['git', 'show', `${source.commit}:${path}`], { cwd: root })
      assert.equal(content.exitCode, 0)
      assert.equal(sha(content.stdout), hash, `${run.id}: ${path}`)
      if (['required-functional-115', 'cef-load', 'electron-load'].includes(run.label))
        assert.equal(
          sha(await readFile(join(root, path))),
          hash,
          `Current implementation changed: ${path}`
        )
    }
    snapshots++
  }
  const backend = report['backendBuild'] as
    | Record<string, { sha256: string; source: string }>
    | undefined
  if (backend) {
    assert.equal(backend['main.js']!.source, 'scripts/cef-bootstrap.ts')
    const inventory = report['preparedArtifact'] as { entries: { path: string; sha256?: string }[] }
    for (const [name, entry] of Object.entries(backend))
      assert.equal(
        inventory.entries.find((file) => file.path.endsWith(`/backend/${name}`))?.sha256,
        entry.sha256
      )
  }
  let workloadFailures = 0,
    watchdogs = 0,
    accepted = 0,
    attempted = 0
  for (const trial of report['trials'] as Record<string, unknown>[]) {
    attempted++
    const file = run.files[`trial-${trial['index']}-${trial['mode']}.jsonl`]
    const verify = () => {
      if (!file) {
        const metrics = acceptGraphicalTerminal(trial['observation'])
        assert.deepEqual(metrics, trial['metrics'])
        return metrics
      }
      if (trial['rawSha256']) assert.equal(file.original.sha256, trial['rawSha256'])
      const raw = file.data.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n'
      if (run.label.startsWith('electron')) {
        const observation = validateCommandObservation(trial['observation'])
        assertCleanCommand(observation)
        const phases = acceptLoadRows(
          raw,
          String(trial['mode']),
          observation.environment.os,
          'electron'
        )
        assert.deepEqual(phases, trial['phases'])
        return phases
      }
      const outcomes = assessTerminalLoad(trial['observation'], raw, String(trial['mode']))
      if (!outcomes.workload.passed) workloadFailures++
      if (outcomes.watchdog) watchdogs++
      const metrics = acceptTerminalLoad(trial['observation'], raw, String(trial['mode']))
      assert.deepEqual(metrics, trial['metrics'])
      return metrics
    }
    if (trial['passed']) {
      verify()
      accepted++
      passed++
    } else {
      assert.throws(verify)
      failed++
    }
  }
  if (attempted) assert.equal(report['passed'], accepted === attempted)
  profiles.push({ label: run.label, attempted, accepted, workloadFailures, watchdogs })
}
for (const result of archive.combined.results) {
  const run = archive.runs.find((entry: { label: string }) => entry.label === result.id)
  assert.ok(run)
  assert.equal(result.sha256, run.files['report.json'].original.sha256)
  assert.equal(result.passed, run.files['report.json'].data.passed)
  assert.equal(run.files['report.json'].data.sourceBefore.commit, archive.combined.source.commit)
}
assert.equal(
  archive.combined.passed,
  archive.combined.results.every((result: { passed: boolean }) => result.passed)
)
assert.equal(archive.combined.milestoneAccepted, false)
assert.equal(archive.combined.ratios, null)
console.log(
  JSON.stringify({
    passedTrials: passed,
    retainedFailedTrials: failed,
    verifiedCleanSourceSnapshots: snapshots,
    profiles,
    milestoneAccepted: false,
  })
)
