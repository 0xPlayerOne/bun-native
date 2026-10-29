import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const sdk = ['artifacts', 'cli', 'client', 'contracts', 'runtime']

test('one framework release synchronizes SDK and public backend versions', async () => {
  const config = await Bun.file(resolve(root, 'release-please-config.json')).json()
  const manifest = await Bun.file(resolve(root, '.release-please-manifest.json')).json()
  const pkg = await Bun.file(resolve(root, 'package.json')).json()
  expect(Object.keys(config.packages)).toEqual(['.'])
  expect(Object.keys(manifest)).toEqual(['.'])
  expect(config.packages['.']['release-type']).toBe('node')
  expect(config.packages['.']['initial-version']).toBe('0.1.0')
  expect(config.packages['.']['include-component-in-tag']).toBe(false)
  const extra = config.packages['.']['extra-files']
  for (const name of sdk) {
    const path = `packages/${name}/package.json`
    expect(extra).toContainEqual({ type: 'json', path, jsonpath: '$.version' })
    expect((await Bun.file(resolve(root, path)).json()).version).toBe(pkg.version)
  }
  for (const name of ['cef', 'mock']) {
    const path = `packages/runtime/src/${name}.ts`
    expect(extra).toContainEqual({ type: 'generic', path })
    const source = await readFile(resolve(root, path), 'utf8')
    expect(source).toContain(`version: '${pkg.version}', // x-release-please-version`)
  }
})
