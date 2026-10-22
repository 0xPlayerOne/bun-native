import { gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { validateRun, reportRun, compareRuns } from '../benchmarks/lib/results.ts'
const directory = resolve(import.meta.dir, '../evidence/m2-baselines')
const inputs = JSON.parse(await readFile(join(directory, 'inputs.json'), 'utf8')) as {
  schema: number
  inputs: {
    adapter: string
    sourceCommit: string
    savedReport: string
    memberSha256: string
    storedSha256: string
  }[]
}
if (inputs.schema !== 1 || inputs.inputs.length !== 2)
  throw new Error('Invalid historical input inventory')
const runs = []
for (const input of inputs.inputs) {
  if (!['electrobun.json.gz', 'electron.json.gz'].includes(input.savedReport))
    throw new Error('Unexpected historical report path')
  const stored = await readFile(join(directory, input.savedReport))
  if (createHash('sha256').update(stored).digest('hex') !== input.storedSha256)
    throw new Error('Stored historical report hash mismatch')
  const bytes = gunzipSync(stored, { maxOutputLength: 4 * 1024 * 1024 })
  if (createHash('sha256').update(bytes).digest('hex') !== input.memberSha256)
    throw new Error('Historical report hash mismatch')
  const run = validateRun(JSON.parse(bytes.toString('utf8')))
  if (
    run.sourceCommit !== input.sourceCommit ||
    run.environment.runClass !== 'ci-smoke' ||
    run.variants.length !== 1 ||
    run.variants[0]?.id !== input.adapter
  )
    throw new Error('Historical report identity mismatch')
  if (reportRun(run).some((row) => row.eligibleForPerformanceClaim))
    throw new Error('Historical smoke report became performance eligible')
  runs.push(run)
}
const comparison = compareRuns(runs[0], runs[1], 'electrobun', 'electron')
if (comparison.comparable) throw new Error('Incompatible historical targets became comparable')
console.log(
  JSON.stringify(
    {
      verifiedReports: runs.length,
      independentExecutions: runs.map((run) => ({
        adapter: run.variants[0]!.id,
        passed: run.trials.filter((row) => row.status === 'passed').length,
        unsupported: run.trials.filter((row) => row.status === 'unsupported').length,
      })),
      comparison,
    },
    null,
    2
  )
)
