/** Independently installed, frozen benchmark dependencies; never Bunly runtime deps. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
export const REFERENCE_PACKAGES = {
  mirin: {
    framework: 'Mirin',
    version: '0.1.0-alpha.26',
    sourceCommit: 'c60fa09a7ae94368e22188cb8ff0b38a910a9f24',
    cli: '@mirinjs/cli',
    runtime: 'mirinjs',
    entry: 'src/index.ts',
    build: ['build'],
  },
  butter: {
    framework: 'Butter',
    version: '1.6.3',
    sourceCommit: 'a735ddf2eac8f4fe4a98370fc4ccf4373db797d9',
    cli: 'butterframework',
    runtime: 'butterframework',
    entry: 'src/cli/index.ts',
    build: ['compile'],
  },
} as const
export type ReferenceName = keyof typeof REFERENCE_PACKAGES
export interface ReferenceInstallation {
  readonly entry: string
  readonly nodeModules: string
  readonly lockSha256: string
  readonly packages: readonly {
    readonly name: string
    readonly version: string
    readonly manifestSha256: string
    readonly entrySha256: string
  }[]
  readonly sourceVerified: false
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** Version and content observations are not claimed to authenticate registry provenance. */
export async function referenceInstallation(
  name: ReferenceName,
  directory: string,
  expectedLockSha256: string
): Promise<ReferenceInstallation> {
  if (!Object.hasOwn(REFERENCE_PACKAGES, name) || !/^[a-f0-9]{64}$/.test(expectedLockSha256))
    throw new Error('Select a pinned reference and frozen-lock digest')
  const root = await realpath(directory),
    lockPath = join(root, 'bun.lock'),
    details = await lstat(lockPath)
  if (!details.isFile() || details.isSymbolicLink() || details.size > 4 * 1024 * 1024)
    throw new Error('Missing bounded frozen Bun lock')
  const lock = await readFile(lockPath)
  if (hash(lock) !== expectedLockSha256) throw new Error('Frozen benchmark lock digest mismatch')
  const nodeModules = await realpath(join(root, 'node_modules'))
  const spec = REFERENCE_PACKAGES[name],
    packages: ReferenceInstallation['packages'][number][] = []
  let entry = ''
  for (const pkg of new Set([spec.cli, spec.runtime])) {
    const path = await realpath(join(nodeModules, pkg))
    const rel = relative(nodeModules, path)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))
      throw new Error('Reference package escapes the isolated installation')
    const manifestPath = join(path, 'package.json'),
      info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new Error('Invalid installed package manifest')
    const manifest = await readFile(manifestPath),
      value: unknown = JSON.parse(manifest.toString('utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('name' in value) ||
      !('version' in value) ||
      value.name !== pkg ||
      value.version !== spec.version
    )
      throw new Error('Installed reference version mismatch: ' + pkg)
    const entryPath = await realpath(resolve(path, pkg === spec.cli ? spec.entry : 'src/index.ts'))
    const relativeEntry = relative(path, entryPath)
    if (
      relativeEntry === '..' ||
      relativeEntry.startsWith('..' + '/') ||
      relativeEntry.startsWith('..\\') ||
      isAbsolute(relativeEntry)
    )
      throw new Error('Reference entry escapes package')
    const size = await lstat(entryPath)
    if (!size.isFile() || size.size > 4 * 1024 * 1024)
      throw new Error('Invalid reference entrypoint')
    packages.push({
      name: pkg,
      version: spec.version,
      manifestSha256: hash(manifest),
      entrySha256: hash(await readFile(entryPath)),
    })
    if (pkg === spec.cli) entry = entryPath
  }
  return { entry, nodeModules, lockSha256: hash(lock), packages, sourceVerified: false }
}
