import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const packages = ['core', 'solid', 'react'] as const

/** Public names of one package entry, as consumers import them. */
function exportedNames(source: string): Set<string> {
  const text = source.replace(/\/\*[^]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const names = new Set<string>()
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of match[1]!.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()!
        .trim()
      if (name) names.add(name)
    }
  for (const match of text.matchAll(/export\s+const\s+\{([^}]*)\}/g))
    for (const part of match[1]!.split(',')) if (part.trim()) names.add(part.trim())
  for (const match of text.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface)\s+(\w+)/g
  ))
    names.add(match[1]!)
  return names
}

/** Backticked names in the first cell of every table row on the reference page. */
function documentedNames(markdown: string): Set<string> {
  const names = new Set<string>()
  for (const line of markdown.split('\n')) {
    const cells = line.split('|')
    if (cells.length < 4 || cells[0]!.trim() !== '') continue
    for (const match of cells[1]!.matchAll(/`([A-Za-z_]\w*)`/g)) names.add(match[1]!)
  }
  return names
}

const reference = read('docs/api-reference.md')
const documented = documentedNames(reference)
const exported = new Set(
  packages.flatMap((name) => [...exportedNames(read(`packages/${name}/src/index.ts`))])
)

test('the parser finds each package entry point', () => {
  for (const name of packages)
    expect(exportedNames(read(`packages/${name}/src/index.ts`)).size).toBeGreaterThan(5)
  expect([...exportedNames('export { a, type B as C }\nexport const { d, e } = f')]).toEqual([
    'a',
    'C',
    'd',
    'e',
  ])
})

test('every public export has a row in docs/api-reference.md', () => {
  expect([...exported].filter((name) => !documented.has(name)).sort()).toEqual([])
})

test('every documented name is still exported', () => {
  expect([...documented].filter((name) => !exported.has(name)).sort()).toEqual([])
})
