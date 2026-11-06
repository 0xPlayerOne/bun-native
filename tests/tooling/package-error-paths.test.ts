import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import recorded from '../fixtures/package-archive-duplicate.json'
import { verifyPackageArchive } from '../../scripts/native/package-archive.ts'
import { dependencyClosure, type DependencyLock } from '../../scripts/native/package-lock.ts'
import {
  parsePackageSet,
  requiredPackages,
  verifyInstalledPackages,
} from '../../scripts/native/package-set.ts'
import { materializedManifests } from '../../scripts/native/package-source.ts'
import { createProject } from '../../scripts/native/project.ts'
import { fixtureDigest, fixtureJSON, installedFixture, packageFixture } from './package-fixture.ts'

const repository = resolve(import.meta.dir, '../..')
const integrity = 'sha512-Zml4dHVyZQ=='

async function temporary(exercise: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-package-errors-'))
  try {
    await exercise(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('raw package tar header bounds (independent USTAR fixture)', () => {
  const first = Buffer.from(gunzipSync(Buffer.from(recorded.archive.base64, 'base64'))).subarray(
    0,
    1024
  )
  const expected = { 'index.ts': fixtureDigest('first entry\n') }
  const checksummed = (header: Buffer) => {
    header.fill(32, 148, 156)
    const sum = header.subarray(0, 512).reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    return header
  }
  const member = (mutate: (header: Buffer) => void) => {
    const copy = Buffer.from(first)
    mutate(copy)
    return Buffer.concat([checksummed(copy), Buffer.alloc(1024)])
  }

  test('rejects nonzero text padding, foreign formats, oversized members and inventories', async () => {
    await temporary(async (directory) => {
      const path = join(directory, 'input.tgz')
      const verify = async (raw: Buffer, inventory: typeof expected = expected) => {
        await writeFile(path, gzipSync(raw))
        await verifyPackageArchive(path, inventory)
      }
      await verify(member(() => {}))
      await expect(
        verify(
          member((header) => {
            header.fill(0, 0, 100)
            header.write('package/index.ts\0hidden', 0, 'latin1')
          })
        )
      ).rejects.toThrow('Invalid package tar text padding')
      await expect(
        verify(
          member((header) => {
            header.write('posix\0', 257, 'latin1')
          })
        )
      ).rejects.toThrow('supported USTAR format')
      await expect(
        verify(
          member((header) => {
            header.write('00000100000\0', 124, 'latin1')
          })
        )
      ).rejects.toThrow('Truncated package tar member')
      await expect(
        verify(
          member(() => {}),
          {
            'index.ts': { bytes: 70 * 1024 * 1024, sha256: expected['index.ts'].sha256 },
          }
        )
      ).rejects.toThrow('bounded source-package inspection limit')
    })
  })
})

describe('dependency closure locators', () => {
  const lock = (packages: Record<string, unknown>) =>
    ({ lockfileVersion: 2, configVersion: 1, packages }) as DependencyLock

  test('rejects inexact versions, renamed nested locators and malformed optional peers', () => {
    expect(() =>
      dependencyClosure(lock({ a: ['a@latest', '', {}, integrity] }), { a: 'latest' })
    ).toThrow('Expected an exact registry version: a@latest')
    expect(() =>
      dependencyClosure(
        lock({
          a: ['a@1.0.0', '', { dependencies: { b: '1.0.0' } }, integrity],
          'a/b': ['c@1.0.0', '', { dependencies: { d: '1.0.0' } }, integrity],
          d: ['d@1.0.0', '', {}, integrity],
        }),
        { a: '1.0.0' }
      )
    ).toThrow('Invalid nested dependency locator: a/b')
    for (const optionalPeers of ['b', [1]])
      expect(() =>
        dependencyClosure(lock({ a: ['a@1.0.0', '', { optionalPeers }, integrity] }), {
          a: '1.0.0',
        })
      ).toThrow('Invalid optional peer metadata: a')
  })
})

describe('package-set contract violations (inert fixtures)', () => {
  test('rejects missing provenance, inconsistent internal edges and changed consumer locks', async () => {
    await packageFixture(async ({ set }) => {
      const invalid = (mutate: (value: typeof set) => void, message: string) => {
        const copy = structuredClone(set)
        mutate(copy)
        expect(() => parsePackageSet(copy)).toThrow(message)
      }
      invalid((value) => {
        delete value.packages['@bun-native/core']!.files['LICENSE']
      }, 'Missing package entry/license/provenance: @bun-native/core')
      invalid((value) => {
        delete value.consumers.react.devDependencies['@types/react']
      }, 'Missing required consumer dependencies for react')
      invalid((value) => {
        value.consumers.solid.dependencies['@bun-native/ghost'] = '1.0.0'
      }, 'Unknown local dependency: @bun-native/ghost')
      invalid((value) => {
        value.consumers.solid.lock.packages['unrelated'] = ['unrelated@1.0.0', '', {}, integrity]
      }, 'Unexpected dependency-lock entries for solid')
      const inconsistent = structuredClone(set)
      const runtime = inconsistent.packages['@bun-native/core']!.manifest.dependencies!
      runtime['@bun-native/runtime'] = '9.9.9'
      expect(() => requiredPackages(inconsistent, 'solid')).toThrow(
        'Inconsistent internal dependency: @bun-native/core -> @bun-native/runtime'
      )
    })
  })

  test('installed verification rejects unreadable roots, reserved metadata and redirected entries', async () => {
    await packageFixture(async ({ directory, manifest, set, contents }) => {
      const file = join(directory, 'regular-file')
      await writeFile(file, 'not a consumer directory')
      const error = await verifyInstalledPackages(file, set, 'solid').catch((cause) => cause)
      if (process.platform === 'win32') {
        // Windows reports a path below a regular file as missing (ENOENT), which
        // the verifier turns into its not-installed guidance.
        expect((error as Error).message).toContain('Standalone dependencies are not installed')
      } else {
        expect((error as Error & { code?: string }).code).toBe('ENOTDIR')
      }

      const project = join(directory, 'project')
      await createProject(repository, project, 'solid', 'typescript', manifest)
      await installedFixture(project, set, 'solid', contents)
      await verifyInstalledPackages(project, set, 'solid')

      const reserved = structuredClone(set)
      reserved.packages['@bun-native/cli']!.files['.bun-tag'] = fixtureDigest('reserved')
      await expect(verifyInstalledPackages(project, reserved, 'solid')).rejects.toThrow(
        'Source archive contains reserved installer metadata: @bun-native/cli'
      )

      const redirected = structuredClone(set)
      redirected.packages['@bun-native/core']!.manifest.exports = './README.md'
      await expect(verifyInstalledPackages(project, redirected, 'solid')).rejects.toThrow(
        'Installed dependency resolves to a different package'
      )
    })
  })
})

describe('workspace manifest materialization (copied source manifests)', () => {
  async function workspace(
    directory: string,
    mutate: (manifests: Record<string, Record<string, unknown>>) => void
  ) {
    const manifests: Record<string, Record<string, unknown>> = {
      root: JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')),
    }
    for (const name of ['core', 'protocol', 'runtime', 'renderer', 'solid', 'react'])
      manifests[name] = JSON.parse(
        await readFile(join(repository, 'packages', name, 'package.json'), 'utf8')
      )
    mutate(manifests)
    for (const [name, manifest] of Object.entries(manifests)) {
      const target =
        name === 'root'
          ? join(directory, 'package.json')
          : join(directory, 'packages', name, 'package.json')
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, fixtureJSON(manifest))
    }
  }

  test('rejects foreign workspaces, unsupported workspace edges and missing React types', async () => {
    const cases: [(manifests: Record<string, Record<string, unknown>>) => void, string][] = [
      [
        (manifests) => {
          manifests['runtime']!['private'] = false
        },
        'Unexpected source workspace manifest: runtime',
      ],
      [
        (manifests) => {
          manifests['core']!['dependencies'] = { '@bun-native/runtime': 'workspace:^' }
        },
        'Unsupported workspace edge: @bun-native/core -> @bun-native/runtime',
      ],
      [
        (manifests) => {
          manifests['core']!['dependencies'] = { '@bun-native/unknown': 'workspace:*' }
        },
        'Unsupported workspace edge: @bun-native/core -> @bun-native/unknown',
      ],
      [
        (manifests) => {
          delete (manifests['root']!['devDependencies'] as Record<string, string>)[
            '@types/react-reconciler'
          ]
        },
        'Missing public React type dependency: @types/react-reconciler',
      ],
    ]
    for (const [mutate, message] of cases)
      await temporary(async (directory) => {
        await workspace(directory, mutate)
        await expect(materializedManifests(directory, [])).rejects.toThrow(message)
      })
    await temporary(async (directory) => {
      await workspace(directory, () => {})
      expect(Object.keys(await materializedManifests(directory, []))).toContain('@bun-native/cli')
    })
  })
})
