import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import toolchain from '../../toolchain.json'
import {
  dependencyClosure,
  lockedPackages,
  localArchiveLock,
  verifyConsumerLock,
  type DependencyLock,
} from './package-lock.ts'
import { inside, packageArchivePath, packagePath } from './paths.ts'
import { fileDigest, type FileDigest } from './artifact.ts'
import { verifyPackageArchive } from './package-archive.ts'

export const packageNames = [
  '@bun-native/cli',
  '@bun-native/core',
  '@bun-native/protocol',
  '@bun-native/react',
  '@bun-native/renderer',
  '@bun-native/runtime',
  '@bun-native/solid',
] as const

export type PackageManifest = {
  name: string
  version: string
  private: true
  type: 'module'
  license: 'MIT'
  files: string[]
  engines: { bun: string }
  dependencies?: Record<string, string>
  exports?: string | Record<string, string>
  bin?: Record<string, string>
}
export type LocalPackage = {
  manifest: PackageManifest
  archive: FileDigest & { file: string }
  files: Record<string, FileDigest>
}
export type Consumer = {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  lock: DependencyLock
}
export type PackageSet = {
  schemaVersion: 1
  source: { commit: string; tree: string; files: Record<string, FileDigest> }
  toolchain: typeof toolchain
  compiler: { revision: string; os: string; architecture: string; executable: FileDigest }
  packages: Record<string, LocalPackage>
  consumers: { solid: Consumer; react: Consumer }
}
export type ReadPackageSet = { directory: string; manifest: PackageSet; text: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid package-set object')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Unexpected or missing package-set fields')
}

function digest(value: unknown): FileDigest {
  const fields = object(value)
  if (
    !Number.isSafeInteger(fields['bytes']) ||
    (fields['bytes'] as number) < 0 ||
    typeof fields['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fields['sha256'])
  )
    throw new Error('Invalid package-set file digest')
  return { bytes: fields['bytes'] as number, sha256: fields['sha256'] }
}

function files(value: unknown): Record<string, FileDigest> {
  const result: Record<string, FileDigest> = Object.create(null)
  for (const [path, entry] of Object.entries(object(value))) {
    if (!packagePath(path)) throw new Error(`Invalid package-set file path: ${path}`)
    keys(object(entry), ['bytes', 'sha256'])
    result[path] = digest(entry)
  }
  return result
}

function versions(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const [name, version] of Object.entries(object(value))) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    )
      throw new Error(`Package-set dependency must have an exact version: ${name}`)
    result[name] = version
  }
  return result
}

function exportedPaths(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Object.values(object(value)).map((entry) => {
        if (typeof entry !== 'string') throw new Error('Invalid package export/bin path')
        return entry
      })
}

function packageManifest(
  value: unknown,
  name: string,
  contents: Record<string, FileDigest>
): PackageManifest {
  const manifest = object(value)
  keys(
    manifest,
    ['name', 'version', 'private', 'type', 'license', 'files', 'engines'],
    ['dependencies', 'exports', 'bin']
  )
  if (
    manifest['name'] !== name ||
    manifest['private'] !== true ||
    manifest['type'] !== 'module' ||
    manifest['license'] !== 'MIT' ||
    !isDeepStrictEqual(manifest['engines'], { bun: toolchain.bun.version }) ||
    !Array.isArray(manifest['files']) ||
    manifest['files'].some((path) => !packageArchivePath(path))
  )
    throw new Error(`Invalid materialized package manifest: ${name}`)
  versions({ [name]: manifest['version'] })
  if (manifest['dependencies'] !== undefined) versions(manifest['dependencies'])
  for (const field of ['exports', 'bin']) {
    if (manifest[field] === undefined) continue
    for (const exported of exportedPaths(manifest[field])) {
      const path = exported.replace(/^\.\//, '')
      if (!packagePath(path) || !Object.hasOwn(contents, path))
        throw new Error(`Unpackaged ${field} target: ${name} ${exported}`)
    }
  }
  if (
    !Object.hasOwn(contents, 'LICENSE') ||
    !Object.hasOwn(contents, 'bun-native-source.json') ||
    !Object.hasOwn(contents, 'package.json') ||
    (name === '@bun-native/cli'
      ? !isDeepStrictEqual(manifest['bin'], { 'bun-native': './src/scripts/native.ts' }) ||
        manifest['exports'] !== undefined
      : manifest['exports'] === undefined || manifest['bin'] !== undefined)
  )
    throw new Error(`Missing package entry/license/provenance: ${name}`)
  const text = JSON.stringify(manifest, null, 2) + '\n'
  if (
    !isDeepStrictEqual(contents['package.json'], {
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  )
    throw new Error(`Package manifest digest mismatch: ${name}`)
  return manifest as PackageManifest
}

export function requiredPackages(set: PackageSet, framework: 'solid' | 'react'): string[] {
  const pending = ['@bun-native/cli', '@bun-native/core', `@bun-native/${framework}`]
  const required = new Set<string>()
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index]!
    if (required.has(name)) continue
    const pkg = set.packages[name]
    if (!pkg) throw new Error(`Missing local package: ${name}`)
    required.add(name)
    for (const [dependency, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@bun-native/')) continue
      if (set.packages[dependency]?.manifest.version !== version)
        throw new Error(`Inconsistent internal dependency: ${name} -> ${dependency}`)
      pending.push(dependency)
    }
  }
  return [...required].sort()
}

export function consumerArchiveLock(
  set: PackageSet,
  framework: 'solid' | 'react',
  archiveDirectory = 'vendor/bun-native'
) {
  return localArchiveLock(
    requiredPackages(set, framework).map((name) => {
      const pkg = set.packages[name]!
      return {
        name,
        file: `${archiveDirectory ? archiveDirectory + '/' : ''}${pkg.archive.file}`,
        sha256: pkg.archive.sha256,
        ...(pkg.manifest.dependencies ? { dependencies: pkg.manifest.dependencies } : {}),
        ...(pkg.manifest.bin ? { bin: pkg.manifest.bin } : {}),
      }
    })
  )
}

/** Validates data only; archives are hashed separately before any destination is written. */
export function parsePackageSet(value: unknown): PackageSet {
  const fields = object(value)
  keys(fields, ['schemaVersion', 'source', 'toolchain', 'compiler', 'packages', 'consumers'])
  if (fields['schemaVersion'] !== 1 || !isDeepStrictEqual(fields['toolchain'], toolchain))
    throw new Error('Package set requires the exact pinned Bun Native toolchain')
  const source = object(fields['source'])
  keys(source, ['commit', 'tree', 'files'])
  if (
    ![source['commit'], source['tree']].every(
      (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
    )
  )
    throw new Error('Package set requires exact source commit and tree identities')
  files(source['files'])
  const compiler = object(fields['compiler'])
  keys(compiler, ['revision', 'os', 'architecture', 'executable'])
  if (
    compiler['revision'] !== toolchain.bun.revision ||
    typeof compiler['os'] !== 'string' ||
    typeof compiler['architecture'] !== 'string'
  )
    throw new Error('Invalid package producer compiler identity')
  digest(compiler['executable'])
  const packages = object(fields['packages'])
  keys(packages, [...packageNames])
  const archives = new Set<string>()
  for (const [name, entry] of Object.entries(packages)) {
    const pkg = object(entry)
    keys(pkg, ['manifest', 'archive', 'files'])
    const contents = files(pkg['files'])
    if (Object.keys(contents).some((path) => !packageArchivePath(path)))
      throw new Error(`Source archive contains reserved installer metadata: ${name}`)
    packageManifest(pkg['manifest'], name, contents)
    const archive = object(pkg['archive'])
    keys(archive, ['file', 'bytes', 'sha256'])
    digest(archive)
    if (
      !packagePath(archive['file']) ||
      !/^archives\/[a-z0-9._-]+\.tgz$/.test(archive['file']) ||
      archives.has(archive['file'])
    )
      throw new Error('Package archives must have unique contained relative paths')
    archives.add(archive['file'])
  }
  const consumers = object(fields['consumers'])
  keys(consumers, ['solid', 'react'])
  const set = fields as PackageSet
  for (const framework of ['solid', 'react'] as const) {
    const consumer = object(consumers[framework])
    keys(consumer, ['dependencies', 'devDependencies', 'lock'])
    const runtime = versions(consumer['dependencies'])
    const development = versions(consumer['devDependencies'])
    if (
      !runtime['@bun-native/core'] ||
      !runtime[`@bun-native/${framework}`] ||
      !runtime[framework === 'solid' ? 'solid-js' : 'react'] ||
      !development['@bun-native/cli'] ||
      !development['@types/bun'] ||
      (framework === 'react' &&
        (!development['@types/react'] || !development['@types/react-reconciler']))
    )
      throw new Error(`Missing required consumer dependencies for ${framework}`)
    const dependencies = { ...runtime, ...development }
    const external: Record<string, string> = Object.create(null)
    for (const name of requiredPackages(set, framework)) {
      for (const [dependency, version] of Object.entries(
        set.packages[name]!.manifest.dependencies ?? {}
      )) {
        if (dependencies[dependency] !== undefined && dependencies[dependency] !== version)
          throw new Error(`Inconsistent consumer dependency: ${dependency}`)
        dependencies[dependency] = version
      }
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (name.startsWith('@bun-native/')) {
        if (set.packages[name]?.manifest.version !== version)
          throw new Error(`Unknown local dependency: ${name}`)
      } else external[name] = version
    }
    const lock = lockedPackages(consumer['lock'])
    if (
      !isDeepStrictEqual(consumer['lock'], lock) ||
      !isDeepStrictEqual(lock, dependencyClosure(lock, external))
    )
      throw new Error(`Unexpected dependency-lock entries for ${framework}`)
  }
  return set
}

async function containedFile(directory: string, path: string): Promise<string> {
  const target = await realpath(join(directory, path))
  if (!inside(directory, target) || !(await stat(target)).isFile())
    throw new Error(`Package file escapes its owned directory or is not a file: ${path}`)
  return target
}

export async function readPackageSet(path: string): Promise<ReadPackageSet> {
  if (Bun.revision !== toolchain.bun.revision)
    throw new Error('Use the pinned Bun for this package set')
  const filename = await realpath(path)
  const directory = dirname(filename)
  const text = await Bun.file(filename).text()
  const manifest = parsePackageSet(JSON.parse(text))
  if (text !== JSON.stringify(manifest, null, 2) + '\n')
    throw new Error('Package-set manifest must use its original canonical JSON encoding')
  for (const [name, pkg] of Object.entries(manifest.packages)) {
    const file = await containedFile(directory, pkg.archive.file)
    if (!isDeepStrictEqual(await fileDigest(file), digest(pkg.archive)))
      throw new Error(`Package archive digest mismatch: ${name}`)
    await verifyPackageArchive(file, pkg.files)
  }
  return { directory, manifest, text }
}

/** Validate the installed CLI too, before its lazy compiler/watch modules are imported. */
export async function verifyInstalledPackages(
  directory: string,
  set: PackageSet,
  framework: 'solid' | 'react',
  archiveDirectory = 'vendor/bun-native'
): Promise<void> {
  let modules: string
  try {
    modules = await realpath(join(directory, 'node_modules'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new Error(
        "Standalone dependencies are not installed; follow this project's pinned offline-install instructions"
      )
    throw error
  }
  if (!inside(directory, modules))
    throw new Error('Installed packages must belong to this consumer')
  const required = requiredPackages(set, framework)
  verifyConsumerLock(
    Bun.JSONC.parse(await Bun.file(join(directory, 'bun.lock')).text()),
    set.consumers[framework].lock,
    true,
    consumerArchiveLock(set, framework, archiveDirectory)
  )
  const locations = new Map<string, string>()
  for (const name of required) {
    const pkg = set.packages[name]!
    const root = await realpath(join(modules, name))
    if (!inside(modules, root))
      throw new Error(`Installed package resolves outside this consumer: ${name}`)
    locations.set(name, root)
    if (Object.keys(pkg.files).some((path) => !packageArchivePath(path)))
      throw new Error(`Source archive contains reserved installer metadata: ${name}`)
    // Pinned Integrity::Display uses unpadded base64 followed by "==" for
    // SHA-256. This is its 52-byte installer tag, not the canonical lock SRI.
    const tag = `sha256-${Buffer.from(pkg.archive.sha256, 'hex').toString('base64').replace(/=+$/, '')}==`
    const installedFiles: Record<string, FileDigest> = {
      ...pkg.files,
      '.bun-tag': {
        bytes: Buffer.byteLength(tag),
        sha256: createHash('sha256').update(tag).digest('hex'),
      },
    }
    const expected = Object.keys(installedFiles).sort()
    const folders = new Set(
      expected.flatMap((path) => {
        const parts = path.split('/')
        return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
      })
    )
    const inventory: string[] = []
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name
        if (entry.isDirectory() && folders.has(path))
          await visit(join(directory, entry.name), path + '/')
        else if (entry.isFile() && Object.hasOwn(installedFiles, path)) inventory.push(path)
        else throw new Error(`Installed package file inventory differs: ${name}/${path}`)
      }
    }
    await visit(root, '')
    if (!isDeepStrictEqual(inventory.sort(), expected))
      throw new Error(`Installed package file inventory differs: ${name}`)
    for (const [path, expected] of Object.entries(installedFiles)) {
      const file = await containedFile(root, path)
      if (!isDeepStrictEqual(await fileDigest(file), expected))
        throw new Error(`Installed package digest mismatch: ${name}/${path}`)
    }
  }
  for (const name of required) {
    const root = locations.get(name)!
    for (const dependency of Object.keys(set.packages[name]!.manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@bun-native/')) continue
      const expected = locations.get(dependency)!
      const resolved = await realpath(Bun.resolveSync(dependency, root))
      const exported = set.packages[dependency]!.manifest.exports!
      const entry = typeof exported === 'string' ? exported : exported['.']!
      if (resolved !== (await realpath(join(expected, entry))))
        throw new Error(
          `Installed dependency resolves to a different package: ${name} -> ${dependency}`
        )
    }
  }
}
