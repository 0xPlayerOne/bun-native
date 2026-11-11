import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'bun'
import {
  analyzeSnapshot,
  cellAddress,
  normalizeAddress,
  rootReasonCounts,
  writeRetentionEvidence,
  type DebugSnapshot,
} from '../../benchmarks/solid/retention-evidence.ts'

// Nodes: [id, size, class, flags, label, cell, wrapped]; edges: [from, to, type, data].
function snapshot(): DebugSnapshot {
  return {
    nodes: [
      [1, 8, 0, 0, 1, '0x10', '0x0'],
      [2, 8, 1, 0, 0, '0x20', '0x0'],
      [3, 8, 2, 0, 0, '0x30', '0x0'],
      [4, 8, 3, 0, 0, '0x40', '0x0'],
      [5, 8, 2, 0, 0, '0x50', '0x0'],
      [6, 8, 4, 0, 0, '0x60', '0x0'],
    ].flat(),
    nodeClassNames: ['GlobalObject', 'Holder', 'Target', 'WeakRef', 'Unrooted'],
    // Node 6 owns the target strongly but has no visible path from a root.
    edges: [
      [1, 2, 1, 0],
      [2, 3, 2, 7],
      [4, 3, 0, 0],
      [4, 5, 0, 0],
      [6, 3, 0, 0],
    ].flat(),
    edgeTypes: ['Internal', 'Property', 'Index', 'Variable'],
    edgeNames: ['cache'],
    roots: [1, 2, 0, 4, 3, 0],
    labels: ['', 'global', 'StrongReferences', 'Conservative'],
  }
}

test('retention analysis reports the shortest strong path from a GC root', () => {
  const [held, weakOnly, absent] = analyzeSnapshot(snapshot(), [
    { index: 3, kind: 'mount 1 render root', address: '0x30', description: '' },
    { index: 5, kind: 'mount 1 listener', address: '0x50', description: '' },
    { index: 4, kind: 'mount 1 content node', address: '0x99', description: '' },
  ])
  expect(held).toMatchObject({
    presentInSnapshot: true,
    directRetainerCount: 3,
    strongRetainerCount: 2,
    strongOwnerCount: 2,
    ownersWithoutRootPath: 1,
    searchTruncated: false,
  })
  if (!held?.presentInSnapshot) throw new Error('target missing')
  expect(
    held.pathsFromRoots.map((path) => path.map(({ className, edge }) => [className, edge]))
  ).toEqual([
    [
      ['GlobalObject', 'Property cache'],
      ['Holder', 'Index [7]'],
      ['Target', null],
    ],
  ])
  expect(held.pathsFromRoots[0]![0]!.rootReasons).toEqual(['StrongReferences'])
  // A WeakRef is reported as a retainer but never as a strong path.
  expect(weakOnly).toMatchObject({ presentInSnapshot: true, strongRetainerCount: 0 })
  if (!weakOnly?.presentInSnapshot) throw new Error('target missing')
  expect(weakOnly.pathsFromRoots).toEqual([])
  expect(absent).toMatchObject({ presentInSnapshot: false })
  expect(rootReasonCounts(snapshot())).toEqual({ StrongReferences: 1, Conservative: 1 })
})

test('Windows jscDescribe addresses match lowercase unpadded snapshot cells', () => {
  // Recorded on windows-2022 (run 42951989943): jscDescribe prints
  // `0x00000281357D3660`, the debugging snapshot stores `0x281357d3660`.
  expect(normalizeAddress('0x00000281357D3660')).toBe('0x281357d3660')
  expect(normalizeAddress('0x281357d3660')).toBe('0x281357d3660')
  expect(normalizeAddress('?')).toBe('?')
  const [held] = analyzeSnapshot(snapshot(), [
    { index: 3, kind: 'mount 1 render root', address: '0x0000000000000030', description: '' },
  ])
  expect(held).toMatchObject({ presentInSnapshot: true })
  expect(cellAddress({}).address).toMatch(/^0x[0-9a-f]+$/)
})

test('a target that is itself a root yields a one-step path', () => {
  const [root] = analyzeSnapshot(snapshot(), [
    { index: 0, kind: 'mount 0 render root', address: '0x40', description: '' },
  ])
  if (!root?.presentInSnapshot) throw new Error('target missing')
  expect(root.pathsFromRoots).toHaveLength(1)
  expect(root.pathsFromRoots[0]![0]!.rootReasons).toEqual(['Conservative'])
})

class RetentionEvidenceTarget {
  readonly marker = 'issue-629'
}
const retained = new RetentionEvidenceTarget()
Reflect.set(globalThis, '__retentionEvidenceHolder', { retained })

test('failure-only evidence finds a real global owner and writes bounded files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-retention-'))
  try {
    const output = join(directory, 'react-development-calibration.json')
    const summary = await writeRetentionEvidence({
      output,
      probes: [new WeakRef({}), new WeakRef(retained)],
      stillReachable: [1],
      probeKinds: ['render root', 'listener'],
    })
    expect(summary).toEqual({
      report: `${output}.retention.json`,
      heapSnapshot: `${output}.retention-heap.json.gz`,
    })
    const report = JSON.parse(readFileSync(`${output}.retention.json`, 'utf8'))
    expect(report.targets[0]).toMatchObject({
      index: 1,
      kind: 'mount 0 listener',
      address: cellAddress(retained).address,
    })
    for (const phase of ['sameJob', 'nextTask']) {
      const [target] = report[phase].targets
      expect(target.presentInSnapshot).toBe(true)
      const labels = target.pathsFromRoots.flatMap((path: { edge: string | null }[]) =>
        path.map((step) => step.edge)
      )
      expect(labels).toContain('Property __retentionEvidenceHolder')
      expect(labels).toContain('Property retained')
    }
    const heap = JSON.parse(
      new TextDecoder().decode(gunzipSync(readFileSync(`${output}.retention-heap.json.gz`)))
    )
    expect(heap.roots.length).toBeGreaterThan(0)
    // Evidence never overwrites an earlier launch's files.
    const again = await writeRetentionEvidence({
      output,
      probes: [new WeakRef(retained)],
      stillReachable: [0],
      probeKinds: ['render root'],
    })
    expect(again['heapSnapshot']).toBeUndefined()
    expect(again['writeError']).toContain('EEXIST')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a collected target is recorded rather than failing the evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-retention-'))
  try {
    const output = join(directory, 'core-aot-first.json')
    writeFileSync(`${output}.retention-heap.json.gz`, 'existing')
    const summary = await writeRetentionEvidence({
      output,
      probes: [{ deref: () => undefined } as unknown as WeakRef<object>],
      stillReachable: [0],
      probeKinds: ['container handle'],
    })
    expect(existsSync(`${output}.retention.json`)).toBe(true)
    const report = JSON.parse(readFileSync(`${output}.retention.json`, 'utf8'))
    expect(report.targets[0]).toMatchObject({ description: 'collected', address: '' })
    // The existing snapshot file is never replaced; the error is recorded instead.
    expect(report.heapSnapshot.error).toContain('EEXIST')
    expect(report.nextTask.targets[0].presentInSnapshot).toBe(false)
    expect(summary['error']).toBeUndefined()
    expect(readFileSync(`${output}.retention-heap.json.gz`, 'utf8')).toBe('existing')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
