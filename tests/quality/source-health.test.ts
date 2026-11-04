import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkSourceHealth } from '../../scripts/quality/source-health.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(
  files: Record<string, string>,
  manifest: object = { exports: './src/index.ts' }
) {
  const root = await mkdtemp(join(tmpdir(), 'bun-native-source-health-'))
  temporary.push(root)
  const directory = join(root, 'packages/example')
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, 'package.json'), JSON.stringify(manifest))
  for (const [name, source] of Object.entries(files)) {
    const file = join(directory, 'src', name)
    await mkdir(dirname(file), { recursive: true })
    await Bun.write(file, source)
  }
  return root
}

describe('production package source health', () => {
  test('keeps public exports, imported values, reexport aliases and type contracts', async () => {
    const root = await fixture({
      'index.ts': 'export { live as publicValue } from "./live.js"; export const unusedPublic = 1;',
      'live.ts':
        'export interface Contract { value: number }; export const live: Contract = { value: 1 };',
    })
    expect(await checkSourceHealth(root)).toEqual([])
  })

  test('detects dead mutually importing modules and does not let tests make them reachable', async () => {
    const root = await fixture({
      'index.ts': 'export const live = 1;',
      'dead.ts': 'export { other } from "./other"; export const dead = 1;',
      'other.ts': 'export { dead } from "./dead"; export const other = 1;',
    })
    await mkdir(join(root, 'tests'))
    await Bun.write(
      join(root, 'tests/dead.test.ts'),
      'import { dead } from "../packages/example/src/dead";'
    )
    expect(await checkSourceHealth(root)).toEqual([
      'packages/example/src/dead.ts: source is unreachable from package exports/bin',
      'packages/example/src/other.ts: source is unreachable from package exports/bin',
    ])
  })

  test('reports unused internal values with their exact path and export name', async () => {
    const root = await fixture({
      'index.ts': 'import { live as value } from "./helper"; export { value };',
      'helper.ts': 'export const live = 1, obsolete = 2; export default 3;',
    })
    expect(await checkSourceHealth(root)).toEqual([
      'packages/example/src/helper.ts: unused internal export default',
      'packages/example/src/helper.ts: unused internal export obsolete',
    ])
  })

  test('keeps rooted cycles, default imports and directory entries', async () => {
    const root = await fixture({
      'index.ts': 'import value from "./nested"; export const live = value;',
      'nested/index.ts': 'import { live } from "../index.ts"; export default () => live;',
    })
    expect(await checkSourceHealth(root)).toEqual([])
  })

  test('handles namespace and wildcard exports while a bare star excludes default', async () => {
    const root = await fixture({
      'index.ts': 'export * from "./named"; export * as all from "./namespace";',
      'named.ts': 'export const value = 1; export default 2;',
      'namespace.ts': 'export const value = 1; export default 2;',
    })
    expect(await checkSourceHealth(root)).toEqual([
      'packages/example/src/named.ts: unused internal export default',
    ])
    await Bun.write(
      join(root, 'packages/example/src/index.ts'),
      'export * from "./named"; export { default } from "./named"; import * as all from "./namespace"; export { all };'
    )
    expect(await checkSourceHealth(root)).toEqual([])
  })

  test('accepts conditional public subpaths and explicit CLI entries', async () => {
    const root = await fixture(
      {
        'index.ts': 'export const value = 1;',
        'development.ts': 'export const debug = 1;',
        'jsx.ts': 'export const jsx = 1;',
        'cli.ts': 'console.log("CLI");',
      },
      {
        exports: {
          '.': { development: './src/development.ts', default: './src/index.ts' },
          './jsx': './src/jsx.ts',
        },
        bin: { example: './src/cli.ts' },
      }
    )
    expect(await checkSourceHealth(root)).toEqual([])
  })

  test.each([
    'export const value = import("./helper");',
    'export const value = require("./helper");',
    'import value = require("./helper"); export { value };',
    'export type Value = import("./helper").Value;',
  ])('preserves literal module loads: %s', async (source) => {
    const root = await fixture({
      'index.ts': source,
      'helper.ts': 'export const value = 1; export interface Value { value: number };',
    })
    expect(await checkSourceHealth(root)).toEqual([])
  })

  test('side-effect imports retain source without keeping unnecessary exports', async () => {
    const root = await fixture({
      'index.ts': 'import "./effect"; export const value = 1;',
      'effect.ts': 'console.log("effect"); export const obsolete = 1;',
    })
    expect(await checkSourceHealth(root)).toEqual([
      'packages/example/src/effect.ts: unused internal export obsolete',
    ])
  })

  test('does not treat comments or strings as imports', async () => {
    const root = await fixture({
      'index.ts': 'export const text = \'import("./dead")\'; // export * from "./dead"',
      'dead.ts': 'export const dead = 1;',
    })
    expect(await checkSourceHealth(root)).toEqual([
      'packages/example/src/dead.ts: source is unreachable from package exports/bin',
    ])
  })

  test('fails closed for stale source entries, missing imports, computed loads and invalid syntax', async () => {
    const stale = await fixture(
      { 'index.ts': 'export const value = 1;' },
      { exports: './src/missing.ts' }
    )
    expect(await checkSourceHealth(stale)).toContain(
      'packages/example/package.json: unresolved source entry ./src/missing.ts'
    )
    const missing = await fixture({ 'index.ts': 'import "./missing";' })
    expect(await checkSourceHealth(missing)).toContain(
      'packages/example/src/index.ts: unresolved local source ./missing'
    )
    const computed = await fixture({
      'index.ts': 'const path = "./helper"; export const value = import(path);',
    })
    expect(await checkSourceHealth(computed)).toContain(
      'packages/example/src/index.ts: non-literal module load cannot be source-audited'
    )
    const invalid = await fixture({ 'index.ts': 'export const = ;' })
    expect((await checkSourceHealth(invalid)).some((error) => error.includes('parse error:'))).toBe(
      true
    )
  })
})
