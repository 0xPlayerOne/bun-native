import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageNames, type PackageManifest } from '../../scripts/native/package-set.ts'
import {
  main,
  publishOrder,
  registryManifest,
  repositoryUrl,
} from '../../scripts/registry-packages.ts'
import { packageFixture } from './package-fixture.ts'

const manifest = (name: string, dependencies?: Record<string, string>): PackageManifest => ({
  name,
  version: '0.0.0',
  private: true,
  type: 'module',
  license: 'MIT',
  files: ['src', 'LICENSE', 'README.md', 'bun-native-source.json'],
  engines: { bun: '1.4.4' },
  ...(dependencies ? { dependencies } : {}),
})

test('registry manifests are public, versioned together and carry provenance metadata', () => {
  const published = registryManifest(
    manifest('@bun-native/solid', { '@bun-native/core': '0.0.0', 'solid-js': '1.9.9' }),
    '0.33.0'
  )
  expect('private' in published).toBe(false)
  expect(published.version).toBe('0.33.0')
  expect(published.dependencies).toEqual({ '@bun-native/core': '0.33.0', 'solid-js': '1.9.9' })
  expect(published.repository).toEqual({
    type: 'git',
    url: repositoryUrl,
    directory: 'packages/solid',
  })
  expect(published.publishConfig).toEqual({ access: 'public', provenance: true })
  expect(published.engines).toEqual({ bun: '1.4.4' })
  expect(() => registryManifest(manifest('@other/x'), '1.0.0')).toThrow('Not a Bun Native')
  expect(() => registryManifest(manifest('@bun-native/core'), '1.0')).toThrow('x.y.z')
})

test('dependencies publish before their dependents', () => {
  const manifests = Object.fromEntries(
    packageNames.map((name) => [name, manifest(name)])
  ) as Record<string, PackageManifest>
  manifests['@bun-native/core'] = manifest('@bun-native/core', {
    '@bun-native/runtime': '0.0.0',
    '@bun-native/protocol': '0.0.0',
  })
  manifests['@bun-native/runtime'] = manifest('@bun-native/runtime', {
    '@bun-native/protocol': '0.0.0',
  })
  manifests['@bun-native/solid'] = manifest('@bun-native/solid', { '@bun-native/core': '0.0.0' })
  const order = publishOrder(manifests)
  expect(order).toHaveLength(packageNames.length)
  const at = (name: string) => order.indexOf(name)
  expect(at('@bun-native/protocol')).toBeLessThan(at('@bun-native/runtime'))
  expect(at('@bun-native/runtime')).toBeLessThan(at('@bun-native/core'))
  expect(at('@bun-native/core')).toBeLessThan(at('@bun-native/solid'))
  manifests['@bun-native/protocol'] = manifest('@bun-native/protocol', {
    '@bun-native/core': '0.0.0',
  })
  expect(() => publishOrder(manifests)).toThrow('dependency cycle')
})

test('a verified package set becomes publishable package directories in dependency order', async () => {
  await expect(main(['--package-set', 'relative.json'])).rejects.toThrow('Usage:')
  await packageFixture(async ({ directory, manifest }) => {
    const output = join(directory, 'registry')
    await main(['--package-set', manifest, '--outdir', output])
    const order = readFileSync(join(output, 'publish-order.txt'), 'utf8').trim().split('\n')
    expect([...order].sort()).toEqual(packageNames.map((name) => name.slice(12)).sort())
    const version = JSON.parse(
      readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')
    ).version
    for (const short of order) {
      const published = JSON.parse(readFileSync(join(output, short, 'package.json'), 'utf8'))
      expect(published.name).toBe(`@bun-native/${short}`)
      expect(published.version).toBe(version)
      expect(published.private).toBeUndefined()
      for (const [name, range] of Object.entries(published.dependencies ?? {}))
        if (name.startsWith('@bun-native/')) {
          expect(range).toBe(version)
          expect(order.indexOf(name.slice(12))).toBeLessThan(order.indexOf(short))
        }
      expect(readFileSync(join(output, short, 'README.md'), 'utf8')).toContain('npm provenance')
    }
    await expect(main(['--package-set', manifest, '--outdir', output])).rejects.toThrow()
  })
})
