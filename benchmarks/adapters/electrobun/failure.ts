import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Trial } from '../../lib/results.ts'

/** Preserve the full failure separately from the bounded result-matrix reason. */
export async function recordElectrobunFailure(
  directory: string,
  scenario: string,
  trial: number,
  warmup: boolean,
  error: unknown
): Promise<Trial> {
  const file = `electrobun-failure-${randomUUID()}.json`
  await writeFile(
    join(directory, file),
    JSON.stringify({ scenario, trial, warmup, error: String(error) }, null, 2) + '\n',
    { flag: 'wx' }
  )
  return {
    variant: 'electrobun',
    scenario,
    trial,
    warmup,
    status: 'failed',
    reason: `Actual Electrobun execution failed; raw evidence: ${file}`,
    correctness: { passed: false, details: 'Actual Electrobun execution failed' },
    metrics: {},
  }
}
