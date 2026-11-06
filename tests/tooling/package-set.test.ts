import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createProject, readProject } from '../../scripts/native/project.ts'
import {
  parsePackageSet,
  readPackageSet,
  requiredPackages,
  verifyInstalledPackages,
} from '../../scripts/native/package-set.ts'
import { cliSourceClosure } from '../../scripts/native/package-source.ts'
import {
  dependencyClosure,
  lockedPackages,
  seedConsumerLock,
  verifyConsumerLock,
} from '../../scripts/native/package-lock.ts'
import { verifyPackageArchive } from '../../scripts/native/package-archive.ts'
import { fixtureDigest, fixtureJSON, installedFixture, packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')

describe('standalone package source contracts (inert fixtures; no install, app build or native execution)', () => {
  test('preserves exact nested lock records and rejects omitted, shifted or new tuples', async () => {
    const raw = Bun.JSONC.parse(await Bun.file(join(repository, 'bun.lock')).text())
    const lock = lockedPackages(raw)
    const subset = dependencyClosure(lock, {
      '@babel/core': '7.29.7',
      'babel-preset-solid': '1.9.16',
      '@types/bun': '1.4.4',
    })
    const nested = 'babel-plugin-jsx-dom-expressions/@babel/helper-module-imports'
    expect(subset.packages[nested]).toEqual(lock.packages[nested])
    expect(subset.packages[nested]![0]).toBe('@babel/helper-module-imports@7.18.6')
    expect(subset.packages['@babel/helper-module-imports']![0]).toBe(
      '@babel/helper-module-imports@7.29.7'
    )
    expect(Object.keys(subset.packages)).not.toContain('code-foundry')
    expect(subset.packages['debug']![2]['optionalPeers']).toEqual(['supports-color'])
    expect(subset.packages['supports-color']).toBeUndefined()
    const seeded = seedConsumerLock(subset, {
      name: 'example',
      dependencies: {},
      devDependencies: {},
    })
    expect(seeded.workspaces).toEqual({
      '': { name: 'example', dependencies: {}, devDependencies: {} },
    })
    verifyConsumerLock(seeded, subset)
    for (const mutation of ['missing', 'changed', 'additional']) {
      const invalid = structuredClone(seeded)
      if (mutation === 'missing') delete invalid.packages[nested]
      if (mutation === 'changed') invalid.packages[nested]![3] = 'sha512-dGFtcGVyZWQ='
      if (mutation === 'additional')
        invalid.packages['code-foundry'] = lock.packages['code-foundry']!
      expect(() => verifyConsumerLock(invalid, subset)).toThrow()
      if (mutation === 'additional') verifyConsumerLock(invalid, subset, true)
    }
    const shadow = structuredClone(seeded)
    shadow.packages['@babel/core/@babel/parser'] = structuredClone(lock.packages['@babel/parser']!)
    expect(() => verifyConsumerLock(shadow, subset, true)).toThrow('differs')
    const optionalPeer = structuredClone(seeded)
    optionalPeer.packages['supports-color'] = [
      'supports-color@1.0.0',
      '',
      {},
      'sha512-Zml4dHVyZQ==',
    ]
    expect(() => verifyConsumerLock(optionalPeer, subset, true)).toThrow('differs')
    expect(() => dependencyClosure(lock, { '@types/bun': '0.0.1' })).toThrow('does not pin')
    const missing = structuredClone(lock)
    delete missing.packages['@babel/parser']
    expect(() => dependencyClosure(missing, { '@babel/core': '7.29.7' })).toThrow(
      'Source lock is missing'
    )
    expect(() => lockedPackages(null)).toThrow()
    expect(() => lockedPackages({ ...lock, lockfileVersion: 99 })).toThrow(
      'pinned Bun dependency lock format'
    )
    expect(() => lockedPackages({ ...lock, packages: { bad: 'not a tuple' } })).toThrow(
      'Invalid locked package'
    )
    expect(() => lockedPackages({ ...lock, packages: { bad: ['bad@git:somewhere'] } })).toThrow(
      'integrity-bound'
    )
    expect(() => lockedPackages({ ...lock, packages: { bad: ['bad@file:outside'] } })).toThrow(
      'Unexpected local dependency'
    )
  })

  test('validates complete archive/file inventories without extracting their paths', async () => {
    await packageFixture(async ({ directory, manifest, set }) => {
      const read = await readPackageSet(manifest)
      expect(read.manifest).toEqual(set)
      for (const pkg of Object.values(set.packages))
        await verifyPackageArchive(join(read.directory, pkg.archive.file), pkg.files)
      const path = join(directory, 'wrong.tgz')
      await Bun.Archive.write(
        path,
        { 'package/../outside.ts': 'not extracted' },
        { compress: 'gzip' }
      )
      await expect(
        verifyPackageArchive(path, { 'src/index.ts': fixtureDigest('expected') })
      ).rejects.toThrow('inventory')
      await Bun.Archive.write(path, { 'package/src/index.ts': 'wrong bytes' }, { compress: 'gzip' })
      await expect(
        verifyPackageArchive(path, { 'src/index.ts': fixtureDigest('expected') })
      ).rejects.toThrow('digest mismatch')
      expect(existsSync(join(directory, 'outside.ts'))).toBe(false)
    })
  })

  test('rejects malformed manifests, duplicate archive paths, missing exports and unresolved workspace edges', async () => {
    await packageFixture(async ({ manifest, set }) => {
      const changed = (mutate: (value: typeof set) => void) => {
        const copy = structuredClone(set)
        mutate(copy)
        expect(() => parsePackageSet(copy)).toThrow()
      }
      expect(() => parsePackageSet(null)).toThrow('package-set object')
      expect(() => parsePackageSet({ ...set, surprise: true })).toThrow('fields')
      changed((value) => {
        value.source.commit = 'not a commit'
      })
      changed((value) => {
        value.toolchain.bun.revision = '0'.repeat(40)
      })
      changed((value) => {
        value.compiler.revision = '0'.repeat(40)
      })
      changed((value) => {
        value.source.files['../outside'] = fixtureDigest('x')
      })
      changed((value) => {
        value.packages['@bun-native/core']!.files['src/index.ts']!.sha256 = 'invalid'
      })
      changed((value) => {
        value.packages['@bun-native/core']!.archive.file = '../outside.tgz'
      })
      changed((value) => {
        value.packages['@bun-native/core']!.archive.file =
          value.packages['@bun-native/cli']!.archive.file
      })
      changed((value) => {
        delete value.packages['@bun-native/core']!.files['src/index.ts']
      })
      changed((value) => {
        value.packages['@bun-native/core']!.manifest.version = 'workspace:*'
      })
      changed((value) => {
        value.packages['@bun-native/core']!.manifest.dependencies!['@bun-native/runtime'] = '9.0.0'
      })
      changed((value) => {
        delete value.packages['@bun-native/react']
      })
      changed((value) => {
        value.consumers.react.dependencies['react'] = '0.0.0'
      })
      await writeFile(manifest, '{"schemaVersion":1,' + fixtureJSON(set).slice(1))
      await expect(readPackageSet(manifest)).rejects.toThrow('original canonical JSON')
    })
  })

  test('fails before destination creation on changed, missing and symlink-escaped archives', async () => {
    await packageFixture(async ({ directory, manifest, set }) => {
      const destination = join(directory, 'never created')
      const archive = join(directory, 'set', set.packages['@bun-native/core']!.archive.file)
      const original = await readFile(archive)
      await writeFile(archive, 'changed archive bytes')
      await expect(
        createProject(repository, destination, 'solid', 'typescript', manifest)
      ).rejects.toThrow('archive digest mismatch')
      expect(existsSync(destination)).toBe(false)
      await rm(archive)
      await expect(
        createProject(repository, destination, 'solid', 'typescript', manifest)
      ).rejects.toThrow()
      expect(existsSync(destination)).toBe(false)
      if (process.platform !== 'win32') {
        const outside = join(directory, 'outside.tgz')
        await writeFile(outside, original)
        await symlink(outside, archive)
        await expect(readPackageSet(manifest)).rejects.toThrow('escapes its owned directory')
      }
    })
  })

  test('inherited object properties cannot satisfy exports or erase dependency roots', async () => {
    await packageFixture(async ({ set }) => {
      for (const missing of ['toString', 'constructor']) {
        const invalid = structuredClone(set)
        const pkg = invalid.packages['@bun-native/core']!
        pkg.manifest.exports = './' + missing
        pkg.files['package.json'] = fixtureDigest(fixtureJSON(pkg.manifest))
        expect(() => {
          parsePackageSet(invalid)
        }).toThrow('Unpackaged exports target')
      }
      const missingDependency = structuredClone(set)
      missingDependency.consumers.solid.dependencies = {
        ...missingDependency.consumers.solid.dependencies,
        ['__proto__']: '1.0.0',
      }
      expect(() => parsePackageSet(missingDependency)).toThrow(
        'Source lock does not pin __proto__@1.0.0'
      )
    })
  })

  test('creates all four standalone configurations and resolves only their selected inert installed closure after relocation', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      for (const framework of ['solid', 'react'] as const)
        for (const language of ['typescript', 'javascript'] as const) {
          const project = join(directory, framework + '-' + language)
          await createProject(repository, project, framework, language, manifest)
          const config = await Bun.file(join(project, 'tsconfig.json')).json()
          expect(config.extends).toBeUndefined()
          expect(config.compilerOptions).toMatchObject({
            moduleResolution: 'Bundler',
            noEmit: true,
            allowImportingTsExtensions: true,
            allowJs: true,
            checkJs: true,
            strict: true,
            types: ['bun'],
            jsx: 'preserve',
            jsxImportSource: `@bun-native/${framework}`,
          })
          const pkg = await Bun.file(join(project, 'package.json')).json()
          expect(pkg.scripts.dev).toContain('./node_modules/@bun-native/cli/src/scripts/native.ts')
          expect(pkg.scripts.dev).toStartWith('MIMALLOC_PURGE_DELAY=0 bun --no-install ')
          expect(pkg.scripts.build).not.toContain('MIMALLOC')
          expect(pkg.dependencies[framework === 'solid' ? 'solid-js' : 'react']).toBe(
            framework === 'solid' ? '1.9.18' : '19.3.1'
          )
          expect(pkg.devDependencies['@types/bun']).toBe('1.4.4')
          if (framework === 'react')
            expect(pkg.devDependencies).toMatchObject({
              '@types/react': '19.3.0',
              '@types/react-reconciler': '0.34.1',
            })
          expect(fixtureJSON(pkg)).not.toContain('workspace:')
          expect(fixtureJSON(pkg)).not.toContain(repository)
          expect(fixtureJSON(pkg)).not.toContain(directory)
          expect(Object.keys(pkg.overrides).sort()).toEqual(requiredPackages(set, framework))
          expect(existsSync(join(project, 'node_modules'))).toBe(false)
          await expect(readProject(repository, project)).rejects.toThrow()
          const relocated = join(directory, 'moved with spaces', framework + '-' + language)
          await mkdir(dirname(relocated), { recursive: true })
          await rename(project, relocated)
          await installedFixture(relocated, set, framework, contents)
          const read = await readProject(repository, relocated)
          expect(read.directory).toBe(relocated)
          expect(read.entry).toBe(
            join(relocated, language === 'typescript' ? 'main.tsx' : 'main.jsx')
          )
          expect(read.packageSet?.source).toEqual({
            commit: set.source.commit,
            tree: set.source.tree,
          })
          expect(
            existsSync(
              join(
                relocated,
                'node_modules',
                framework === 'solid' ? '@bun-native/react' : '@bun-native/solid'
              )
            )
          ).toBe(false)
          const original = await readFile(read.entry)
          await expect(
            createProject(repository, relocated, framework, language, manifest)
          ).rejects.toThrow()
          expect(await readFile(read.entry)).toEqual(original)
        }
    })
  })

  test('rejects entry/manifest escapes and changed or externally linked installed packages', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      const project = join(directory, 'project')
      await createProject(repository, project, 'solid', 'typescript', manifest)
      await installedFixture(project, set, 'solid', contents)
      const configFile = join(project, 'bun-native.json')
      const config = await Bun.file(configFile).json()
      await writeFile(join(directory, 'outside.ts'), 'export {}\n')
      await writeFile(configFile, fixtureJSON({ ...config, entry: '../outside.ts' }))
      await expect(readProject(repository, project)).rejects.toThrow('inside the project')
      await writeFile(configFile, fixtureJSON({ ...config, packageSet: '../set/manifest.json' }))
      await expect(readProject(repository, project)).rejects.toThrow('outside the project')
      await writeFile(configFile, fixtureJSON({ ...config, packageSet: manifest }))
      await expect(readProject(repository, project)).rejects.toThrow('relative manifest path')
      await writeFile(configFile, fixtureJSON(config))
      const source = join(project, 'node_modules/@bun-native/core/src/index.ts')
      await writeFile(source, 'changed installed source\n')
      await expect(readProject(repository, project)).rejects.toThrow(
        'Installed package digest mismatch'
      )
      await writeFile(source, contents['@bun-native/core']!['src/index.ts']!)
      await verifyInstalledPackages(project, set, 'solid')
      const shadow = join(project, 'node_modules/@bun-native/core/src/index.js')
      await writeFile(shadow, 'throw new Error("unlisted shadow module")\n')
      await expect(readProject(repository, project)).rejects.toThrow('file inventory differs')
      await rm(shadow)
      if (process.platform !== 'win32') {
        const modules = join(project, 'node_modules')
        const outside = join(directory, 'outside-modules')
        await rename(modules, outside)
        await symlink(outside, modules, 'dir')
        await expect(readProject(repository, project)).rejects.toThrow(
          'must belong to this consumer'
        )
        await rm(modules)
        await rename(outside, modules)
        const core = join(modules, '@bun-native/core')
        const escaped = join(directory, 'outside-core')
        await rename(core, escaped)
        await symlink(escaped, core, 'dir')
        await expect(readProject(repository, project)).rejects.toThrow('outside this consumer')
      }
    })
  })

  test('the copied existing CLI bootstraps without Babel and rejects installed tampering before its lazy compiler import', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      const closure = await cliSourceClosure(repository)
      const bootstrap = join(directory, 'bootstrap')
      for (const path of closure.files) {
        const target = join(bootstrap, path)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(repository, path), target)
      }
      const cli = join(bootstrap, 'scripts/native.ts')
      const project = join(directory, 'created by cli')
      const env = { ...process.env }
      delete env['NODE_PATH']
      delete env['BUN_INSTALL']
      const run = (args: string[]) =>
        Bun.spawnSync([process.execPath, '--no-install', cli, ...args], {
          cwd: directory,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        })
      const created = run(['create', project, '--packages', manifest])
      expect(created.exitCode).toBe(0)
      expect(created.stderr.toString()).toBe('')
      expect(created.stdout.toString()).toContain(
        'Follow the generated README to install the pinned dependencies'
      )
      expect(existsSync(join(bootstrap, 'node_modules'))).toBe(false)
      expect(existsSync(join(project, 'node_modules'))).toBe(false)
      await installedFixture(project, set, 'solid', contents)
      await writeFile(
        join(project, 'node_modules/@bun-native/core/src/index.ts'),
        'tampered inert source'
      )
      const rejected = run([
        'build',
        project,
        '--host',
        process.execPath,
        '--host-profile',
        'release',
      ])
      expect(rejected.exitCode).toBe(1)
      expect(rejected.stderr.toString()).toContain('Installed package digest mismatch')
      expect(rejected.stderr.toString()).not.toContain('Cannot find package')
      expect(existsSync(join(project, '.bun-native'))).toBe(false)
      expect(existsSync(join(project, 'dist'))).toBe(false)
    })
  })
})
