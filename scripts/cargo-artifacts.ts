/** Contributor artifact lookup. Metadata never compiles native code. */
import { isAbsolute, join } from 'node:path'
import { cargoTargetEnvironment } from './cargo-config.ts'

export function cargoTargetDirectory(
  manifest: string,
  current: NodeJS.ProcessEnv = process.env
): string {
  // Target policy is independent of CEF SDK discovery. Metadata needs no SDK.
  const { env } = cargoTargetEnvironment(manifest, current)
  const result = Bun.spawnSync(
    [
      'cargo',
      'metadata',
      '--offline',
      '--locked',
      '--no-deps',
      '--format-version',
      '1',
      '--manifest-path',
      manifest,
    ],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 }
  )
  if (!result.success) throw new Error('Cargo metadata could not locate native artifacts')
  const metadata: unknown = JSON.parse(result.stdout.toString())
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Invalid Cargo artifact metadata')
  const target = (metadata as Record<string, unknown>)['target_directory']
  if (typeof target !== 'string' || !isAbsolute(target))
    throw new Error('Cargo artifact directory must be absolute')
  return target
}

/** These M1 probes require release/ artifacts from a build with no target selection. */
export function nativeHostArtifacts(
  root: string,
  current: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
) {
  if (current.CARGO_BUILD_TARGET !== undefined)
    throw new Error('M1 native probes require a host release build without CARGO_BUILD_TARGET')
  const release = join(cargoTargetDirectory(join(root, 'native/Cargo.toml'), current), 'release')
  const suffix = platform === 'win32' ? '.exe' : ''
  const library =
    platform === 'win32'
      ? 'bunly_host_probe.dll'
      : platform === 'darwin'
        ? 'libbunly_host_probe.dylib'
        : 'libbunly_host_probe.so'
  return Object.freeze({
    library: join(release, library),
    hostProbe: join(release, 'bunly-host-probe' + suffix),
    processSoak: join(release, 'process-soak' + suffix),
    pdb: join(release, 'bunly_host_probe.pdb'),
  })
}
