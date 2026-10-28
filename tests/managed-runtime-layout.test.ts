import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DevelopmentError, prepareDevelopmentHost } from '../packages/cli/src/dev-cache.ts'
import { prepareManagedRuntimeLayout } from '../scripts/qualify-managed-development.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

test('cold Linux layout prevents first-launch cache drift while later extension writes still reject reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-layout-'))
  try {
    const selected = join(root, 'selected-host')
    await writeFile(selected, 'selected-host')
    const assemblies = { incomplete: 0, complete: 0 }
    const prepare = (layout: keyof typeof assemblies) =>
      prepareDevelopmentHost({
        cacheRoot: join(root, layout),
        identity: {
          appId: 'test.managed-layout',
          nativeAbi: '1',
          engineVersion: 'cef:156.0.7',
          target: 'linux-x64',
          bunVersion: Bun.version,
          configuration: '{}',
          inputs: [{ name: 'host', path: selected, sha256: sha('selected-host') }],
        },
        assemble: async (stage) => {
          assemblies[layout]++
          const app = join(stage, 'Managed Development')
          await mkdir(app)
          await writeFile(join(app, 'host'), 'selected-host')
          if (layout === 'complete') await prepareManagedRuntimeLayout(app, 'linux')
          return { entrypoint: 'Managed Development/host' }
        },
      })

    // Negative control reproduces the hosted failure: the path-provider creates
    // its static empty directory only after the immutable receipt was published.
    const incomplete = await prepare('incomplete')
    await mkdir(join(dirname(incomplete.entrypoint), 'extensions'), { recursive: true })
    await expect(prepare('incomplete')).rejects.toMatchObject({
      code: 'CACHE_INTEGRITY',
      cacheIntegrity: {
        difference: {
          added: ['Managed Development/extensions'],
          removed: [],
          changed: [],
          entryOrderChanged: false,
        },
      },
    })

    const complete = await prepare('complete')
    const extensions = join(dirname(complete.entrypoint), 'extensions')
    const receiptPath = join(complete.directory, 'bunly-dev-host.json')
    const receipt = await readFile(receiptPath, 'utf8')
    expect(JSON.parse(receipt).files).toContainEqual({
      path: 'Managed Development/extensions',
      kind: 'directory',
      mode: process.platform === 'win32' ? 0 : 0o700,
      bytes: 0,
      sha256: sha(''),
    })
    // Equivalent to the pinned path provider's ensure-directory operation. This
    // portable test does not represent an executed CEF launch.
    await mkdir(extensions, { recursive: true })
    const warm = await prepare('complete')
    expect(warm.cacheHit).toBe(true)
    expect(warm.entrypoint).toBe(complete.entrypoint)
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)

    await writeFile(join(extensions, 'unexpected.json'), '{}')
    await expect(prepare('complete')).rejects.toBeInstanceOf(DevelopmentError)
    await expect(prepare('complete')).rejects.toMatchObject({
      code: 'CACHE_INTEGRITY',
      cacheIntegrity: {
        difference: {
          added: ['Managed Development/extensions/unexpected.json'],
          removed: [],
          changed: [],
          entryOrderChanged: false,
        },
      },
    })
    expect(await readFile(join(extensions, 'unexpected.json'), 'utf8')).toBe('{}')
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
    expect(assemblies).toEqual({ incomplete: 1, complete: 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Linux layout preserves an existing empty directory and rejects unexpected contents without deleting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-layout-existing-'))
  try {
    const extensions = join(root, 'extensions')
    await mkdir(extensions, { mode: 0o750 })
    const before = await lstat(extensions)
    await prepareManagedRuntimeLayout(root, 'linux')
    const after = await lstat(extensions)
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
    expect(await readdir(extensions)).toEqual([])
    await writeFile(join(extensions, 'unexpected.json'), '{}')
    await expect(prepareManagedRuntimeLayout(root, 'linux')).rejects.toThrow(
      'Static extensions directory must be empty'
    )
    expect(await readFile(join(extensions, 'unexpected.json'), 'utf8')).toBe('{}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'Linux layout rejects a symlink without writing through it',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-managed-layout-link-'))
    try {
      const app = join(root, 'app'),
        outside = join(root, 'outside')
      await mkdir(app)
      await mkdir(outside)
      await symlink(outside, join(app, 'extensions'))
      await expect(prepareManagedRuntimeLayout(app, 'linux')).rejects.toThrow(
        'Invalid static extensions directory'
      )
      expect(await readdir(outside)).toEqual([])
      expect((await lstat(join(app, 'extensions'))).isSymbolicLink()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test.each(['darwin', 'win32'] as const)(
  'static Linux layout does not modify %s runtimes',
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-managed-layout-target-'))
    try {
      await writeFile(join(root, 'host'), 'selected-host')
      await prepareManagedRuntimeLayout(root, platform)
      expect(await readdir(root)).toEqual(['host'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
