import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cliSourceClosure,
  consumerDefinitions,
  librarySourceFiles,
  materializedManifests,
} from '../../scripts/native/package-source.ts'
import { fixtureJSON } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')

async function fixture(exercise: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-source-unit-'))
  try {
    await exercise(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('package export/import materialization (source reads only)', () => {
  test('the actual CLI closure includes both compilers, inspectors and configuration without producer-only dependencies', async () => {
    const closure = await cliSourceClosure(repository)
    expect(closure.external).toEqual(['@babel/core', 'babel-preset-solid'])
    for (const path of [
      'scripts/native.ts',
      'scripts/native/host.ts',
      'scripts/native/build.ts',
      'scripts/native/session.ts',
      'scripts/native/watch.ts',
      'scripts/native/inputs.ts',
      'scripts/native/package-set.ts',
      'scripts/native/package-lock.ts',
      'scripts/solid-build.ts',
      'scripts/solid/transform.ts',
      'experiments/aot-gpui/compile.ts',
      'experiments/aot-gpui/inspect.ts',
      'experiments/aot-gpui/inspect-runtime.ts',
      'toolchain.json',
      'tsconfig.json',
    ])
      expect(closure.files).toContain(path)
    expect(closure.files).not.toContain('scripts/native/package-source.ts')
    expect(closure.files).toContain('scripts/native/package-archive.ts')
    expect(closure.files.some((path) => path.startsWith('scripts/quality/'))).toBe(false)
  })

  test('preserves all real library exports and every TS source file, with exact framework and public type dependencies', async () => {
    const manifests = await materializedManifests(repository, ['@babel/core', 'babel-preset-solid'])
    for (const name of ['core', 'protocol', 'runtime', 'renderer', 'solid', 'react']) {
      const directory = join(repository, 'packages', name)
      const source = await Bun.file(join(directory, 'package.json')).json()
      const actual = manifests[`@bun-native/${name}`]!
      expect(actual.exports).toEqual(source.exports)
      expect(actual.version).toBe(source.version)
      expect(fixtureJSON(actual)).not.toContain('workspace:')
      expect(actual.files).toEqual(['src', 'LICENSE', 'README.md', 'bun-native-source.json'])
      const files = await librarySourceFiles(directory)
      const independentlyListed = await Array.fromAsync(
        new Bun.Glob('src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}').scan({
          cwd: directory,
          onlyFiles: true,
        })
      )
      expect(files).toEqual(independentlyListed.sort())
      expect(files.length).toBeGreaterThan(0)
    }
    expect(manifests['@bun-native/solid']!.exports).toEqual({
      '.': './src/index.ts',
      './jsx-runtime': './src/jsx.ts',
    })
    expect(manifests['@bun-native/react']!.dependencies).toMatchObject({
      react: '19.3.1',
      'react-reconciler': '0.34.0',
      '@types/react': '19.3.0',
      '@types/react-reconciler': '0.34.1',
    })
    expect(manifests['@bun-native/cli']!.dependencies).toEqual({
      '@babel/core': '7.29.7',
      'babel-preset-solid': '1.9.16',
    })
    const consumers = await consumerDefinitions(repository, manifests)
    for (const framework of ['solid', 'react'] as const) {
      expect(consumers[framework].devDependencies['@types/bun']).toBe('1.4.4')
      expect(
        consumers[framework].lock.packages[
          'babel-plugin-jsx-dom-expressions/@babel/helper-module-imports'
        ]![0]
      ).toBe('@babel/helper-module-imports@7.18.6')
      expect(consumers[framework].lock.packages['undici-types']).toBeDefined()
    }
    expect(consumers.react.lock.packages['csstype']).toBeDefined()
    await expect(materializedManifests(repository, ['missing-build-dependency'])).rejects.toThrow(
      'Undeclared CLI build dependency'
    )
  })

  test('follows relative type imports, reexports, JSON, literal dynamic imports and require syntax without executing any module', async () => {
    await fixture(async (directory) => {
      await mkdir(join(directory, 'nested'))
      await writeFile(
        join(directory, 'entry.ts'),
        `
import type { Contract } from './contract'
export { value } from './nested/value.js'
export type Lazy = import('./contract').Contract
import fs = require('node:fs')
export { fs }
export const p: Contract = require('node:path')
export { default as config } from './config.json'
await import('./lazy.ts')
import 'external/example'
throw new Error('this source must never execute')
`
      )
      await writeFile(join(directory, 'contract.ts'), 'export type Contract = unknown\n')
      await writeFile(join(directory, 'nested/value.ts'), 'export const value = 42\n')
      await writeFile(join(directory, 'lazy.ts'), 'export * from "./nested/value"\n')
      await writeFile(join(directory, 'config.json'), '{"fixture":true}\n')
      expect(await cliSourceClosure(directory, 'entry.ts')).toEqual({
        files: ['config.json', 'contract.ts', 'entry.ts', 'lazy.ts', 'nested/value.ts'],
        external: ['external'],
      })
      await writeFile(join(directory, 'entry.ts'), 'await import(computedName)\n')
      await expect(cliSourceClosure(directory, 'entry.ts')).rejects.toThrow(
        'computed package import'
      )
      await writeFile(join(directory, 'entry.ts'), 'require(...args)\n')
      await expect(cliSourceClosure(directory, 'entry.ts')).rejects.toThrow(
        'computed package import'
      )
      await writeFile(join(directory, 'entry.ts'), 'import "./missing"\n')
      await expect(cliSourceClosure(directory, 'entry.ts')).rejects.toThrow(
        'Unresolved package source'
      )
      await writeFile(join(directory, 'entry.ts'), 'export const broken = )\n')
      await expect(cliSourceClosure(directory, 'entry.ts')).rejects.toThrow('Cannot inspect')
    })
  })

  test('rejects escaped source files and symlink/unsupported entries instead of silently omitting them', async () => {
    await fixture(async (directory) => {
      const root = join(directory, 'source')
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(directory, 'outside.ts'), 'export {}\n')
      await writeFile(join(root, 'entry.ts'), 'export * from "../outside.ts"\n')
      await expect(cliSourceClosure(root, 'entry.ts')).rejects.toThrow('escapes the checkout')
      await writeFile(join(root, 'src/notes.txt'), 'must not be silently lost')
      await expect(librarySourceFiles(root)).rejects.toThrow('Unsupported package source entry')
      await rm(join(root, 'src/notes.txt'))
      if (process.platform !== 'win32') {
        await symlink(join(directory, 'outside.ts'), join(root, 'src/link.ts'))
        await expect(librarySourceFiles(root)).rejects.toThrow('Unsupported package source entry')
      }
    })
  })
})
