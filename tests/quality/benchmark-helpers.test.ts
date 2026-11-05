import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  defaultCollectionRounds,
  observeCollection,
} from '../../benchmarks/retention/settled-observation.ts'
import { count } from '../../benchmarks/solid/workload.ts'

const root = resolve(import.meta.dir, '../..')

test('workload counts accept only safe integers within 1..maximum', () => {
  expect(count('1', 'rows', 128)).toBe(1)
  expect(count('128', 'rows', 128)).toBe(128)
  for (const value of [undefined, '', '0', '-1', '129', '1.5', 'NaN', 'Infinity', 'ten'])
    expect(() => count(value, 'rows', 128)).toThrow('rows must be an integer in 1..128')
})

function reference(survivingRounds: number) {
  let calls = 0
  const target = {}
  return {
    deref: () => (calls++ < survivingRounds ? target : undefined),
    calls: () => calls,
  }
}

test('settled observation stops at the first round with no survivors', async () => {
  const references = [reference(0), reference(2), reference(1)]
  const observation = await observeCollection(references)
  expect(observation).toEqual({ survivors: [], rounds: 3, maxRounds: defaultCollectionRounds })
  for (const item of references) expect(item.calls()).toBe(3)
})

test('settled observation reports targets that outlive every round', async () => {
  const references = [reference(0), reference(Infinity), reference(1), reference(Infinity)]
  const observation = await observeCollection(references, 2)
  expect(observation).toEqual({ survivors: [1, 3], rounds: 2, maxRounds: 2 })
})

test('settled observation rejects unbounded or fractional round counts', async () => {
  for (const rounds of [0, 21, 1.5, Number.NaN])
    await expect(observeCollection([], rounds)).rejects.toThrow(RangeError)
  expect(await observeCollection([], 20)).toEqual({ survivors: [], rounds: 1, maxRounds: 20 })
})

test('the AOT build helper README lists exactly the entries in build-window.ts', () => {
  const helper = readFileSync(resolve(root, 'experiments/aot-gpui/build-window.ts'), 'utf8')
  const block = helper.slice(helper.indexOf('const entries = {'), helper.indexOf('} as const'))
  const entries = [...block.matchAll(/^\s+'?([a-z-]+)'?: '([^']+)',$/gm)].map(([, name, path]) => [
    name,
    path,
  ])
  expect(entries.length).toBeGreaterThan(0)
  const readme = readFileSync(resolve(root, 'experiments/aot-gpui/README.md'), 'utf8')
  const documented = [
    ...readme.matchAll(/^\| `([a-z-]+)`(?: \(default\))?\s*\| `([^`]+)`\s*\| `([a-z-]+)`\s*\|/gm),
  ].map(([, name, path, executable]) => {
    expect(executable).toBe(name!)
    return [name, path]
  })
  expect(documented).toEqual(entries)
})
