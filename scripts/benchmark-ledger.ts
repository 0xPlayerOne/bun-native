import { readFile } from 'node:fs/promises'
import { validateStageMatrix, type StageRecord } from '../benchmarks/lib/stages.ts'
import { validateByteMatrix, type ByteObservation } from '../benchmarks/lib/accounting.ts'
const [filename] = process.argv.slice(2)
if (!filename)
  throw new Error('Usage: bun scripts/benchmark-ledger.ts <stage-and-byte-ledger.json>')
const input: unknown = JSON.parse(await readFile(filename, 'utf8'))
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected ledger')
const value = input as Record<string, unknown>
if (value['schema'] !== 1 || !Array.isArray(value['stages']) || !Array.isArray(value['bytes']))
  throw new Error('Expected schema 1 with stages and bytes')
const stages = validateStageMatrix(value['stages'] as StageRecord[]),
  bytes = validateByteMatrix(value['bytes'] as ByteObservation[])
const failed = stages.filter((row) => row.status === 'failed')
const unmeasured = [
  ...stages.filter((row) => row.status === 'unsupported').map((row) => `stage:${row.stage}`),
  ...bytes.filter((row) => row.status === 'unavailable').map((row) => `bytes:${row.category}`),
]
console.log(
  JSON.stringify(
    {
      schema: 1,
      status: failed.length ? 'failed' : unmeasured.length ? 'incomplete' : 'complete',
      failed,
      unmeasured,
      stages,
      bytes,
      limitations: [
        'Completeness is accounting coverage, not benchmark comparability or a performance advantage. Categories are not summed.',
      ],
    },
    null,
    2
  )
)
process.exitCode = failed.length ? 1 : unmeasured.length ? 2 : 0
