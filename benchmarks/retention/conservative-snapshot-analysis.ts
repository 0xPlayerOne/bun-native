import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { analyzeSnapshot, type DebugSnapshot, type Target } from '../solid/retention-evidence.ts'

/** Experimental later-snapshot metadata; absence of a path is inconclusive. */
export function analyzeConservativeSnapshot(snapshot: DebugSnapshot, targets: readonly Target[]) {
  assert(Array.isArray(snapshot.conservativeRoots), 'Experimental conservative roots are missing')
  return {
    conservativeRootCount: snapshot.conservativeRoots.length,
    targets: analyzeSnapshot(snapshot, targets, 'experimental-conservative'),
    scope: 'Later instrumented snapshot only; omitted edges and other roots remain possible',
  }
}

export function runConservativeSnapshotAnalysis(args: readonly string[]) {
  const [snapshotPath, reportPath, outputPath] = args
  assert(snapshotPath && reportPath && outputPath, 'Expected snapshot, report and output paths')
  const snapshot = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(snapshotPath))))
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { targets?: unknown }
  assert(Array.isArray(report.targets), 'Missing target records')
  const targets = report.targets.map((value: unknown) => {
    assert(value && typeof value === 'object')
    const item = value as Record<string, unknown>
    assert(Number.isSafeInteger(item.index) && typeof item.address === 'string')
    return {
      index: item.index as number,
      address: item.address,
      kind: typeof item.kind === 'string' ? item.kind : '',
      description: typeof item.description === 'string' ? item.description : '',
    }
  })
  writeFileSync(
    outputPath,
    JSON.stringify(analyzeConservativeSnapshot(snapshot, targets), null, 2) + '\n',
    {
      flag: 'wx',
    }
  )
}

if (import.meta.main) runConservativeSnapshotAnalysis(process.argv.slice(2))
