import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

/**
 * Where this CLI runs from, computed once per invocation.
 *
 * - `checkout`: `scripts/native.ts` in a Bun Native checkout. The version is the
 *   workspace's root `package.json`; released hosts are cached in the checkout's
 *   `.bun-native/hosts`.
 * - `package`: the installed `@bun-native/cli`, whose sources live under `src/`.
 *   The version is the package's own manifest. Released hosts are cached in the
 *   consumer project's `.bun-native/hosts` (the directory that owns the outermost
 *   `node_modules`), never inside the digest-verified CLI package. A CLI run from
 *   outside any `node_modules` (the package-set bootstrap) uses the user cache.
 */
export type CliContext = {
  mode: 'checkout' | 'package'
  /** The directory that holds `scripts/native.ts`: the checkout root, or the package's `src`. */
  root: string
  /** Absent only for a bare copy of the CLI sources; host downloads then need --version. */
  version: string | undefined
  hostCache: string
  /** How the usage text spells this CLI. */
  command: string
}

type Environment = Record<string, string | undefined>

const packageCommand = 'bun --no-install ./node_modules/@bun-native/cli/src/scripts/native.ts'

async function manifest(path: string): Promise<{ name?: unknown; version?: unknown } | undefined> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.json() : undefined
}

/** The per-user cache for hosts that have no owning project. */
export function userHostCache(
  environment: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const base =
    environment['XDG_CACHE_HOME'] ||
    (platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? environment['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
        : join(home, '.cache'))
  return join(base, 'bun-native', 'hosts')
}

/** The consumer project that installed `packageRoot`, or undefined outside `node_modules`. */
export function owningProject(packageRoot: string): string | undefined {
  const parts = packageRoot.split(sep)
  const index = parts.indexOf('node_modules')
  return index > 0 ? parts.slice(0, index).join(sep) || sep : undefined
}

export async function cliContext(
  root: string,
  environment: Environment = process.env
): Promise<CliContext> {
  const packageRoot = dirname(root)
  const installed =
    basename(root) === 'src' ? await manifest(join(packageRoot, 'package.json')) : undefined
  if (installed?.name === '@bun-native/cli') {
    const project = owningProject(packageRoot)
    return {
      mode: 'package',
      root,
      version: typeof installed.version === 'string' ? installed.version : undefined,
      hostCache: project ? join(project, '.bun-native', 'hosts') : userHostCache(environment),
      command: packageCommand,
    }
  }
  const workspace = await manifest(join(root, 'package.json'))
  return {
    mode: 'checkout',
    root,
    version: typeof workspace?.version === 'string' ? workspace.version : undefined,
    hostCache: join(root, '.bun-native', 'hosts'),
    command: 'bun run native',
  }
}

/** The release version for host downloads: an explicit one, else this CLI's own. */
export function releaseVersion(context: CliContext, explicit?: string): string {
  const version = explicit ?? context.version
  if (version === undefined)
    throw new Error('This CLI has no package version; pass host install --version x.y.z')
  return version
}
