import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readKeySet } from './installation.ts'
import { confirmHealthy, launch } from './lifecycle.ts'
import { UpdateError } from './update-manifest.ts'
import type { KeySet } from './update-keys.ts'

/**
 * Verified start of an installed release; see docs/update-lifecycle.md. `launch` advances
 * a pending health check, re-hashes the current release and names its application. The
 * application then runs with these variables:
 *
 * - `BUN_NATIVE_DATA_DIR`: the preserved user data directory
 * - `BUN_NATIVE_INSTALL_ROOT`: the installation root
 * - `BUN_NATIVE_RELEASE`: the manifest SHA-256 that `confirm` and `report-unhealthy` take
 * - `BUN_NATIVE_HEALTH_FILE`: only while the release awaits its health check; the
 *   application's `reportHealthy()` writes the release there and the launcher confirms it
 *
 * Without explicit `keys`, the key set persisted by an accepted rotation applies when there
 * is one. Returns the application's exit code, or 128 plus the signal number.
 */
const pollInterval = 200
/** Polls after exit while another updater operation holds the lock: about 5 seconds. */
const exitRetries = 25

export async function runVerified(
  root: string,
  args: readonly string[],
  keys?: KeySet
): Promise<number> {
  const base = resolve(root)
  const effective = keys ?? (await readKeySet(base))
  const resolved = await launch(base, effective ? { keys: effective } : {})
  if (resolved.rolledBack)
    console.error(
      `Rolled back release ${resolved.rolledBack.version} (${resolved.rolledBack.reason}); starting ${resolved.release.version}`
    )
  const release = resolved.release.manifestSha256
  // Each launch owns a fresh mailbox, so a concurrent start of the same release can never
  // erase another launch's report.
  const health =
    resolved.health.status === 'pending'
      ? join(base, 'health', `${release}.${randomBytes(8).toString('hex')}`)
      : undefined
  if (health) await mkdir(dirname(health), { recursive: true })
  const { BUN_NATIVE_HEALTH_FILE: _inherited, ...environment } = process.env
  const child = Bun.spawn([resolved.executable, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...environment,
      BUN_NATIVE_DATA_DIR: resolved.data,
      BUN_NATIVE_INSTALL_ROOT: base,
      BUN_NATIVE_RELEASE: release,
      ...(health ? { BUN_NATIVE_HEALTH_FILE: health } : {}),
    },
  })
  // 'confirmed' only after a durable confirmation; a transient failure keeps the report so a
  // later poll, or the retries after exit, try again. Attempts never overlap.
  let state: 'waiting' | 'confirmed' | 'failed' = 'waiting'
  let attempt: Promise<void> | undefined
  const confirm = (): Promise<void> => {
    attempt ??= confirmOnce().finally(() => (attempt = undefined))
    return attempt
  }
  const confirmOnce = async () => {
    if (!health || state !== 'waiting') return
    let reported = ''
    try {
      reported = (await readFile(health, 'utf8')).trim()
    } catch {
      return // Not reported yet.
    }
    if (reported !== release) return
    try {
      await confirmHealthy(base, release)
      state = 'confirmed'
      await rm(health, { force: true })
    } catch (error) {
      // Another updater operation holds the installation lock: retry on the next attempt.
      if (error instanceof UpdateError && error.code === 'busy') return
      state = 'failed'
      console.error(`Could not confirm release ${resolved.release.version}: ${String(error)}`)
    }
  }
  const poll = health ? setInterval(() => void confirm(), pollInterval) : undefined
  /** After exit: confirm a report, retrying a busy installation lock for a bounded time. */
  const settle = async () => {
    await confirm()
    if (!health || state !== 'waiting') return
    const reported = await readFile(health, 'utf8').then(
      (text) => text.trim() === release,
      () => false
    )
    if (!reported) return
    for (let retry = 0; retry < exitRetries && state === 'waiting'; retry++) {
      await Bun.sleep(pollInterval)
      await confirm()
    }
    if (state === 'waiting')
      console.error(
        `Could not confirm release ${resolved.release.version}: the installation stayed locked`
      )
  }
  // A terminal interrupt reaches the whole foreground group; a targeted stop is forwarded.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const stops = (['SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = forward(signal)
    if (process.platform !== 'win32') process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  try {
    const code = await child.exited
    clearInterval(poll)
    await settle()
    if (health) await rm(health, { force: true })
    const signal = child.signalCode as NodeJS.Signals | null
    return signal ? 128 + (constants.signals[signal] ?? 0) : code
  } finally {
    clearInterval(poll)
    for (const stop of stops) stop()
  }
}

// Compiled by `release-update.ts launcher` into `<root>/bin/<product>`, so the root is the
// directory above the executable's own directory.
if (import.meta.main) {
  try {
    process.exitCode = await runVerified(dirname(dirname(process.execPath)), process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
