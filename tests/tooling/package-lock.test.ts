import { describe, expect, test } from 'bun:test'
import {
  localArchiveLock,
  lockedPackages,
  seedConsumerLock,
  verifyConsumerLock,
} from '../../scripts/native/package-lock.ts'
import { consumerArchiveLock, requiredPackages } from '../../scripts/native/package-set.ts'
import { standaloneFiles } from '../../scripts/native/standalone.ts'
import { fixtureJSON, packageFixture } from './package-fixture.ts'

describe('complete standalone locks (inert metadata; no package manager)', () => {
  test('seeds both complete local closures while preserving every registry tuple and nested version', async () => {
    await packageFixture(async ({ directory, set }) => {
      for (const framework of ['solid', 'react'] as const) {
        const files = standaloneFiles(
          { directory, manifest: set, text: fixtureJSON(set) },
          framework,
          'main.tsx',
          'inert'
        )
        const manifest = JSON.parse(files['package.json']!)
        const seed = JSON.parse(files['bun.lock']!)
        const local = consumerArchiveLock(set, framework)
        expect(Object.keys(local.packages)).toEqual(requiredPackages(set, framework))
        expect(Object.keys(local.packages)).toHaveLength(6)
        expect(seed.overrides).toEqual(manifest.overrides)
        expect(lockedPackages(seed, local)).toEqual(set.consumers[framework].lock)
        // Only Solid projects lock the Babel tree, through @bun-native/solid/build.
        if (framework === 'solid')
          expect(
            seed.packages['babel-plugin-jsx-dom-expressions/@babel/helper-module-imports'][0]
          ).toBe('@babel/helper-module-imports@7.18.6')
        else expect(Object.keys(seed.packages).filter((name) => /babel/.test(name))).toEqual([])
        for (const [name, tuple] of Object.entries(local.packages)) {
          const pkg = set.packages[name]!
          expect(tuple[0]).toBe(`${name}@vendor/bun-native/${pkg.archive.file}`)
          expect(tuple[0]).not.toContain('@file:')
          expect(tuple[1]).toEqual({
            ...(pkg.manifest.dependencies ? { dependencies: pkg.manifest.dependencies } : {}),
            ...(pkg.manifest.bin ? { bin: pkg.manifest.bin } : {}),
          })
          expect(tuple[2]).toBe(
            `sha256-${Buffer.from(pkg.archive.sha256, 'hex').toString('base64')}`
          )
          expect(seed.overrides[name]).toBe(`file:vendor/bun-native/${pkg.archive.file}`)
        }
        expect(local.packages['@bun-native/protocol']![1]).toEqual({})
        expect(local.packages['@bun-native/cli']![1].bin).toEqual({
          'bun-native': './src/scripts/native.ts',
        })
        verifyConsumerLock(seed, set.consumers[framework].lock, false, local)
        expect(() =>
          seedConsumerLock(set.consumers[framework].lock, {
            name: manifest.name,
            dependencies: manifest.dependencies,
            devDependencies: manifest.devDependencies,
          })
        ).toThrow('Consumer lock is missing a root package')
      }
    })
  })

  test('rejects missing, altered, extra or shadowed local records and every changed override form', async () => {
    await packageFixture(async ({ directory, set }) => {
      const files = standaloneFiles(
        { directory, manifest: set, text: fixtureJSON(set) },
        'solid',
        'main.tsx',
        'inert'
      )
      const seed = JSON.parse(files['bun.lock']!)
      const local = consumerArchiveLock(set, 'solid')
      const verify = (value: unknown) =>
        verifyConsumerLock(value, set.consumers.solid.lock, true, local)
      for (const name of Object.keys(local.packages)) {
        const missing = structuredClone(seed)
        delete missing.packages[name]
        expect(() => verify(missing)).toThrow('local archive lock differs')
      }
      for (const change of [
        'path',
        'file-prefix',
        'integrity',
        'dependencies',
        'bin',
        'extra',
        'nested',
      ]) {
        const changed = structuredClone(seed)
        const row = changed.packages['@bun-native/cli']
        if (change === 'path') row[0] += '.changed'
        if (change === 'file-prefix') row[0] = row[0].replace('@vendor/', '@file:vendor/')
        if (change === 'integrity') row[2] = 'sha256-' + Buffer.alloc(32).toString('base64')
        if (change === 'dependencies') delete row[1].dependencies['oxlint']
        if (change === 'bin') row[1].bin['bun-native'] = './wrong.ts'
        if (change === 'extra')
          changed.packages['@bun-native/unexpected'] = [
            '@bun-native/unexpected@vendor/unexpected.tgz',
            {},
            row[2],
          ]
        if (change === 'nested')
          changed.packages['@bun-native/cli/oxlint'] = changed.packages['oxlint']
        expect(() => verify(changed)).toThrow()
      }
      for (const change of ['missing', 'path', 'selector', 'local-selector', 'parent']) {
        const changed = structuredClone(seed)
        if (change === 'missing') delete changed.overrides['@bun-native/core']
        if (change === 'path') changed.overrides['@bun-native/core'] = 'file:other.tgz'
        if (change === 'selector') changed.overrides['@babel/core@7.29.7'] = '7.29.7'
        if (change === 'local-selector')
          changed.overrides['@bun-native/core@0.0.0'] = changed.overrides['@bun-native/core']
        if (change === 'parent') changed.overrides['parent'] = { '@babel/core': '7.29.7' }
        expect(() => verify(changed)).toThrow('archive overrides differ')
      }
      const unrelated = structuredClone(seed)
      unrelated.packages['unrelated'] = ['unrelated@1.0.0', '', {}, 'sha512-Zml4dHVyZQ==']
      verify(unrelated)
      expect(() => verifyConsumerLock(unrelated, set.consumers.solid.lock, false, local)).toThrow(
        'differs'
      )
    })
  })

  test('supports a contained root manifest without inventing an absolute archive path', async () => {
    await packageFixture(async ({ set }) => {
      const local = consumerArchiveLock(set, 'solid', '')
      for (const [name, row] of Object.entries(local.packages))
        expect(row[0]).toBe(`${name}@${set.packages[name]!.archive.file}`)
      expect(() => consumerArchiveLock(set, 'solid', '../escape')).toThrow('Invalid or duplicate')
      const archive = { name: '@bun-native/core', file: 'vendor/core.tgz', sha256: 'a'.repeat(64) }
      expect(() => localArchiveLock([archive, archive])).toThrow('duplicate')
      expect(() => localArchiveLock([{ ...archive, sha256: 'invalid' }])).toThrow('Invalid')
    })
  })
})
