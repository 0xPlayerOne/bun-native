import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { inspectSource, checkBoundaries } from '../scripts/check-boundaries.ts'
const root = resolve(import.meta.dirname, '..')
it('enforces current package boundaries', async () =>
  assert.deepEqual(await checkBoundaries(root), []))
it('detects runtime, native, type-only and dynamic escapes in browser packages', () => {
  const file = resolve(root, 'packages/client/src/seed.ts')
  for (const source of [
    "import {x} from '../../runtime/src/index.ts'",
    "export * from '@bunly/runtime'",
    "import type {Foo} from 'node:fs'",
    "const x=import('bun:ffi')",
    "type T=import('node:fs').Stats",
    'const x=import(name)',
    "Bun.spawn(['x'])",
    'process.exit()',
  ])
    assert.ok(inspectSource(file, source, root).length > 0, source)
})
it('permits portable contract dependencies', () =>
  assert.deepEqual(
    inspectSource(
      resolve(root, 'packages/client/src/ok.ts'),
      "import type {ViewState} from '../../contracts/src/index.ts'",
      root
    ),
    []
  ))
it('permits only the private isolated runner application-entry expression', () => {
  const runner = resolve(root, 'packages/runtime/src/service-reload-runner.ts')
  const permitted = 'const application = await import(pathToFileURL(entry).href)'
  assert.deepEqual(inspectSource(runner, permitted, root), [])
  for (const source of [
    'const application = import(entry)',
    'const application = import(pathToFileURL(other).href)',
    "const application = import(pathToFileURL(entry)['href'])",
    'const application = import(pathToFileURL(entry).href, {with:{type:"json"}})',
    'const application = require(pathToFileURL(entry).href)',
    `${permitted};const duplicate = import(pathToFileURL(entry).href)`,
    `${permitted};import {x} from '@bunly/artifacts'`,
  ])
    assert.ok(inspectSource(runner, source, root).length > 0, source)
  for (const file of [
    'packages/runtime/src/other.ts',
    'packages/client/src/service-reload-runner.ts',
    'packages/contracts/src/service-reload-runner.ts',
    'packages/cli/src/service-reload-runner.ts',
  ])
    assert.ok(inspectSource(resolve(root, file), permitted, root).length > 0, file)
})
