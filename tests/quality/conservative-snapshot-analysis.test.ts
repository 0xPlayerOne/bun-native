import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeConservativeSnapshot,
  runConservativeSnapshotAnalysis,
} from '../../benchmarks/retention/conservative-snapshot-analysis.ts'
import type { DebugSnapshot } from '../../benchmarks/solid/retention-evidence.ts'

const snapshot: DebugSnapshot = {
  nodes: [
    [1, 0, 0, 0, 0, '0x10', '0x0'],
    [2, 0, 1, 0, 0, '0x20', '0x0'],
    [3, 0, 2, 0, 0, '0x30', '0x0'],
    [4, 0, 1, 0, 0, '0x40', '0x0'],
  ].flat(),
  nodeClassNames: ['Object', 'Target', 'WeakRef'],
  edges: [1, 2, 0, 0, 1, 3, 0, 0, 3, 4, 0, 0],
  edgeTypes: ['Internal'],
  edgeNames: [],
  roots: [],
  labels: [],
  conservativeRoots: [1],
}
const targets = [
  { index: 0, kind: '', description: '', address: '0X0020' },
  { index: 1, kind: '', description: '', address: '0x40' },
  { index: 2, kind: '', description: '', address: '0x99' },
]

test('experimental analysis follows strong edges and fails closed on invalid metadata', () => {
  const result = analyzeConservativeSnapshot(snapshot, targets)
  expect(result.conservativeRootCount).toBe(1)
  const [strong, weak, absent] = result.targets
  if (!strong?.presentInSnapshot || !weak?.presentInSnapshot) throw new Error('target missing')
  expect(strong.pathsFromRoots[0]?.map((step) => step.id)).toEqual([1, 2])
  expect(weak.pathsFromRoots).toEqual([])
  expect(absent).toMatchObject({ presentInSnapshot: false })
  expect(() =>
    analyzeConservativeSnapshot({ ...snapshot, conservativeRoots: [1, 1] }, [])
  ).toThrow()
  expect(() => analyzeConservativeSnapshot({ ...snapshot, conservativeRoots: [99] }, [])).toThrow()
  const withoutRoots = { ...snapshot }
  delete withoutRoots.conservativeRoots
  expect(() => analyzeConservativeSnapshot(withoutRoots, [])).toThrow()
})

test('experimental analysis CLI reads bounded evidence and refuses overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-native-conservative-'))
  try {
    const heap = join(root, 'heap.gz')
    const report = join(root, 'report.json')
    const output = join(root, 'analysis.json')
    writeFileSync(heap, Bun.gzipSync(JSON.stringify(snapshot)))
    writeFileSync(report, JSON.stringify({ targets }))
    const args = [
      process.execPath,
      'benchmarks/retention/conservative-snapshot-analysis.ts',
      heap,
      report,
      output,
    ]
    expect(Bun.spawnSync(args).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8')).conservativeRootCount).toBe(1)
    expect(Bun.spawnSync(args).exitCode).not.toBe(0)
    const directOutput = join(root, 'direct-analysis.json')
    runConservativeSnapshotAnalysis([heap, report, directOutput])
    expect(JSON.parse(readFileSync(directOutput, 'utf8'))).toEqual(
      JSON.parse(readFileSync(output, 'utf8'))
    )
    expect(() => runConservativeSnapshotAnalysis([])).toThrow()
    expect(() => runConservativeSnapshotAnalysis([heap, report, directOutput])).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('snapshot diagnostic environment drops unrelated variables', () => {
  const python = String.raw`
import importlib.util
spec = importlib.util.spec_from_file_location('safe', 'benchmarks/retention/snapshot_safe_run.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.safe_environment({'PATH': '/bin', 'SystemRoot': 'system', 'SECRET_TOKEN': 'redacted'}) == {'PATH': '/bin', 'SystemRoot': 'system'}
`
  const result = Bun.spawnSync(
    [process.platform === 'win32' ? 'python' : 'python3', '-c', python],
    {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
