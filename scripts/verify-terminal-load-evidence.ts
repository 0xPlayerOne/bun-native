/** Replay exported current-source load evidence; failures must remain failures. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
import { acceptTerminalLoad } from '../benchmarks/lib/terminal-load-acceptance.ts'
import { acceptGraphicalTerminal } from '../benchmarks/lib/cef-terminal-acceptance.ts'

const root = resolve(import.meta.dir, '..')
const historical = process.argv.includes('--historical')
const base = resolve(
  root,
  process.argv.slice(2).find((arg) => arg !== '--historical') ?? 'evidence/m5-terminal-load'
)
const manifest = JSON.parse(await readFile(resolve(base, 'manifest.json'), 'utf8'))
const compressed = await readFile(resolve(base, 'raw-evidence.json.gz'))
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(compressed), manifest.archive.sha256)
const bytes = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
assert.equal(sha(bytes), manifest.expanded.sha256)
const archive = JSON.parse(bytes.toString('utf8'))
assert.equal(archive.schema, 1)
for (const [path, hash] of Object.entries(manifest.sourceHashes))
  assert.equal(
    sha(
      historical
        ? Bun.spawnSync(['git', 'show', `${manifest.source.commit}:${path}`], { cwd: root }).stdout
        : await readFile(resolve(root, path))
    ),
    hash,
    `Qualification source differs: ${path}`
  )
const run = archive.runs.find((entry: { id: string }) => entry.id === manifest.qualifiedRun)
assert.ok(run)
const report = decodeExportedNativeReport(run.files['report.json'].data)
assert.deepEqual(report['sourceHashes'], manifest.sourceHashes)
const trials = report['trials'] as Record<string, unknown>[]
assert.equal(trials.length, 12)
let passed = 0
let failed = 0
for (const trial of trials) {
  const name = `trial-${trial['index']}-${trial['mode']}.jsonl`
  const file = run.files[name]
  assert.ok(file)
  assert.equal(file.original.sha256, trial['rawSha256'])
  const raw = file.data.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n'
  if (trial['passed'] === true) {
    assert.deepEqual(
      acceptTerminalLoad(trial['observation'], raw, String(trial['mode'])),
      trial['metrics']
    )
    passed++
  } else {
    assert.throws(() => acceptTerminalLoad(trial['observation'], raw, String(trial['mode'])))
    failed++
  }
}
assert.equal(report['passed'], failed === 0)
const functional = decodeExportedNativeReport(archive.originalFunctional.data)
for (const trial of functional['trials'] as Record<string, unknown>[])
  assert.deepEqual(acceptGraphicalTerminal(trial['observation']), trial['metrics'])
console.log(
  JSON.stringify({
    sourceTree: manifest.sourceTree,
    passedTrials: passed,
    retainedFailedTrials: failed,
    originalFunctional: true,
    currentProfileAccepted: report['passed'],
    historicalRunsRetained: archive.runs.length,
  })
)
