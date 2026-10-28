import { homedir } from 'node:os'
import { isAbsolute, posix, win32 } from 'node:path'

export function cefManifestPath(args: readonly string[]) {
  const manifests = args.flatMap((arg, index) => {
    if (arg === '--manifest-path') return args[index + 1] ? [args[index + 1]!] : []
    return arg.startsWith('--manifest-path=') ? [arg.slice('--manifest-path='.length)] : []
  })
  return manifests.find((manifest) =>
    /(?:^|[\\/])native[\\/]cef-host[\\/]Cargo\.toml$/.test(manifest)
  )
}

export function cargoEnvironment(
  args: readonly string[],
  current: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  cefVersion?: string
) {
  const path = platform === 'win32' ? win32 : posix
  const configured = current.BUNLY_SHARED_CACHE_DIR
  if (configured && !isAbsolute(configured))
    throw new Error('BUNLY_SHARED_CACHE_DIR must be an absolute path')

  const cacheRoot = configured
    ? configured
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'Bunly')
      : platform === 'win32'
        ? path.join(current.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Bunly', 'Cache')
        : path.join(current.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'bunly')
  const targetDir = current.CARGO_TARGET_DIR ?? path.join(cacheRoot, 'cargo-target')
  const env: NodeJS.ProcessEnv = { ...current, CARGO_TARGET_DIR: targetDir }
  if (cefManifestPath(args) && !env.CEF_PATH) {
    if (!cefVersion || !/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(cefVersion))
      throw new Error('A valid locked CEF package version is required for the shared CEF path')
    env.CEF_PATH = path.join(cacheRoot, 'cef', cefVersion)
  }
  return { cacheRoot, targetDir, env }
}
