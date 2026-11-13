import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { installedFixture, packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
const stamped = { verification: 'stamp' } as const

/**
 * Rewrite a file with same-length bytes and restore its exact timestamps, as a
 * careless tool might. Only the inode change time can still reveal the write.
 */
async function sameSizeEdit(path: string): Promise<void> {
  const reference = `${path}.times`
  const touch = (from: string, to: string) =>
    expect(Bun.spawnSync(['touch', '-r', from, to]).exitCode).toBe(0)
  await writeFile(reference, '')
  if (process.platform !== 'win32') touch(path, reference)
  const before = await stat(path, { bigint: true })
  const bytes = await readFile(path)
  bytes[0] = bytes[0] === 0x20 ? 0x21 : 0x20
  await writeFile(path, bytes)
  if (process.platform === 'win32') await utimes(path, before.atime, before.mtime)
  else {
    touch(reference, path)
    expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
  }
  await rm(reference)
}

/** Mark the stamp so a hit is observable: only a stamp hit can report this commit. */
async function markStamp(project: string): Promise<void> {
  const file = join(project, '.bun-native/verified.json')
  const stamp = await Bun.file(file).json()
  stamp.source.commit = 'stamp-hit'
  await writeFile(file, JSON.stringify(stamp))
}

const hit = async (project: string) =>
  (await readProject(repository, project, stamped)).packageSet?.source.commit === 'stamp-hit'

describe('standalone verification stamp (inert installed package fixture)', () => {
  test('light commands reuse a stamp; build-style reads and every change re-verify fully', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      const project = join(directory, 'project')
      await createProject(repository, project, 'solid', 'typescript', manifest)
      await installedFixture(project, set, 'solid', contents)
      const full = await readProject(repository, project)
      expect(existsSync(join(project, '.bun-native/verified.json'))).toBe(false)
      const first = await readProject(repository, project, stamped)
      expect(first).toEqual(full)
      expect(existsSync(join(project, '.bun-native/verified.json'))).toBe(true)
      await markStamp(project)
      expect(await hit(project)).toBe(true)
      // Full verification never consults the stamp.
      expect((await readProject(repository, project)).packageSet?.source.commit).toBe(
        set.source.commit
      )

      const core = join(project, 'node_modules/@bun-native/core')
      const source = join(core, 'src/index.ts')
      await sameSizeEdit(source)
      await expect(readProject(repository, project, stamped)).rejects.toThrow(
        'Installed package digest mismatch'
      )
      await writeFile(source, contents['@bun-native/core']!['src/index.ts']!)
      await readProject(repository, project, stamped)
      await markStamp(project)

      const shadow = join(core, 'src/index.js')
      await writeFile(shadow, 'throw new Error("unlisted")\n')
      await expect(readProject(repository, project, stamped)).rejects.toThrow(
        'file inventory differs'
      )
      await rm(shadow)
      await readProject(repository, project, stamped)
      await markStamp(project)

      // A nested node_modules could shadow an internal dependency.
      await mkdir(join(project, 'node_modules/@bun-native/node_modules'))
      expect(await hit(project)).toBe(false)
      await rm(join(project, 'node_modules/@bun-native/node_modules'), { recursive: true })
      await readProject(repository, project, stamped)
      await markStamp(project)

      const archive = join(
        project,
        'vendor/bun-native',
        set.packages['@bun-native/core']!.archive.file
      )
      await sameSizeEdit(archive)
      await expect(readProject(repository, project, stamped)).rejects.toThrow(
        'Package archive digest mismatch'
      )
      await writeFile(
        archive,
        await readFile(join(directory, 'set', set.packages['@bun-native/core']!.archive.file))
      )
      await readProject(repository, project, stamped)
      await markStamp(project)

      const lock = join(project, 'bun.lock')
      const locked = await readFile(lock)
      await writeFile(lock, locked)
      expect(await hit(project)).toBe(false)
      await markStamp(project)

      const manifestFile = join(project, 'vendor/bun-native/manifest.json')
      await sameSizeEdit(manifestFile)
      await expect(readProject(repository, project, stamped)).rejects.toThrow()
      await writeFile(manifestFile, await readFile(manifest))
      await readProject(repository, project, stamped)
      await markStamp(project)

      if (process.platform !== 'win32') {
        const escaped = join(directory, 'outside-core')
        await rename(core, escaped)
        await symlink(escaped, core, 'dir')
        await expect(readProject(repository, project, stamped)).rejects.toThrow(
          'outside this consumer'
        )
        await rm(core)
        await rename(escaped, core)
      }
      await readProject(repository, project, stamped)
      await markStamp(project)

      // A stamp for another framework, a corrupt stamp or a missing one is a miss.
      const file = join(project, '.bun-native/verified.json')
      const stamp = await Bun.file(file).json()
      await writeFile(file, JSON.stringify({ ...stamp, framework: 'react' }))
      expect(await hit(project)).toBe(false)
      await writeFile(file, '{not json')
      expect(await hit(project)).toBe(false)
      await rm(file)
      expect(await hit(project)).toBe(false)
    })
  }, 60_000)

  test('a project that cannot hold a stamp still verifies fully every time', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      const project = join(directory, 'project')
      await createProject(repository, project, 'react', 'javascript', manifest)
      await installedFixture(project, set, 'react', contents)
      await writeFile(join(project, '.bun-native'), 'not a directory')
      const read = await readProject(repository, project, stamped)
      expect(read.packageSet?.source.commit).toBe(set.source.commit)
      expect(await readFile(join(project, '.bun-native'), 'utf8')).toBe('not a directory')
    })
  })
})
