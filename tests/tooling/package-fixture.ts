import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import toolchain from '../../toolchain.json'
import {
  cliSourceClosure,
  consumerDefinitions,
  materializedManifests,
} from '../../scripts/native/package-source.ts'
import { requiredPackages, type PackageSet } from '../../scripts/native/package-set.ts'
import type { FileDigest } from '../../scripts/native/artifact.ts'

const repository = resolve(import.meta.dir, '../..')
export const fixtureDigest = (text: string | Uint8Array): FileDigest => ({
  bytes: typeof text === 'string' ? Buffer.byteLength(text) : text.byteLength,
  sha256: createHash('sha256').update(text).digest('hex'),
})
export const fixtureJSON = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/**
 * Inert module/archive bytes for source contract tests; not an installation.
 * With `cli`, the @bun-native/cli package carries the real CLI source closure under
 * `src/`, as package-native.ts packs it, so a test can run the CLI the way a consumer does.
 */
export async function packageFixture(
  exercise: (fixture: {
    directory: string
    manifest: string
    set: PackageSet
    contents: Record<string, Record<string, string>>
  }) => Promise<void>,
  options: { cli?: boolean } = {}
): Promise<void> {
  let directory = await mkdtemp(join(tmpdir(), 'bun-native-package-unit-'))
  try {
    // Match readProject's canonical consumer root, including OS temp aliases.
    // Keep resolution inside the owned cleanup boundary if it rejects.
    directory = await realpath(directory)
    const manifests = await materializedManifests(repository, [
      '@babel/core',
      'babel-preset-solid',
      'oxlint',
    ])
    const contents: Record<string, Record<string, string>> = {}
    const set: PackageSet = {
      schemaVersion: 1,
      source: {
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        files: {
          LICENSE: fixtureDigest('fixture license'),
          'package.json': fixtureDigest('{}'),
          'bun.lock': fixtureDigest('{}'),
          'toolchain.json': fixtureDigest(fixtureJSON(toolchain)),
        },
      },
      toolchain,
      compiler: {
        revision: toolchain.bun.revision,
        os: process.platform,
        architecture: process.arch,
        executable: fixtureDigest('inert compiler identity'),
      },
      packages: {},
      consumers: await consumerDefinitions(repository, manifests),
    }
    await mkdir(join(directory, 'set/archives'), { recursive: true })
    for (const [name, manifest] of Object.entries(manifests)) {
      const paths =
        typeof manifest.exports === 'string'
          ? [manifest.exports]
          : Object.values(manifest.exports ?? manifest.bin ?? {})
      const files = Object.fromEntries(
        paths.map((path) => [
          path.replace(/^\.\//, ''),
          'export {} // inert fixture; never imported\n',
        ])
      )
      if (options.cli && name === '@bun-native/cli')
        for (const path of (await cliSourceClosure(repository)).files)
          files[`src/${path}`] = await Bun.file(join(repository, path)).text()
      Object.assign(files, {
        'package.json': fixtureJSON(manifest),
        LICENSE: 'fixture license',
        'README.md': 'Inert package-contract fixture, not an installed consumer.\n',
        'bun-native-source.json': fixtureJSON(set.source),
      })
      contents[name] = files
      const archiveFile = `archives/${name.replace('@', '').replace('/', '-')}.tgz`
      const archive = new Bun.Archive(
        Object.fromEntries(Object.entries(files).map(([path, text]) => [`package/${path}`, text])),
        { compress: 'gzip' }
      )
      const bytes = await archive.bytes()
      await writeFile(join(directory, 'set', archiveFile), bytes)
      set.packages[name] = {
        manifest,
        archive: { file: archiveFile, ...fixtureDigest(bytes) },
        files: Object.fromEntries(
          Object.entries(files).map(([path, text]) => [path, fixtureDigest(text)])
        ),
      }
    }
    const manifest = join(directory, 'set/manifest.json')
    await writeFile(manifest, fixtureJSON(set))
    await exercise({ directory, manifest, set, contents })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Lay down known inert files directly; deliberately does not call a package manager. */
export async function installedFixture(
  directory: string,
  set: PackageSet,
  framework: 'solid' | 'react',
  contents: Record<string, Record<string, string>>
): Promise<void> {
  for (const name of requiredPackages(set, framework)) {
    for (const [path, text] of Object.entries(contents[name]!)) {
      const target = join(directory, 'node_modules', name, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text)
    }
    // Observed pinned SHA256 tag is canonical SRI plus one extra '='. This is
    // inert metadata written directly, never a package-manager invocation.
    const tag = `sha256-${Buffer.from(set.packages[name]!.archive.sha256, 'hex').toString('base64')}=`
    await writeFile(join(directory, 'node_modules', name, '.bun-tag'), tag)
  }
}
