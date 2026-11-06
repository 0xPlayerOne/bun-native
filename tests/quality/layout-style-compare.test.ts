import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, '../native/layout-style-compare.ts')
const directory = mkdtempSync(join(tmpdir(), 'layout-style-compare-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const tree = { element: { kind: 'box', style: {} }, children: [] }
function report(name: string, adapter: string, scale: number, geometry: number[], kind = 'box') {
  const snapshot = {
    tree: { ...tree, element: { kind, style: {} } },
    geometry: { root: geometry },
  }
  const file = join(directory, name + '.json')
  writeFileSync(
    file,
    JSON.stringify({
      adapter,
      mode: 'development',
      scale,
      outcomes: {},
      snapshots: { initial: snapshot, declared: snapshot, resized: snapshot },
    })
  )
  return file
}
function compare(...files: string[]) {
  return Bun.spawnSync([process.execPath, script, ...files], { stdout: 'pipe', stderr: 'pipe' })
}

test('identical adapters and a nearby HiDPI geometry compare equal', () => {
  const result = compare(
    report('core', 'core', 1, [0, 0, 100, 20]),
    report('solid', 'solid', 1, [0, 0, 100, 20]),
    report('hidpi', 'react', 2, [0, 0, 100.25, 20])
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).status).toBe('identical')
})

test('a different element tree or same-scale geometry fails the comparison', () => {
  const reference = report('reference', 'core', 1, [0, 0, 100, 20])
  expect(
    compare(reference, report('tree', 'solid', 1, [0, 0, 100, 20], 'split')).exitCode
  ).not.toBe(0)
  expect(compare(reference, report('moved', 'react', 1, [0, 0, 100.25, 20])).exitCode).not.toBe(0)
  expect(compare(reference, report('hidpi-far', 'react', 2, [0, 0, 101, 20])).exitCode).not.toBe(0)
  expect(compare(reference).exitCode).not.toBe(0)
})
