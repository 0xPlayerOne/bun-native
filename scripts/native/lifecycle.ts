import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  dataDirectory,
  readState,
  transition,
  verifyRelease,
  type FailedRelease,
  type InstallationState,
  type Release,
} from './installation.ts'
import { packagePath } from './paths.ts'
import { assertReleaseTrusted, type KeySet } from './update-keys.ts'
import { UpdateError } from './update-manifest.ts'

/**
 * Experimental launcher contract and health-checked activation; see docs/update-lifecycle.md.
 *
 * A release installed with `install(..., { health: { limit } })` starts as pending-health.
 * Every `launch` of a pending release first commits one more start attempt; the application
 * confirms itself with `confirmHealthy`. When `limit` starts went unconfirmed, or the
 * application calls `reportUnhealthy`, the installation falls back to the retained release
 * through the same atomic state.json commit as `rollback`, and the failed release is dropped.
 */
export type LifecyclePhase = 'locked' | 'verified' | 'committed'

export type LifecycleOptions = {
  /** Refuse releases from revoked signers or below the key set's minimum sequence. */
  keys?: KeySet
  onPhase?: (phase: LifecyclePhase) => void | Promise<void>
}

export type Launch = {
  /** Absolute path of the verified application executable to start. */
  executable: string
  /** Absolute path of the verified release directory. */
  directory: string
  /** Value for BUN_NATIVE_DATA_DIR. */
  data: string
  release: Release
  health: { status: 'confirmed' } | { status: 'pending'; attempt: number; limit: number }
  /** Set when this launch rolled back an unconfirmed release before resolving. */
  rolledBack: FailedRelease | null
}

function requireInstalled(state: InstallationState | null): InstallationState {
  if (!state) throw new UpdateError('state', 'Nothing is installed')
  return state
}

function requireCurrent(state: InstallationState, manifestSha256: string): void {
  if (state.current.manifestSha256 !== manifestSha256)
    throw new UpdateError(
      'state',
      `Release ${manifestSha256.slice(0, 12)} is not the current release ${state.current.version}`
    )
}

/** Fall back from a pending release to the retained one, which is re-verified first. */
async function fallBack(
  directory: string,
  state: InstallationState,
  reason: FailedRelease['reason'],
  options: LifecycleOptions
): Promise<InstallationState> {
  const previous = state.previous
  if (!previous)
    throw new UpdateError('state', `Release ${state.current.version} failed with nothing retained`)
  await verifyRelease(directory, previous)
  if (options.keys) assertReleaseTrusted(options.keys, previous)
  await options.onPhase?.('verified')
  const { version, sequence, manifestSha256 } = state.current
  return {
    ...state,
    current: previous,
    previous: null,
    health: null,
    failed: { version, sequence, manifestSha256, reason },
  }
}

/** The application executable named by the release's own verified build manifest. */
async function applicationOf(directory: string, release: Release): Promise<string> {
  const recorded = release.files['manifest.json']
  let bytes: Buffer | undefined
  try {
    bytes = await readFile(join(directory, 'manifest.json'))
  } catch {
    // Removed after verification: reported below as a modified manifest.
  }
  if (
    !recorded ||
    !bytes ||
    bytes.length !== recorded.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== recorded.sha256
  )
    throw new UpdateError('integrity', `${release.directory}/manifest.json was modified`)
  let build: { application?: { file?: unknown; sha256?: unknown } }
  try {
    build = JSON.parse(bytes.toString('utf8')) as typeof build
  } catch {
    throw new UpdateError('integrity', 'Build manifest is not JSON')
  }
  const file = build?.application?.file
  const entry = packagePath(file) && Object.hasOwn(release.files, file) && release.files[file]
  if (!entry || !entry.executable || entry.sha256 !== build.application?.sha256)
    throw new UpdateError('integrity', 'Build manifest names no recorded application executable')
  const path = join(directory, file as string)
  let mode = 0
  try {
    mode = (await stat(path)).mode
  } catch {
    // Removed after verification: reported below as not executable.
  }
  if (process.platform !== 'win32' && !(mode & 0o100))
    throw new UpdateError('integrity', `${release.directory}/${file as string} is not executable`)
  return path
}

/**
 * Resolve exactly what to start: read state.json, advance or resolve a pending health check,
 * re-hash every file of the current release against its recorded digests and return the
 * application named by its build manifest. Refusals are UpdateErrors: `state` (nothing
 * installed, invalid state, failed with nothing retained), `integrity` (missing or modified
 * files) and, with `keys`, `untrusted`/`downgrade`. A confirmed release is resolved without
 * the installation lock, so a running update does not block a start.
 */
export async function launch(root: string, options: LifecycleOptions = {}): Promise<Launch> {
  const base = resolve(root)
  let state = requireInstalled(await readState(base))
  let rolledBack: FailedRelease | null = null
  if (state.health) {
    const pending = state.current.manifestSha256
    state = requireInstalled(
      await transition(
        base,
        async (directory, locked) => {
          const current = requireInstalled(locked)
          await options.onPhase?.('locked')
          if (!current.health) return current
          if (current.health.attempts < current.health.limit)
            return {
              ...current,
              health: { ...current.health, attempts: current.health.attempts + 1 },
            }
          return fallBack(directory, current, 'unconfirmed', options)
        },
        () => options.onPhase?.('committed')
      )
    )
    if (state.failed?.manifestSha256 === pending && state.current.manifestSha256 !== pending)
      rolledBack = state.failed
  }
  if (options.keys) assertReleaseTrusted(options.keys, state.current)
  const directory = join(base, state.current.directory)
  await verifyRelease(base, state.current)
  return {
    executable: await applicationOf(directory, state.current),
    directory,
    data: dataDirectory(base),
    release: state.current,
    health: state.health
      ? { status: 'pending', attempt: state.health.attempts, limit: state.health.limit }
      : { status: 'confirmed' },
    rolledBack,
  }
}

/** The running release reports a successful health check. Idempotent once confirmed. */
export async function confirmHealthy(
  root: string,
  manifestSha256: string
): Promise<InstallationState> {
  const state = await transition(root, async (_directory, locked) => {
    const current = requireInstalled(locked)
    requireCurrent(current, manifestSha256)
    return current.health ? { ...current, health: null } : current
  })
  return state!
}

/** The running pending release reports a failed health check; fall back immediately. */
export async function reportUnhealthy(
  root: string,
  manifestSha256: string,
  options: LifecycleOptions = {}
): Promise<InstallationState> {
  const state = await transition(
    root,
    async (directory, locked) => {
      const current = requireInstalled(locked)
      requireCurrent(current, manifestSha256)
      if (!current.health)
        throw new UpdateError(
          'state',
          `Release ${current.current.version} is already confirmed healthy; use rollback`
        )
      await options.onPhase?.('locked')
      return fallBack(directory, current, 'failed', options)
    },
    () => options.onPhase?.('committed')
  )
  return state!
}
