import { randomBytes, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileDigest, type FileDigest } from './artifact.ts'
import { packagePath } from './paths.ts'
import {
  UpdateError,
  verifyBuildManifest,
  type UpdateFile,
  type VerifiedTrust,
  type VerifiedUpdate,
} from './update-manifest.ts'

/**
 * Installation root layout (all updater-owned except data/):
 *   state.json   committed pointer to the current and previous release
 *   versions/    immutable verified release directories
 *   staging/     in-progress downloads, discarded by recovery
 *   data/        application user data; never written or removed by the updater
 *   lock         single-writer lock with the owning process id
 */
export type Release = {
  directory: string
  version: string
  sequence: number
  manifestSha256: string
  trust: VerifiedTrust
  files: Record<string, UpdateFile>
}

export type InstallationState = {
  schemaVersion: 1
  product: string
  current: Release
  previous: Release | null
}

export type InstallPhase = 'locked' | 'downloaded' | 'staged' | 'promoted' | 'committed'

/** A payload source yields one file's bytes; length and digest are checked by the installer. */
export type PayloadSource = (
  path: string
) => Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>>

export function directorySource(directory: string): PayloadSource {
  return async (path) => {
    if (!packagePath(path)) throw new UpdateError('malformed', `Unsafe payload path ${path}`)
    return createReadStream(join(directory, path))
  }
}

/** HTTPS payload source; plain HTTP is accepted only for loopback test servers. */
export function httpSource(base: URL): PayloadSource {
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    throw new UpdateError('untrusted', 'Update payloads require HTTPS')
  return async (path) => {
    if (!packagePath(path)) throw new UpdateError('malformed', `Unsafe payload path ${path}`)
    const response = await fetch(new URL(path, base), { redirect: 'error' })
    if (!response.ok || !response.body)
      throw new UpdateError('integrity', `Download of ${path} failed with ${response.status}`)
    return response.body
  }
}

const stateFile = 'state.json'

export function dataDirectory(root: string): string {
  return join(resolve(root), 'data')
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return code(error) === 'EPERM'
  }
}

async function lock(root: string): Promise<() => Promise<void>> {
  const path = join(root, 'lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      await handle.sync()
      await handle.close()
      return () => rm(path, { force: true })
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
      const owner = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10)
      if (Number.isSafeInteger(owner) && owner > 0 && alive(owner))
        throw new UpdateError('busy', `Installation is locked by process ${owner}`)
      // The writer died (or wrote nothing); its uncommitted work is discarded below.
      await rm(path, { force: true })
    }
  }
  throw new UpdateError('busy', 'Could not acquire the installation lock')
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function parseRelease(value: unknown): Release {
  const release = value as Release
  if (
    typeof release?.directory !== 'string' ||
    !/^versions\/[0-9A-Za-z.-]+$/.test(release.directory) ||
    typeof release.version !== 'string' ||
    !Number.isSafeInteger(release.sequence) ||
    !/^[0-9a-f]{64}$/.test(release.manifestSha256) ||
    (release.trust?.kind !== 'ed25519' && release.trust?.kind !== 'unsigned-experimental') ||
    release.files === null ||
    typeof release.files !== 'object' ||
    !Object.keys(release.files).every(packagePath)
  )
    throw new UpdateError('state', 'Installation state has an invalid release record')
  return release
}

export async function readState(root: string): Promise<InstallationState | null> {
  let text: string
  try {
    text = await readFile(join(resolve(root), stateFile), 'utf8')
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
  let value: InstallationState
  try {
    value = JSON.parse(text) as InstallationState
  } catch {
    throw new UpdateError('state', 'Installation state is not JSON')
  }
  if (value?.schemaVersion !== 1 || typeof value.product !== 'string')
    throw new UpdateError('state', 'Unsupported installation state')
  return {
    schemaVersion: 1,
    product: value.product,
    current: parseRelease(value.current),
    previous: value.previous === null ? null : parseRelease(value.previous),
  }
}

/** Commit point: write a complete state file, then atomically rename it into place. */
async function writeState(root: string, state: InstallationState): Promise<void> {
  const temporary = join(root, `${stateFile}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, join(root, stateFile))
  await syncDirectory(root)
}

/** Remove uncommitted staging, temporary state and unreferenced release directories. */
async function sweep(root: string, state: InstallationState | null): Promise<string[]> {
  const removed: string[] = []
  const keep = new Set([state?.current.directory, state?.previous?.directory])
  for (const name of await readdir(join(root, 'staging')).catch(() => [])) {
    await rm(join(root, 'staging', name), { recursive: true, force: true })
    removed.push(`staging/${name}`)
  }
  for (const name of await readdir(join(root, 'versions')).catch(() => []))
    if (!keep.has(`versions/${name}`)) {
      await rm(join(root, 'versions', name), { recursive: true, force: true })
      removed.push(`versions/${name}`)
    }
  for (const name of await readdir(root))
    if (name.startsWith(`${stateFile}.`) && name.endsWith('.tmp')) {
      await rm(join(root, name), { force: true })
      removed.push(name)
    }
  return removed.sort()
}

async function prepare(root: string): Promise<string> {
  const directory = resolve(root)
  await mkdir(directory, { recursive: true })
  for (const name of ['versions', 'staging', 'data'])
    await mkdir(join(directory, name), { recursive: true })
  return directory
}

/** Discard interrupted installation work. Committed releases and data are untouched. */
export async function recover(root: string): Promise<string[]> {
  const directory = await prepare(root)
  const unlock = await lock(directory)
  try {
    return await sweep(directory, await readState(directory))
  } finally {
    await unlock()
  }
}

async function download(
  source: PayloadSource,
  path: string,
  expected: UpdateFile,
  destination: string
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const handle: FileHandle = await open(destination, 'wx', expected.executable ? 0o755 : 0o644)
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of await source(path)) {
      bytes += chunk.length
      if (bytes > expected.bytes)
        throw new UpdateError('integrity', `${path} exceeds its declared ${expected.bytes} bytes`)
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (bytes !== expected.bytes)
    throw new UpdateError(
      'integrity',
      `${path} is incomplete: ${bytes} of ${expected.bytes} bytes received`
    )
  if (hash.digest('hex') !== expected.sha256)
    throw new UpdateError('integrity', `${path} does not match its signed digest`)
  if (expected.executable && process.platform !== 'win32') await chmod(destination, 0o755)
}

/** Re-hash a release directory against its recorded inventory. */
async function verifyRelease(root: string, release: Release): Promise<void> {
  for (const [path, expected] of Object.entries(release.files)) {
    let actual: FileDigest
    try {
      actual = await fileDigest(join(root, release.directory, path))
    } catch {
      throw new UpdateError('integrity', `${release.directory}/${path} is missing`)
    }
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new UpdateError('integrity', `${release.directory}/${path} was modified`)
  }
}

/**
 * Download, verify and atomically activate a verified update.
 * Until state.json is renamed the previous release stays current; afterwards the
 * prior release is retained for rollback. `onPhase` is a test/diagnostic hook.
 */
export async function install(
  root: string,
  update: VerifiedUpdate,
  source: PayloadSource,
  options: { onPhase?: (phase: InstallPhase) => void | Promise<void> } = {}
): Promise<InstallationState> {
  const { manifest } = update
  const directory = await prepare(root)
  const unlock = await lock(directory)
  try {
    const state = await readState(directory)
    await sweep(directory, state)
    await options.onPhase?.('locked')
    if (state && state.product !== manifest.product)
      throw new UpdateError('state', `Installation belongs to ${state.product}`)
    if (state && manifest.sequence <= state.current.sequence)
      throw new UpdateError(
        'downgrade',
        `Update sequence ${manifest.sequence} does not advance ${state.current.sequence}`
      )
    const id = `${manifest.version}-${manifest.sequence}-${update.manifestSha256.slice(0, 12)}`
    const release: Release = {
      directory: `versions/${id}`,
      version: manifest.version,
      sequence: manifest.sequence,
      manifestSha256: update.manifestSha256,
      trust: update.trust,
      files: manifest.files,
    }
    if (state?.previous?.directory === release.directory)
      throw new UpdateError('state', 'This release is already retained; use rollback')
    const staging = join(directory, 'staging', `${id}.${randomBytes(6).toString('hex')}`)
    await mkdir(staging)
    try {
      for (const [path, file] of Object.entries(manifest.files))
        await download(source, path, file, join(staging, path))
      await options.onPhase?.('downloaded')
      await verifyBuildManifest(staging, manifest)
      await syncDirectory(staging)
      await options.onPhase?.('staged')
      await rename(staging, join(directory, release.directory))
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    await syncDirectory(join(directory, 'versions'))
    await options.onPhase?.('promoted')
    const next: InstallationState = {
      schemaVersion: 1,
      product: manifest.product,
      current: release,
      previous: state?.current ?? null,
    }
    await writeState(directory, next)
    await options.onPhase?.('committed')
    await sweep(directory, next)
    return next
  } finally {
    await unlock()
  }
}

/** Swap back to the retained release after re-verifying its files. Data is untouched. */
export async function rollback(root: string): Promise<InstallationState> {
  const directory = await prepare(root)
  const unlock = await lock(directory)
  try {
    const state = await readState(directory)
    await sweep(directory, state)
    if (!state?.previous) throw new UpdateError('state', 'No previous release is retained')
    await verifyRelease(directory, state.previous)
    const next: InstallationState = { ...state, current: state.previous, previous: state.current }
    await writeState(directory, next)
    return next
  } finally {
    await unlock()
  }
}

/** Resolve the committed current release directory for a launcher. */
export async function currentRelease(
  root: string
): Promise<{ directory: string; release: Release }> {
  const state = await readState(root)
  if (!state) throw new UpdateError('state', 'Nothing is installed')
  const path = join(resolve(root), state.current.directory)
  if (!(await stat(path).catch(() => undefined))?.isDirectory())
    throw new UpdateError('integrity', 'The current release directory is missing')
  return { directory: path, release: state.current }
}
