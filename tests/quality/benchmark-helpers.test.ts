import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fixtures } from '../../scripts/quality/native-fixtures.ts'
import {
  defaultCollectionRounds,
  observeCollection,
} from '../../benchmarks/retention/settled-observation.ts'

const root = resolve(import.meta.dir, '../..')

// `count` is evaluated in a child Bun so that the rest of the benchmark
// workload, which needs a native host, stays out of the per-file coverage report.
function counted(values: (string | undefined)[], maximum: number): (number | string)[] {
  const workload = resolve(root, 'benchmarks/solid/workload.ts')
  const source =
    `const { count } = await import(${JSON.stringify(workload)})\n` +
    `const values = ${JSON.stringify(values)}.map((value) => value ?? undefined)\n` +
    'console.log(JSON.stringify(values.map((value) => {\n' +
    `  try { return count(value, 'rows', ${maximum}) }\n` +
    '  catch (error) { return String(error.message) }\n' +
    '})))'
  const result = Bun.spawnSync([process.execPath, '--eval', source], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}

test('workload counts accept only safe integers within 1..maximum', () => {
  const rejected = [undefined, '', '0', '-1', '129', '1.5', 'NaN', 'Infinity', 'ten']
  expect(counted(['1', '128', ...rejected], 128)).toEqual([
    1,
    128,
    ...rejected.map(() => 'rows must be an integer in 1..128'),
  ])
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
  expect(observation).toEqual({
    survivors: [],
    rounds: 3,
    maxRounds: defaultCollectionRounds,
  })
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
  expect(await observeCollection([], 20)).toEqual({
    survivors: [],
    rounds: 1,
    maxRounds: 20,
  })
})

test('the AOT build helper README lists exactly the native fixture entries', () => {
  const entries = Object.entries(fixtures).map(([name, fixture]) => [name, fixture.path])
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
