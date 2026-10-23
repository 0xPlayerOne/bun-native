import { it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CLASSES,
  WORKFLOWS,
  deriveMatrix,
  readMatrixRows,
} from '../scripts/adea-workflow-matrix.ts'

const root = resolve(import.meta.dirname, '..')

/** One cell of a matrix row, narrowed: a short row is a failure, not a hole. */
function cell(row: string[], index: number): string {
  const value = row[index]
  assert.ok(value !== undefined, `the matrix row is short at cell ${index}`)
  return value
}

it('derives every workflow row from the wrapper sources', () => {
  const derived = deriveMatrix(root)
  assert.equal(derived.length, WORKFLOWS.length)
  for (const row of derived) {
    assert.ok(row.state === 'present' || row.state === 'absent', row.area)
    if (row.state === 'present') assert.ok(row.files.length > 0, row.area)
  }
})

it('states the workflow matrix with a class and evidence for every row', () => {
  const rows = readMatrixRows(root)
  assert.equal(rows.length, WORKFLOWS.length)
  const areas = rows.map((row) => row[0])
  for (const workflow of WORKFLOWS) assert.ok(areas.includes(workflow.area), workflow.area)
  for (const row of rows) {
    const area = cell(row, 0)
    const blockerClass = cell(row, 3)
    const evidence = cell(row, 4)
    assert.ok(
      (CLASSES as readonly string[]).includes(blockerClass),
      `${area} class ${blockerClass}`
    )
    assert.ok(
      evidence.includes('fixture:') || evidence.toLowerCase().includes('gap'),
      `${area} evidence ${evidence}`
    )
    assert.ok(cell(row, 5).length > 0, `${area} platform`)
    assert.ok(cell(row, 6).length > 0, `${area} impact`)
    assert.ok(cell(row, 7).length > 0, `${area} candidate fix`)
  }
})

it('cites only repository paths that exist', () => {
  const document = readFileSync(join(root, 'docs', 'm11-adea-workflow-matrix.md'), 'utf8')
  const cited = [...document.matchAll(/`((?:packages|scripts|tests|docs)\/[^`]+)`/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
  assert.ok(cited.length > 0)
  for (const path of cited) {
    if (path.includes('#')) continue
    if (path.includes('*')) continue // a source glob, not a path
    assert.ok(existsSync(join(root, path)), path)
  }
})

it('keeps the rendering capability claim explicit and untested', () => {
  const document = readFileSync(join(root, 'docs', 'm11-adea-workflow-matrix.md'), 'utf8')
  assert.ok(document.includes('WebGL'))
  assert.ok(document.includes('not tested'))
  assert.ok(document.includes('engine/public-API limitation'))
})
