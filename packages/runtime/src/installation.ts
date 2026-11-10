import { writeFile } from 'node:fs/promises'

/**
 * The installed release this process was started as, from the variables that the verifying
 * launcher sets (see docs/update-lifecycle.md). Undefined when the application was not started
 * by that launcher, such as during development.
 */
export interface InstalledRelease {
  /** The preserved per-user data directory, kept across updates and rollbacks. */
  readonly dataDirectory: string
  /** The installation root. */
  readonly root: string
  /** The release's manifest SHA-256. */
  readonly release: string
  /** True while this release awaits its health check; see `reportHealthy`. */
  readonly healthPending: boolean
}

const sha256 = /^[0-9a-f]{64}$/

export function installedRelease(): InstalledRelease | undefined {
  const { BUN_NATIVE_DATA_DIR, BUN_NATIVE_INSTALL_ROOT, BUN_NATIVE_RELEASE } = process.env
  if (!BUN_NATIVE_DATA_DIR || !BUN_NATIVE_INSTALL_ROOT || !sha256.test(BUN_NATIVE_RELEASE ?? ''))
    return undefined
  return {
    dataDirectory: BUN_NATIVE_DATA_DIR,
    root: BUN_NATIVE_INSTALL_ROOT,
    release: BUN_NATIVE_RELEASE!,
    healthPending: Boolean(process.env['BUN_NATIVE_HEALTH_FILE']),
  }
}

/**
 * Report that this release passed the application's own health check, such as a first
 * window opening with its data loaded. The launcher then confirms the release, so a later
 * start no longer counts toward the automatic rollback. Returns false when no health check
 * is pending. Call it once the application is known to work; an update that never reports
 * is rolled back after its allowed starts.
 */
export async function reportHealthy(): Promise<boolean> {
  const installed = installedRelease()
  const file = process.env['BUN_NATIVE_HEALTH_FILE']
  if (!installed?.healthPending || !file) return false
  await writeFile(file, installed.release + '\n')
  return true
}
