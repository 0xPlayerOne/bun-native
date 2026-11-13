import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import toolchain from '../../toolchain.json'
import { sha256, type FileDigest } from './artifact.ts'
import { userCache } from './context.ts'

/**
 * A verified standalone package set, as `readProject` reports it.
 *
 * Full verification hashes every archive, gunzips and hashes each member, checks
 * the consumer lock, and walks and hashes every installed file. `build`, `create`
 * and `doctor` always do that. The light commands (`check`, `format`, `lint`,
 * `dev` and each watch remount) may instead accept a stamp that the last full
 * verification left in `.bun-native/verified.json`. The stamp records the
 * manifest digest and the lstat identity (device, inode, mode, size, mtime and
 * ctime in nanoseconds) of every path that verification read: the manifest,
 * each archive, `bun.lock`, `node_modules`, each required package root, each of
 * its directories and installed files, and the verifier's own modules. Any
 * write, replacement, added or removed entry changes one of those identities,
 * and a miss falls back to full verification. A stamp hit trusts file system
 * metadata; it is a cache for local edit loops, not a security boundary.
 */
export type VerifiedPackageSet = {
  source: { commit: string; tree: string }
  manifest: FileDigest
}

type Stamp = {
  schemaVersion: 1
  revision: string
  framework: 'solid' | 'react'
  manifestPath: string
  archiveDirectory: string
  manifest: FileDigest
  source: VerifiedPackageSet['source']
  entries: Record<string, string>
}

/** One stamp per project directory, in the user cache so the project stays clean. */
export const stampFile = (
  directory: string,
  environment: Record<string, string | undefined> = process.env
) => join(userCache(environment), 'verified', `${sha256(resolve(directory)).slice(0, 32)}.json`)

// The modules whose rules decide verification; changing them invalidates every stamp.
const verifier = [
  'artifact.ts',
  'package-archive.ts',
  'package-lock.ts',
  'package-set.ts',
  'package-stamp.ts',
  'paths.ts',
].map((name) => join(import.meta.dir, name))

/** One path's identity, or undefined for a symlink or other entry the stamp will not trust. */
async function identity(path: string): Promise<string | undefined> {
  const stats = await lstat(path, { bigint: true })
  if (!stats.isFile() && !stats.isDirectory()) return undefined
  return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}

async function identities(
  directory: string,
  paths: string[]
): Promise<Record<string, string> | undefined> {
  const values = await Promise.all(
    paths.map((path) => identity(resolve(directory, path)).catch(() => undefined))
  )
  if (values.some((value) => value === undefined)) return undefined
  return Object.fromEntries(paths.map((path, index) => [path, values[index]!]))
}

const portable = (path: string) => path.split(sep).join('/')

async function manifestDigest(path: string): Promise<{ text: string; digest: FileDigest }> {
  const bytes = await Bun.file(path).bytes()
  return {
    text: new TextDecoder().decode(bytes),
    digest: { bytes: bytes.byteLength, sha256: sha256(bytes) },
  }
}

/** The stamped result when every recorded identity still matches, else undefined. */
async function stamped(
  directory: string,
  manifestPath: string,
  framework: 'solid' | 'react',
  archiveDirectory: string
): Promise<VerifiedPackageSet | undefined> {
  if (Bun.revision !== toolchain.bun.revision) return undefined
  let stamp: Stamp
  try {
    stamp = await Bun.file(stampFile(directory)).json()
  } catch {
    return undefined
  }
  if (
    stamp?.schemaVersion !== 1 ||
    stamp.revision !== Bun.revision ||
    stamp.framework !== framework ||
    stamp.manifestPath !== manifestPath ||
    stamp.archiveDirectory !== archiveDirectory ||
    typeof stamp.entries !== 'object' ||
    stamp.entries === null
  )
    return undefined
  const [current, manifest] = await Promise.all([
    identities(directory, Object.keys(stamp.entries)),
    manifestDigest(manifestPath),
  ])
  if (!current || !isDeepStrictEqual(current, stamp.entries)) return undefined
  if (!isDeepStrictEqual(manifest.digest, stamp.manifest)) return undefined
  return { source: stamp.source, manifest: manifest.digest }
}

/** Every path full verification reads, relative to the project or absolute for the verifier. */
async function verifiedPaths(
  directory: string,
  manifestPath: string,
  manifestText: string,
  framework: 'solid' | 'react'
): Promise<string[]> {
  const { parsePackageSet, requiredPackages } = await import('./package-set.ts')
  const set = parsePackageSet(JSON.parse(manifestText))
  const setDirectory = portable(relative(directory, dirname(manifestPath)))
  const paths = new Set<string>([
    portable(relative(directory, manifestPath)),
    'bun.lock',
    'node_modules',
    ...verifier,
  ])
  for (const pkg of Object.values(set.packages)) paths.add(`${setDirectory}/${pkg.archive.file}`)
  for (const name of requiredPackages(set, framework)) {
    const root = `node_modules/${name}`
    const parts = root.split('/')
    for (let index = 2; index <= parts.length; index += 1)
      paths.add(parts.slice(0, index).join('/'))
    for (const file of [...Object.keys(set.packages[name]!.files), '.bun-tag']) {
      const segments = file.split('/')
      for (let index = 1; index <= segments.length; index += 1)
        paths.add(`${root}/${segments.slice(0, index).join('/')}`)
    }
  }
  return [...paths].sort()
}

async function writeStamp(directory: string, stamp: Stamp): Promise<void> {
  const file = stampFile(directory)
  const partial = `${file}.${process.pid}.partial`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(partial, JSON.stringify(stamp, null, 2) + '\n')
    await rename(partial, file)
  } catch {
    // An unwritable user cache still verifies; it only loses the stamp.
    await rm(partial, { force: true }).catch(() => {})
  }
}

/**
 * Verify a standalone project's package set and installed packages. With `reuse`,
 * a matching stamp skips the archive and installed-file hashing, and a full
 * verification refreshes the stamp when nothing changed while it ran.
 */
export async function verifyStandalone(
  directory: string,
  manifestPath: string,
  framework: 'solid' | 'react',
  reuse: boolean
): Promise<VerifiedPackageSet> {
  const archiveDirectory = portable(relative(directory, dirname(manifestPath)))
  if (reuse) {
    const hit = await stamped(directory, manifestPath, framework, archiveDirectory)
    if (hit) return hit
  }
  const { readPackageSet, verifyInstalledPackages } = await import('./package-set.ts')
  // Record identities before hashing, so a change during verification cannot be stamped.
  const before = reuse ? await manifestDigest(manifestPath) : undefined
  const paths = before
    ? await verifiedPaths(directory, manifestPath, before.text, framework).catch(() => undefined)
    : undefined
  const recorded = paths ? await identities(directory, paths) : undefined
  const set = await readPackageSet(manifestPath)
  await verifyInstalledPackages(directory, set.manifest, framework, archiveDirectory)
  const manifest =
    before?.text === set.text ? before.digest : (await manifestDigest(manifestPath)).digest
  const result = {
    source: { commit: set.manifest.source.commit, tree: set.manifest.source.tree },
    manifest,
  }
  if (
    paths &&
    recorded &&
    before?.text === set.text &&
    isDeepStrictEqual(recorded, await identities(directory, paths))
  )
    await writeStamp(directory, {
      schemaVersion: 1,
      revision: Bun.revision,
      framework,
      manifestPath,
      archiveDirectory,
      manifest,
      source: result.source,
      entries: recorded,
    })
  return result
}
