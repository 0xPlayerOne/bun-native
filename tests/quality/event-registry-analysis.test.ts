import { expect, test } from 'bun:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const analyzer = join(root, 'benchmarks/core/analyze-event-registry-pairs.py')
const archive = join(
  root,
  'benchmarks/results/empty-event-registry-macos-2026-11-14/hosted-linux-pairs.json.gz'
)

function run(source: string) {
  return Bun.spawnSync([process.platform === 'win32' ? 'python' : 'python3', analyzer, source], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

test('event benchmark analysis reproduces paired evidence and rejects invalid observations', () => {
  const result = run(archive)
  expect(result.exitCode).toBe(0)
  const analysis = JSON.parse(result.stdout.toString())
  expect(analysis.summary.aot.empty.pairs).toBe(12)
  expect(analysis.summary.aot.empty.fasterPairs).toBe(12)
  expect(analysis.summary.aot.empty.candidateMinusBaselineMedianNs).toBeCloseTo(-35.12, 2)
  expect(analysis.summary.development['off-path'].candidateMinusBaselineMedianNs).toBeCloseTo(
    0.59,
    2
  )

  const temp = mkdtempSync(join(tmpdir(), 'event-pairs-analysis-'))
  try {
    const original = JSON.parse(gunzipSync(readFileSync(archive)).toString())
    const file = join(temp, 'invalid.json.gz')
    for (const mutate of [
      (data: typeof original) => data.runs.pop(),
      (data: typeof original) => (data.runs[1] = data.runs[0]),
      (data: typeof original) => (data.runs[0].data.results[0].medianNs = -1),
      (data: typeof original) => (data.runs[0].data.revision = 'wrong'),
    ]) {
      const altered = structuredClone(original)
      mutate(altered)
      writeFileSync(file, gzipSync(JSON.stringify(altered)))
      expect(run(file).exitCode).not.toBe(0)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
