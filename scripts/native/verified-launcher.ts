import { constants } from 'node:os'
import { dirname, resolve } from 'node:path'
import { readKeySet } from './installation.ts'
import { launch } from './lifecycle.ts'
import type { KeySet } from './update-keys.ts'

/**
 * Verified start of an installed release; see docs/update-lifecycle.md. `launch` advances
 * a pending health check, re-hashes the current release and names its application. The
 * application then runs with these variables:
 *
 * - `BUN_NATIVE_DATA_DIR`: the preserved user data directory
 * - `BUN_NATIVE_INSTALL_ROOT`: the installation root
 * - `BUN_NATIVE_RELEASE`: the manifest SHA-256 that `confirm` and `report-unhealthy` take
 *
 * Without explicit `keys`, the key set persisted by an accepted rotation applies when there
 * is one. Returns the application's exit code, or 128 plus the signal number.
 */
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
  const child = Bun.spawn([resolved.executable, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      BUN_NATIVE_DATA_DIR: resolved.data,
      BUN_NATIVE_INSTALL_ROOT: base,
      BUN_NATIVE_RELEASE: resolved.release.manifestSha256,
    },
  })
  // A terminal interrupt reaches the whole foreground group; a targeted stop is forwarded.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const stops = (['SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = forward(signal)
    if (process.platform !== 'win32') process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  try {
    const code = await child.exited
    const signal = child.signalCode as NodeJS.Signals | null
    return signal ? 128 + (constants.signals[signal] ?? 0) : code
  } finally {
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
