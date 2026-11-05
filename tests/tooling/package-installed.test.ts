import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  consumerArchiveLock,
  parsePackageSet,
  verifyInstalledPackages,
} from '../../scripts/native/package-set.ts'
import { seedConsumerLock } from '../../scripts/native/package-lock.ts'
import { verifyPackageArchive } from '../../scripts/native/package-archive.ts'
import { packageArchivePath } from '../../scripts/native/paths.ts'
import { fixtureDigest, fixtureJSON, installedFixture, packageFixture } from './package-fixture.ts'
import recorded from '../fixtures/standalone-installer-tag.json'

describe('installed source metadata (inert files; no package manager or module execution)', () => {
  test('requires the observed pinned tag independently of canonical lock integrity', async () => {
    expect(fixtureDigest(recorded.tag.text)).toEqual({
      bytes: recorded.tag.bytes,
      sha256: recorded.tag.sha256,
    })
    expect(recorded.tag.bytes).toBe(52)
    expect(Buffer.byteLength(recorded.canonical_lock_sri)).toBe(51)
    expect(recorded.tag.text).toBe(recorded.canonical_lock_sri + '=')
    for (const framework of ['solid', 'react'] as const)
      await packageFixture(async ({ directory, set, contents }) => {
        const project = join(directory, 'consumer')
        await mkdir(project)
        const consumer = set.consumers[framework]
        const local = consumerArchiveLock(set, framework)
        await writeFile(
          join(project, 'bun.lock'),
          fixtureJSON(
            seedConsumerLock(
              consumer.lock,
              {
                name: 'inert',
                dependencies: consumer.dependencies,
                devDependencies: consumer.devDependencies,
              },
              local
            )
          )
        )
        await installedFixture(project, set, framework, contents)
        await verifyInstalledPackages(project, set, framework)
        for (const name of Object.keys(local.packages)) {
          const tag = await readFile(join(project, 'node_modules', name, '.bun-tag'), 'utf8')
          expect(tag).toHaveLength(52)
          expect(tag).toBe(local.packages[name]![2] + '=')
          expect(Object.hasOwn(set.packages[name]!.files, '.bun-tag')).toBe(false)
        }
      })
  })

  test('rejects missing, canonical, padded, changed and nonregular tags and every extra entry', async () => {
    await packageFixture(async ({ directory, set, contents }) => {
      const project = join(directory, 'consumer')
      await mkdir(project)
      const consumer = set.consumers.solid
      await writeFile(
        join(project, 'bun.lock'),
        fixtureJSON(
          seedConsumerLock(
            consumer.lock,
            {
              name: 'inert',
              dependencies: consumer.dependencies,
              devDependencies: consumer.devDependencies,
            },
            consumerArchiveLock(set, 'solid')
          )
        )
      )
      await installedFixture(project, set, 'solid', contents)
      const cli = join(project, 'node_modules/@bun-native/cli')
      const marker = join(cli, '.bun-tag')
      const correct = await readFile(marker, 'utf8')
      await rm(marker)
      await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
        'inventory differs'
      )
      for (const invalid of [
        correct.slice(0, -1),
        correct + '=',
        correct + '\n',
        'sha256-' + 'A'.repeat(43) + '==',
      ]) {
        await writeFile(marker, invalid)
        await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
          'digest mismatch'
        )
      }
      await rm(marker)
      await mkdir(marker)
      await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
        'inventory differs'
      )
      await rm(marker, { recursive: true })
      if (process.platform !== 'win32') {
        const target = join(directory, 'correct-tag-outside-package')
        await writeFile(target, correct)
        await symlink(target, marker)
        await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
          'inventory differs'
        )
        await rm(marker)
      }
      await writeFile(marker, correct)
      for (const extra of ['unexpected.txt', 'src/.bun-tag']) {
        const path = join(cli, extra)
        await writeFile(path, correct)
        await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
          'inventory differs'
        )
        await rm(path)
      }
      const extraDirectory = join(cli, 'unexpected-empty-directory')
      await mkdir(extraDirectory)
      await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
        'inventory differs'
      )
      await rm(extraDirectory, { recursive: true })
      const source = join(project, 'node_modules/@bun-native/core/src/index.ts')
      await writeFile(source, 'changed inert source; never executed\n')
      await expect(verifyInstalledPackages(project, set, 'solid')).rejects.toThrow(
        'digest mismatch'
      )
      await writeFile(source, contents['@bun-native/core']!['src/index.ts']!)
      await verifyInstalledPackages(project, set, 'solid')
    })
  })

  test('reserves the installer name at every archive depth for all seven packages', async () => {
    const paths = ['.bun-tag', 'src/.bun-tag', '.bun-tag/child.ts', 'src/.bun-tag/child.ts']
    await packageFixture(async ({ directory, set }) => {
      for (const [name, pkg] of Object.entries(set.packages))
        for (const path of paths) {
          expect(packageArchivePath(path)).toBe(false)
          const invalid = structuredClone(set)
          invalid.packages[name]!.files[path] = fixtureDigest(recorded.tag.text)
          expect(() => parsePackageSet(invalid)).toThrow('reserved installer metadata')
          // This is the exact archive validator called by the real producer for
          // every package, supplied a malformed inventory without invoking pack.
          await expect(
            verifyPackageArchive(
              join(directory, 'set', pkg.archive.file),
              invalid.packages[name]!.files
            )
          ).rejects.toThrow('Invalid expected package archive inventory')
        }
      for (const path of paths) {
        const filename = join(directory, 'reserved.tgz')
        await Bun.Archive.write(
          filename,
          { 'package/index.ts': 'export {}\n', [`package/${path}`]: recorded.tag.text },
          { compress: 'gzip' }
        )
        await expect(
          verifyPackageArchive(filename, { 'index.ts': fixtureDigest('export {}\n') })
        ).rejects.toThrow()
        const invalid = structuredClone(set)
        const pkg = invalid.packages['@bun-native/cli']!
        pkg.manifest.files.push(path)
        pkg.files['package.json'] = fixtureDigest(fixtureJSON(pkg.manifest))
        expect(() => parsePackageSet(invalid)).toThrow('Invalid materialized package manifest')
      }
      expect(packageArchivePath('src/bun-tag.ts')).toBe(true)
    })
  })
})
