import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix, resolve, win32 } from 'node:path'

function manifestPath(args: readonly string[]) {
  const separator = args.indexOf('--')
  const options = separator < 0 ? args : args.slice(0, separator)
  const manifests = options.flatMap((arg, index) => {
    if (arg === '--manifest-path') return options[index + 1] ? [options[index + 1]!] : []
    return arg.startsWith('--manifest-path=') ? [arg.slice('--manifest-path='.length)] : []
  })
  return manifests[0]
}

export function cefManifestPath(args: readonly string[]) {
  const manifest = manifestPath(args)
  return manifest && /(?:^|[\\/])native[\\/]cef-host[\\/]Cargo\.toml$/.test(manifest)
    ? manifest
    : undefined
}

/** Build and metadata callers must select the same checkout-scoped outputs. */
export function cargoTargetEnvironment(
  manifest: string | undefined,
  current: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = homedir()
) {
  const path = platform === 'win32' ? win32 : posix
  const configured = current.BUNLY_SHARED_CACHE_DIR
  if (configured && !path.isAbsolute(configured))
    throw new Error('BUNLY_SHARED_CACHE_DIR must be an absolute path')

  const cacheRoot = configured
    ? configured
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'Bunly')
      : platform === 'win32'
        ? path.join(current.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Bunly', 'Cache')
        : path.join(current.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'bunly')
  // Cargo can consider another checkout's local package fresh in a shared
  // target, even during sequential tests. A canonical path namespace isolates
  // those outputs while staying stable across ordinary edits and branch changes.
  // Registry/git downloads and the versioned CEF distribution remain shared.
  const isolatedCi = Boolean(current.CI && !['false', '0'].includes(current.CI) && !configured)
  const targetDir =
    current.CARGO_TARGET_DIR ??
    (isolatedCi
      ? undefined
      : path.join(
          cacheRoot,
          'cargo-target',
          'workspaces',
          createHash('sha256')
            .update(
              realpathSync(manifest === undefined ? process.cwd() : dirname(resolve(manifest)))
            )
            .digest('hex')
        ))
  const env: NodeJS.ProcessEnv = {
    ...current,
    ...(targetDir === undefined ? {} : { CARGO_TARGET_DIR: targetDir }),
  }
  return { cacheRoot, targetDir, env, isolatedCi }
}

export function cargoEnvironment(
  args: readonly string[],
  current: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  cefVersion?: string
) {
  const { cacheRoot, targetDir, env, isolatedCi } = cargoTargetEnvironment(
    manifestPath(args),
    current,
    platform,
    home
  )
  if (cefManifestPath(args) && !env.CEF_PATH && !isolatedCi) {
    if (!cefVersion || !/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(cefVersion))
      throw new Error('A valid locked CEF package version is required for the shared CEF path')
    const path = platform === 'win32' ? win32 : posix
    env.CEF_PATH = path.join(cacheRoot, 'cef', cefVersion)
  }
  return { cacheRoot, targetDir, env }
}
