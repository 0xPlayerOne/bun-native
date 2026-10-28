import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { buildWorkspace } from '../scripts/build.ts'
import { checkBoundaries } from '../scripts/check-boundaries.ts'
import { inventory } from '../benchmarks/lib/inventory.ts'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bunly-tooling-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
async function workspace(root: string) {
  for (const name of ['contracts', 'client', 'runtime', 'artifacts', 'cli']) {
    const path = join(root, 'packages', name, 'src')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, name === 'cli' ? 'main.ts' : 'index.ts'), 'export const value = 1;')
    if (name === 'runtime')
      await writeFile(join(path, 'service-reload-runner.ts'), 'export const isolateEntry = true;')
    await writeFile(join(path, '../package.json'), '{"dependencies":{}}')
  }
  const example = join(root, 'examples/workbench')
  await mkdir(example, { recursive: true })
  await writeFile(join(example, 'main.ts'), 'export const value = 1;')
  await writeFile(join(example, 'browser.ts'), 'export const value = document.title;')
  await writeFile(join(example, 'index.html'), '<!doctype html><title>Fixture</title>')
}

test('builds every declared target and preserves source maps without a compiler', async () => {
  await fixture(async (root) => {
    await workspace(root)
    await buildWorkspace(root)
    for (const name of ['contracts', 'client', 'runtime', 'artifacts', 'cli']) {
      const entry = name === 'cli' ? 'main' : 'index'
      expect((await readdir(join(root, 'packages', name, 'dist'))).sort()).toEqual(
        [
          entry + '.js',
          entry + '.js.map',
          ...(name === 'runtime'
            ? ['service-reload-runner.js', 'service-reload-runner.js.map']
            : []),
        ].sort()
      )
    }
    expect((await readdir(join(root, 'examples/workbench/dist'))).sort()).toEqual([
      'browser.js',
      'browser.js.map',
      'index.html',
      'main.js',
      'main.js.map',
    ])
  })
})

test('rebuild removes stale package and example files and is byte deterministic', async () => {
  await fixture(async (root) => {
    await workspace(root)
    await buildWorkspace(root)
    const original = await inventory(join(root, 'examples/workbench/dist'))
    await writeFile(join(root, 'examples/workbench/dist/stale.js'), 'obsolete')
    await writeFile(join(root, 'packages/client/dist/stale.js'), 'obsolete')
    await buildWorkspace(root)
    expect(await inventory(join(root, 'examples/workbench/dist'))).toEqual(original)
    expect(await Bun.file(join(root, 'packages/client/dist/stale.js')).exists()).toBe(false)
  })
})

test('failed parallel build settles siblings and repair succeeds', async () => {
  await fixture(async (root) => {
    await workspace(root)
    await writeFile(join(root, 'packages/client/src/index.ts'), 'export const = ;')
    await expect(buildWorkspace(root)).rejects.toBeInstanceOf(AggregateError)
    expect(await Bun.file(join(root, 'packages/runtime/dist/index.js')).exists()).toBe(true)
    expect(await Bun.file(join(root, 'examples/workbench/dist/index.html')).exists()).toBe(true)
    await writeFile(join(root, 'packages/client/src/index.ts'), 'export const repaired = 2;')
    await buildWorkspace(root)
    expect(await Bun.file(join(root, 'packages/client/dist/index.js')).text()).toContain('repaired')
  })
})

test('native inventory hashes binary bytes and empty files with unchanged SHA-256 semantics', async () => {
  await fixture(async (root) => {
    const bytes = Uint8Array.from({ length: 131073 }, (_, i) => i % 256)
    await writeFile(join(root, 'binary'), bytes)
    await writeFile(join(root, 'empty'), '')
    const result = await inventory(root)
    expect(result.bytes).toBe(bytes.length)
    expect(result.entries.map((entry) => entry.sha256)).toEqual([
      createHash('sha256').update(bytes).digest('hex'),
      createHash('sha256').digest('hex'),
    ])
  })
})

test('duplicate-heavy inventory retains deterministic grouping without array copies', async () => {
  await fixture(async (root) => {
    await Promise.all(
      Array.from({ length: 128 }, (_, i) =>
        writeFile(join(root, i.toString().padStart(3, '0')), 'identical')
      )
    )
    const result = await inventory(root)
    expect(result.bytes).toBe(128 * 9)
    expect(result.duplicateContent).toHaveLength(1)
    expect(result.duplicateContent[0]!.paths).toEqual(result.entries.map((entry) => entry.path))
  })
})

test.skipIf(process.platform === 'win32')(
  'native inventory records but does not traverse links',
  async () => {
    await fixture(async (root) => {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(join(root, 'outside'), 'not part of the inventory')
      await symlink('../outside', join(app, 'link'))
      const result = await inventory(app)
      expect(result.bytes).toBe(0)
      expect(result.entries).toEqual([
        { path: 'link', bytes: 0, kind: 'symlink', sha256: null, target: '../outside' },
      ])
      await symlink(app, join(root, 'linked-root'))
      await expect(inventory(join(root, 'linked-root'))).rejects.toThrow('real directory')
    })
  }
)

test('native boundary reads preserve every file type and prune generated directories', async () => {
  await fixture(async (root) => {
    await workspace(root)
    for (const suffix of ['ts', 'tsx', 'mts', 'cts']) {
      await writeFile(join(root, 'packages/client/src', 'bad.' + suffix), 'import "node:fs";')
    }
    for (const name of ['dist', 'node_modules', 'target']) {
      const directory = join(root, 'packages/client', name)
      await mkdir(directory)
      await writeFile(join(directory, 'ignored.ts'), 'import "node:fs";')
    }
    const result = await checkBoundaries(root)
    expect(result).toHaveLength(4)
    expect(await checkBoundaries(root)).toEqual(result)
  })
})

test('tooling entrypoints use native checking without changing runtime/editor pins', async () => {
  const root = resolve(import.meta.dir, '..')
  const pkg = await Bun.file(join(root, 'package.json')).json()
  expect(pkg.scripts.typecheck).toBe('bun --check --tsconfig-override tsconfig.json')
  expect(pkg.scripts['typecheck:browser']).toBe(
    'bun --check --tsconfig-override tsconfig.browser.json'
  )
  expect(pkg.devDependencies.typescript).toBe(process.versions['typescript'])
  expect(pkg.engines.bun).toBe('1.4.3')
})

test('profile builds retain honest scope and invalidate stale manifests on failure', async () => {
  await fixture(async (root) => {
    await workspace(root)
    await buildWorkspace(root, { profile: 'system-webview' })
    const path = join(root, '.bunly/profiles/system-webview.json')
    const manifest = await Bun.file(path).json()
    expect(manifest.scope).toBe('sdk-workbench-bundle')
    expect(manifest.target).toBe(`${process.platform}-${process.arch}`)
    expect(manifest.selection.totalBytes).toBeGreaterThan(0)
    expect(manifest.selection.inventoryDigest).toMatch(/^sha256:/)
    for (const key of [
      'installerBytes',
      'installedBytes',
      'externalRuntimeDownloads',
      'cacheBytes',
      'residentMemoryBytes',
    ]) {
      expect(manifest.resources[key].source).toBe('not-measured')
      expect(manifest.resources[key].bytes).toBeNull()
    }
    await writeFile(join(root, 'packages/client/src/index.ts'), 'export const = ;')
    await expect(buildWorkspace(root, { profile: 'system-webview' })).rejects.toBeInstanceOf(
      AggregateError
    )
    expect(await Bun.file(path).exists()).toBe(false)
  })
})

test('an unsupported profile target fails before changing build outputs', async () => {
  await fixture(async (root) => {
    await workspace(root)
    await buildWorkspace(root)
    const before = await inventory(join(root, 'examples/workbench/dist'))
    await expect(buildWorkspace(root, { target: 'unsupported-architecture' })).rejects.toThrow(
      'does not support'
    )
    expect(await inventory(join(root, 'examples/workbench/dist'))).toEqual(before)
  })
})
