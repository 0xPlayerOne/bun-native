import { randomBytes, createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
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
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileDigest, type FileDigest } from './artifact.ts'
import { packagePath } from './paths.ts'
import {
  assertKeySetSuccessor,
  assertReleaseTrusted,
  decodeKeySet,
  rotateKeySet,
  type KeySet,
} from './update-keys.ts'
import {
  maximumFileBytes,
  maximumFiles,
  UpdateError,
  verifyBuildManifest,
  type UpdateFile,
  type VerifiedTrust,
  type VerifiedUpdate,
} from './update-manifest.ts'

/**
 * Installation root layout (all updater-owned except data/):
 *   state.json   committed pointer to the current and previous release
 *   current      derived one-line copy of the current release directory for launchers
 *   bin/         generated launchers
 *   integration.json  external menu entries/bundles created for this installation
 *   keys.json    accepted update key set after a rotation (docs/update-lifecycle.md)
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

/** The current release awaits a health confirmation; see docs/update-lifecycle.md. */
export type HealthCheck = { status: 'pending'; attempts: number; limit: number }

/** The last release rolled back automatically; installs must advance past its sequence. */
export type FailedRelease = {
  version: string
  sequence: number
  manifestSha256: string
  reason: 'failed' | 'unconfirmed'
}

export type InstallationState = {
  schemaVersion: 1
  product: string
  current: Release
  previous: Release | null
  /** Absent in states written before health checks existed; null means confirmed. */
  health: HealthCheck | null
  failed: FailedRelease | null
}

export const maximumHealthAttempts = 16

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
const pointerFile = 'current'
const integrationFile = 'integration.json'
const keysFile = 'keys.json'
const ownedFiles = [stateFile, pointerFile, integrationFile, keysFile]

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
      // A lock removed by its owner meanwhile reads as an error message, i.e. no owner.
      const owner = Number.parseInt(await readFile(path, 'utf8').catch(String), 10)
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

const sha256Pattern = /^[0-9a-f]{64}$/

function validFile(file: UpdateFile | undefined): boolean {
  return (
    Number.isSafeInteger(file?.bytes) &&
    file!.bytes >= 0 &&
    file!.bytes <= maximumFileBytes &&
    typeof file!.sha256 === 'string' &&
    sha256Pattern.test(file!.sha256) &&
    typeof file!.executable === 'boolean'
  )
}

function parseRelease(value: unknown): Release {
  const release = value as Release
  if (
    typeof release?.directory !== 'string' ||
    !/^versions\/(?!\.+$)[0-9A-Za-z.-]+$/.test(release.directory) ||
    typeof release.version !== 'string' ||
    !Number.isSafeInteger(release.sequence) ||
    !sha256Pattern.test(release.manifestSha256) ||
    (release.trust?.kind !== 'ed25519' && release.trust?.kind !== 'unsigned-experimental') ||
    (release.trust.kind === 'ed25519' && !/^[0-9a-f]{16}$/.test(release.trust.key)) ||
    release.files === null ||
    typeof release.files !== 'object' ||
    Array.isArray(release.files) ||
    Object.keys(release.files).length > maximumFiles ||
    !Object.entries(release.files).every(([path, file]) => packagePath(path) && validFile(file))
  )
    throw new UpdateError('state', 'Installation state has an invalid release record')
  return release
}

function parseHealth(value: unknown): HealthCheck | null {
  if (value === undefined || value === null) return null
  const health = value as HealthCheck
  if (
    Object.keys(health).length !== 3 ||
    health.status !== 'pending' ||
    !Number.isSafeInteger(health.limit) ||
    health.limit < 1 ||
    health.limit > maximumHealthAttempts ||
    !Number.isSafeInteger(health.attempts) ||
    health.attempts < 0 ||
    health.attempts > health.limit
  )
    throw new UpdateError('state', 'Installation state has an invalid health record')
  return { status: 'pending', attempts: health.attempts, limit: health.limit }
}

function parseFailed(value: unknown): FailedRelease | null {
  if (value === undefined || value === null) return null
  const failed = value as FailedRelease
  if (
    Object.keys(failed).length !== 4 ||
    typeof failed.version !== 'string' ||
    !Number.isSafeInteger(failed.sequence) ||
    typeof failed.manifestSha256 !== 'string' ||
    !sha256Pattern.test(failed.manifestSha256) ||
    (failed.reason !== 'failed' && failed.reason !== 'unconfirmed')
  )
    throw new UpdateError('state', 'Installation state has an invalid failed-release record')
  return { ...failed }
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
  const state: InstallationState = {
    schemaVersion: 1,
    product: value.product,
    current: parseRelease(value.current),
    previous: value.previous === null ? null : parseRelease(value.previous),
    health: parseHealth(value.health),
    failed: parseFailed(value.failed),
  }
  if (state.health && !state.previous)
    throw new UpdateError('state', 'A release awaiting its health check needs a retained release')
  return state
}

async function writeAtomic(root: string, name: string, text: string): Promise<void> {
  const temporary = join(root, `${name}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, join(root, name))
  await syncDirectory(root)
}

/**
 * Commit point: write a complete state file, then atomically rename it into place.
 * `current` is a derived one-line pointer for shell launchers. A crash between the
 * two renames leaves it naming the retained previous release until the next sweep.
 */
async function writeState(root: string, state: InstallationState): Promise<void> {
  await writeAtomic(root, stateFile, JSON.stringify(state, null, 2) + '\n')
  await writeAtomic(root, pointerFile, `${state.current.directory}\n`)
}

/** Remove uncommitted staging, temporary state and unreferenced release directories. */
async function sweep(root: string, state: InstallationState | null): Promise<string[]> {
  const removed: string[] = []
  const keep = new Set([state?.current.directory, state?.previous?.directory])
  for (const name of await readdir(join(root, 'staging'))) {
    await rm(join(root, 'staging', name), { recursive: true, force: true })
    removed.push(`staging/${name}`)
  }
  for (const name of await readdir(join(root, 'versions')))
    if (!keep.has(`versions/${name}`)) {
      await rm(join(root, 'versions', name), { recursive: true, force: true })
      removed.push(`versions/${name}`)
    }
  for (const name of await readdir(root))
    if (name.endsWith('.tmp') && ownedFiles.some((owned) => name.startsWith(`${owned}.`))) {
      await rm(join(root, name), { force: true })
      removed.push(name)
    }
  const pointer = await readFile(join(root, pointerFile), 'utf8').catch(String)
  if (!state) await rm(join(root, pointerFile), { force: true })
  else if (pointer !== `${state.current.directory}\n`)
    await writeAtomic(root, pointerFile, `${state.current.directory}\n`)
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
  return locked(root, async (directory) => sweep(directory, await readState(directory)))
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
export async function verifyRelease(root: string, release: Release): Promise<void> {
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
  options: {
    onPhase?: (phase: InstallPhase) => void | Promise<void>
    /** Activate the release as pending-health with this many unconfirmed starts allowed. */
    health?: { limit: number }
  } = {}
): Promise<InstallationState> {
  const { manifest } = update
  const limit = options.health?.limit
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumHealthAttempts)
  )
    throw new UpdateError('state', `Health check limit must be 1 to ${maximumHealthAttempts}`)
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
    if (state?.health)
      throw new UpdateError(
        'state',
        `Release ${state.current.version} is awaiting its health check; confirm it or roll back`
      )
    if (state?.failed && manifest.sequence <= state.failed.sequence)
      throw new UpdateError(
        'downgrade',
        `Update sequence ${manifest.sequence} does not advance failed release ${state.failed.sequence}`
      )
    if (limit !== undefined && !state)
      throw new UpdateError('state', 'A health check needs an installed release to fall back to')
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
      health: limit === undefined ? null : { status: 'pending', attempts: 0, limit },
      failed: state?.failed ?? null,
    }
    await writeState(directory, next)
    await options.onPhase?.('committed')
    await sweep(directory, next)
    return next
  } finally {
    await unlock()
  }
}

/**
 * Swap back to the retained release after re-verifying its files. Data is untouched.
 * With `keys`, a retained release from a revoked signer or below the minimum is refused.
 * A manual rollback also ends a pending health check.
 */
export async function rollback(
  root: string,
  options: { keys?: KeySet } = {}
): Promise<InstallationState> {
  const next = await transition(root, async (directory, state) => {
    if (!state?.previous) throw new UpdateError('state', 'No previous release is retained')
    await verifyRelease(directory, state.previous)
    if (options.keys) assertReleaseTrusted(options.keys, state.previous)
    return { ...state, current: state.previous, previous: state.current, health: null }
  })
  return next!
}

/**
 * Locked state transition: recover interrupted work, then atomically commit the state that
 * `change` returns. Returning the given state commits nothing. `onCommitted` is a test hook.
 */
export async function transition(
  root: string,
  change: (directory: string, state: InstallationState | null) => Promise<InstallationState | null>,
  onCommitted?: () => void | Promise<void>
): Promise<InstallationState | null> {
  return locked(root, async (directory) => {
    const state = await readState(directory)
    await sweep(directory, state)
    const next = await change(directory, state)
    if (next === state || !next) return state
    await writeState(directory, next)
    await onCommitted?.()
    await sweep(directory, next)
    return next
  })
}

/** Resolve the committed current release directory for a launcher. */
export async function currentRelease(
  root: string
): Promise<{ directory: string; release: Release }> {
  const state = await readState(root)
  if (!state) throw new UpdateError('state', 'Nothing is installed')
  const path = join(resolve(root), state.current.directory)
  let directory = false
  try {
    directory = (await stat(path)).isDirectory()
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error
  }
  if (!directory) throw new UpdateError('integrity', 'The current release directory is missing')
  return { directory: path, release: state.current }
}

/** Strictly read the persisted key set, or null before any rotation. */
export async function readKeySet(root: string): Promise<KeySet | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(join(resolve(root), keysFile))
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
  try {
    return decodeKeySet(bytes)
  } catch (error) {
    throw new UpdateError('state', `Stored key set is invalid (${(error as Error).message})`)
  }
}

const canonicalKeySet = (keys: KeySet) => JSON.stringify(keys)

/**
 * The effective key set: the persisted one or the caller's bootstrap set, whichever has the
 * higher version. The newer set must be a valid successor of the older one, and two
 * different sets with the same version are a conflict.
 */
export async function trustedKeySet(root: string, bootstrap: KeySet): Promise<KeySet> {
  const stored = await readKeySet(root)
  if (!stored) return bootstrap
  if (stored.version > bootstrap.version) {
    assertKeySetSuccessor(bootstrap, stored)
    return stored
  }
  if (stored.version < bootstrap.version) {
    assertKeySetSuccessor(stored, bootstrap)
    return bootstrap
  }
  if (canonicalKeySet(stored) !== canonicalKeySet(bootstrap))
    throw new UpdateError(
      'state',
      `Stored key set conflicts with the bootstrap key set at version ${stored.version}`
    )
  return stored
}

/** Accept a rotation signed by a currently trusted key and persist it atomically. */
export async function acceptKeySet(
  root: string,
  bootstrap: KeySet,
  bytes: Uint8Array,
  signature: Uint8Array | undefined
): Promise<KeySet> {
  return locked(root, async (directory) => {
    const next = rotateKeySet(await trustedKeySet(directory, bootstrap), bytes, signature)
    await writeAtomic(directory, keysFile, JSON.stringify(next, null, 2) + '\n')
    return next
  })
}

async function locked<T>(root: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await prepare(root)
  const unlock = await lock(directory)
  try {
    return await run(directory)
  } finally {
    await unlock()
  }
}

export async function integrationPaths(root: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(resolve(root), integrationFile), 'utf8')
  } catch (error) {
    if (code(error) === 'ENOENT') return []
    throw error
  }
  const paths = (JSON.parse(text) as { paths?: unknown }).paths
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string' && isAbsolute(path)))
    throw new UpdateError('state', 'Integration record is invalid')
  return paths as string[]
}

/** Record external files created for an installed product so uninstall removes exactly them. */
export async function recordIntegration(root: string, paths: readonly string[]): Promise<void> {
  await locked(root, async (directory) => {
    if (!(await readState(directory))) throw new UpdateError('state', 'Nothing is installed')
    const all = [...new Set([...(await integrationPaths(directory)), ...paths])].sort()
    await writeAtomic(directory, integrationFile, JSON.stringify({ paths: all }, null, 2) + '\n')
  })
}

export type UninstallPhase = 'locked' | 'detached' | 'committed'

/**
 * Remove integrations, then state.json (the commit point), then releases and launchers.
 * User data is kept unless `purgeData` is set. Rerunning after an interruption completes it.
 */
export async function uninstall(
  root: string,
  options: { purgeData?: boolean; onPhase?: (phase: UninstallPhase) => void | Promise<void> } = {}
): Promise<{ removed: string[]; data: 'kept' | 'removed' }> {
  const directory = resolve(root)
  if (!existsSync(directory)) throw new UpdateError('state', 'Nothing is installed')
  const removed = await locked(directory, async () => {
    await readState(directory)
    await options.onPhase?.('locked')
    const paths = await integrationPaths(directory)
    for (const path of paths) await rm(path, { recursive: true, force: true })
    await options.onPhase?.('detached')
    await rm(join(directory, integrationFile), { force: true })
    await rm(join(directory, stateFile), { force: true })
    await syncDirectory(directory)
    await options.onPhase?.('committed')
    await sweep(directory, null)
    await rm(join(directory, keysFile), { force: true })
    await rm(join(directory, 'bin'), { recursive: true, force: true })
    await rm(join(directory, 'health'), { recursive: true, force: true })
    for (const name of ['versions', 'staging']) await rm(join(directory, name), { recursive: true })
    if (options.purgeData) await rm(join(directory, 'data'), { recursive: true, force: true })
    return paths
  })
  if (options.purgeData) await rm(directory, { recursive: true, force: true })
  return { removed, data: options.purgeData ? 'removed' : 'kept' }
}
