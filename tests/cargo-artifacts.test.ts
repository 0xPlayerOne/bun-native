import { expect, spyOn, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { cargoTargetDirectory, nativeHostArtifacts } from '../scripts/cargo-artifacts.ts'

function response(value: unknown, success = true) {
  return {
    success,
    exitCode: success ? 0 : 1,
    stdout: Buffer.from(JSON.stringify(value)),
    stderr: Buffer.from(''),
  } as ReturnType<typeof Bun.spawnSync>
}

test('native consumers query Cargo metadata with the same configured target instead of an old checkout path', () => {
  const target = resolve('selected-artifacts'),
    root = resolve('source-checkout')
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue(response({ target_directory: target }))
  try {
    const manifest = join(root, 'native/Cargo.toml')
    expect(cargoTargetDirectory(manifest, { CARGO_TARGET_DIR: target })).toBe(target)
    expect(spawn.mock.calls[0]![0]).toEqual([
      'cargo',
      'metadata',
      '--offline',
      '--locked',
      '--no-deps',
      '--format-version',
      '1',
      '--manifest-path',
      manifest,
    ])
    expect(spawn.mock.calls[0]![1]).toMatchObject({
      env: { CARGO_TARGET_DIR: target },
      stdin: 'ignore',
    })
    for (const [platform, library, suffix] of [
      ['linux', 'libbunly_host_probe.so', ''],
      ['darwin', 'libbunly_host_probe.dylib', ''],
      ['win32', 'bunly_host_probe.dll', '.exe'],
    ] as const) {
      expect(nativeHostArtifacts(root, {}, platform)).toEqual({
        library: join(target, 'release', library),
        hostProbe: join(target, 'release', 'bunly-host-probe' + suffix),
        processSoak: join(target, 'release', 'process-soak' + suffix),
        pdb: join(target, 'release', 'bunly_host_probe.pdb'),
      })
    }
    expect(spawn.mock.calls).toHaveLength(4)
  } finally {
    spawn.mockRestore()
  }
})

test('CI artifact lookup asks Cargo for its workspace directory without injecting a shared cache', () => {
  const target = resolve('workspace/native/target')
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue(response({ target_directory: target }))
  try {
    expect(cargoTargetDirectory(resolve('workspace/native/Cargo.toml'), { CI: 'true' })).toBe(
      target
    )
    expect(spawn.mock.calls[0]![1]).toMatchObject({ env: { CI: 'true' } })
    const options = spawn.mock.calls[0]![1] as { env: NodeJS.ProcessEnv }
    expect(options.env.CARGO_TARGET_DIR).toBeUndefined()
  } finally {
    spawn.mockRestore()
  }
})

test('explicit Cargo targets are rejected before looking up ordinary host probe artifacts', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue(
    response({ target_directory: resolve('selected-artifacts') })
  )
  try {
    for (const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-apple-darwin',
      'x86_64-pc-windows-msvc',
      '',
    ]) {
      expect(() =>
        nativeHostArtifacts(resolve('workspace'), {
          CARGO_TARGET_DIR: resolve('selected-artifacts'),
          BUNLY_SHARED_CACHE_DIR: resolve('shared-cache'),
          CARGO_BUILD_TARGET: target,
        })
      ).toThrow('M1 native probes require a host release build without CARGO_BUILD_TARGET')
    }
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
  }
})

test('missing or malformed artifact metadata fails without falling back to stale release files', () => {
  const spawn = spyOn(Bun, 'spawnSync')
  try {
    spawn.mockReturnValue(response({}, false))
    expect(() => nativeHostArtifacts(resolve('workspace'))).toThrow(
      'Cargo metadata could not locate native artifacts'
    )
    for (const value of [null, [], {}, { target_directory: '' }, { target_directory: 'target' }]) {
      spawn.mockReturnValue(response(value))
      expect(() => nativeHostArtifacts(resolve('workspace'))).toThrow()
    }
  } finally {
    spawn.mockRestore()
  }
})
