import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { assessTerminalLoad } from '../benchmarks/lib/terminal-load-acceptance.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'
test('historical workload failures and CEF teardown failures stay independent, including overlap', async () => {
  const archive = JSON.parse(
    gunzipSync(
      await readFile(new URL('../evidence/m5-terminal-load/raw-evidence.json.gz', import.meta.url))
    ).toString()
  )
  const run = archive.runs.find((item: { id: string }) => item.id === 'run-LpSEdA')
  const report = decodeExportedNativeReport(run.files['report.json'].data)
  let workloadFailures = 0,
    watchdogs = 0,
    overlap = 0,
    failedWithCompletePhases = 0
  for (const trial of report['trials'] as Record<string, unknown>[]) {
    const raw =
      run.files[`trial-${trial['index']}-${trial['mode']}.jsonl`].data
        .map((row: unknown) => JSON.stringify(row))
        .join('\n') + '\n'
    const result = assessTerminalLoad(trial['observation'], raw, String(trial['mode']))
    if (!result.workload.passed) workloadFailures++
    if (result.watchdog) watchdogs++
    if (!result.workload.passed && result.watchdog) overlap++
    if (!result.workload.passed && result.shutdownPhases.complete) failedWithCompletePhases++
  }
  assert.deepEqual(
    { workloadFailures, watchdogs, overlap, failedWithCompletePhases },
    { workloadFailures: 4, watchdogs: 2, overlap: 1, failedWithCompletePhases: 3 }
  )
})
