import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DevelopmentError, prepareDevelopmentHost } from '../packages/cli/src/dev-cache.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const original = 'export const value = 1'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bunly-cache-integrity-'))
  const input = join(root, 'native')
  await writeFile(input, 'selected-native')
  let assemblies = 0
  const prepare = () =>
    prepareDevelopmentHost({
      cacheRoot: join(root, 'cache'),
      identity: {
        appId: 'test.cache-integrity',
        nativeAbi: '1',
        engineVersion: 'cef:156.0.7',
        target: `${process.platform}-${process.arch}`,
        bunVersion: Bun.version,
        configuration: '{}',
        inputs: [{ name: 'native', path: input, sha256: sha('selected-native') }],
      },
      assemble: async (directory) => {
        assemblies++
        await mkdir(join(directory, 'empty'))
        await writeFile(join(directory, 'host.js'), original)
        return { entrypoint: 'host.js' }
      },
    })
  const cold = await prepare()
  return { root, cold, prepare, assemblies: () => assemblies }
}
async function rejected(prepare: () => Promise<unknown>): Promise<DevelopmentError> {
  let caught: unknown
  try {
    await prepare()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DevelopmentError)
  expect((caught as DevelopmentError).code).toBe('CACHE_INTEGRITY')
  expect((caught as DevelopmentError).message).toBe(
    'Prepared host no longer matches its complete inventory'
  )
  return caught as DevelopmentError
}
test('cache byte mismatch retains exact compared snapshots without rebuilding or repairing', async () => {
  const { root, cold, prepare, assemblies } = await fixture()
  try {
    const receipt = await readFile(join(cold.directory, 'bunly-dev-host.json'), 'utf8')
    await writeFile(cold.entrypoint, 'export const value = 2')
    const failure = await rejected(prepare),
      diagnostic = failure.cacheIntegrity!
    expect(diagnostic.status).toBe('mismatch')
    expect(diagnostic.scanComplete).toBe(true)
    expect(diagnostic.expected).toEqual(JSON.parse(receipt).files)
    expect(diagnostic.actual!.find((entry) => entry.path === 'host.js')!.sha256).toBe(
      sha('export const value = 2')
    )
    expect(diagnostic.difference).toEqual({
      added: [],
      removed: [],
      changed: [{ path: 'host.js', fields: ['sha256'] }],
      entryOrderChanged: false,
    })
    // The diagnostic is the scan that rejected the cache, not a later rescan.
    await writeFile(cold.entrypoint, original)
    expect(diagnostic.actual!.find((entry) => entry.path === 'host.js')!.sha256).toBe(
      sha('export const value = 2')
    )
    expect(await readFile(join(cold.directory, 'bunly-dev-host.json'), 'utf8')).toBe(receipt)
    expect((await prepare()).cacheHit).toBe(true)
    expect(assemblies()).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('cache mismatch includes added empty directories that file-only inventories omit', async () => {
  const { root, cold, prepare, assemblies } = await fixture()
  try {
    await mkdir(join(cold.directory, 'after-run'), { mode: 0o700 })
    const diagnostic = (await rejected(prepare)).cacheIntegrity!
    expect(diagnostic.difference).toEqual({
      added: ['after-run'],
      removed: [],
      changed: [],
      entryOrderChanged: false,
    })
    expect(diagnostic.actual!.find((entry) => entry.path === 'after-run')).toEqual({
      path: 'after-run',
      kind: 'directory',
      mode: process.platform === 'win32' ? 0 : 0o700,
      bytes: 0,
      sha256: sha(''),
    })
    expect(assemblies()).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('cache mismatch retains removed directory entries without replacing the cache', async () => {
  const { root, cold, prepare, assemblies } = await fixture()
  try {
    await rm(join(cold.directory, 'empty'), { recursive: true })
    const diagnostic = (await rejected(prepare)).cacheIntegrity!
    expect(diagnostic.scanComplete).toBe(true)
    expect(diagnostic.difference).toEqual({
      added: [],
      removed: ['empty'],
      changed: [],
      entryOrderChanged: false,
    })
    expect(diagnostic.actual!.map((entry) => entry.path)).toEqual(['host.js'])
    expect(assemblies()).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test.skipIf(process.platform === 'win32')(
  'cache mismatch records POSIX mode-only drift without weakening byte checks',
  async () => {
    const { root, cold, prepare, assemblies } = await fixture()
    try {
      const mode = (await lstat(cold.entrypoint)).mode & 0o777
      await chmod(cold.entrypoint, mode ^ 0o100)
      const diagnostic = (await rejected(prepare)).cacheIntegrity!
      expect(diagnostic.difference).toEqual({
        added: [],
        removed: [],
        changed: [{ path: 'host.js', fields: ['mode'] }],
        entryOrderChanged: false,
      })
      expect(diagnostic.actual!.find((entry) => entry.path === 'host.js')!.sha256).toBe(
        sha(original)
      )
      expect(assemblies()).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
test.skipIf(process.platform === 'win32')(
  'unsafe-link scan failure is incomplete and never exposes an absolute target',
  async () => {
    const { root, cold, prepare, assemblies } = await fixture()
    try {
      await symlink(join(root, 'native'), join(cold.directory, 'unsafe'))
      const diagnostic = (await rejected(prepare)).cacheIntegrity!
      expect(diagnostic.phase).toBe('inventory')
      expect(diagnostic.status).toBe('incomplete')
      expect(diagnostic.scanComplete).toBe(false)
      expect(diagnostic.failure).toEqual({ code: 'CACHE_INTEGRITY', path: 'unsafe' })
      expect(diagnostic.difference).toBeUndefined()
      expect(diagnostic.actual!.map((entry) => entry.path)).toEqual(['empty', 'host.js'])
      expect(JSON.stringify(diagnostic)).not.toContain(root)
      expect(assemblies()).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
test('malformed receipt payloads are not exposed as trusted expected metadata', async () => {
  const { root, cold, prepare, assemblies } = await fixture()
  try {
    const path = join(cold.directory, 'bunly-dev-host.json')
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    receipt.files[0].path = join(dirname(root), 'private-fixture-value')
    receipt.files[0].kind = { toString: 'malformed-private-kind' }
    await writeFile(path, JSON.stringify(receipt))
    const diagnostic = (await rejected(prepare)).cacheIntegrity!
    expect(diagnostic.status).toBe('incomplete')
    expect(diagnostic.phase).toBe('receipt')
    expect(diagnostic.failure!.code).toBe('INVALID_RECEIPT')
    expect(diagnostic.expected).toBeUndefined()
    expect(diagnostic.difference).toBeUndefined()
    expect(JSON.stringify(diagnostic)).not.toContain('private-fixture-value')
    expect(JSON.stringify(diagnostic)).not.toContain('malformed-private-kind')
    expect(assemblies()).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
