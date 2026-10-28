import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cargoEnvironment, nativeReleaseDirectory } from '../scripts/cargo-config.ts'

test('shares Cargo target and CEF paths across macOS worktrees', () => {
  const result = cargoEnvironment(
    ['+1.91.0', 'check', '--manifest-path', '/repo/native/cef-host/Cargo.toml'],
    {},
    'darwin',
    '/Users/dev',
    '156.0.0+156.0.7'
  )
  expect(result.targetDir).toBe('/Users/dev/Library/Caches/Bunly/cargo-target')
  expect(result.env.CEF_PATH).toBe('/Users/dev/Library/Caches/Bunly/cef/156.0.0+156.0.7')
  expect(result.env.CARGO_TARGET_DIR).toBe(result.targetDir)
})

test('respects explicit shared cache, target, and CEF overrides', () => {
  const result = cargoEnvironment(
    ['check', '--manifest-path=native/cef-host/Cargo.toml'],
    {
      BUNLY_SHARED_CACHE_DIR: '/shared/bunly',
      CARGO_TARGET_DIR: '/fast/cargo-target',
      CEF_PATH: '/vendor/cef',
    },
    'linux',
    '/home/dev'
  )
  expect(result.targetDir).toBe('/fast/cargo-target')
  expect(result.env.CEF_PATH).toBe('/vendor/cef')
})

test('uses platform cache conventions and rejects relative shared cache overrides', () => {
  expect(cargoEnvironment([], {}, 'linux', '/home/dev').cacheRoot).toBe('/home/dev/.cache/bunly')
  expect(
    cargoEnvironment([], { XDG_CACHE_HOME: '/var/cache/dev' }, 'linux', '/home/dev').cacheRoot
  ).toBe('/var/cache/dev/bunly')
  expect(
    cargoEnvironment(
      [],
      { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      'win32',
      'C:\\Users\\dev'
    ).cacheRoot
  ).toBe('C:\\Users\\dev\\AppData\\Local\\Bunly\\Cache')
  expect(() =>
    cargoEnvironment([], { BUNLY_SHARED_CACHE_DIR: 'relative/cache' }, 'linux', '/home/dev')
  ).toThrow('BUNLY_SHARED_CACHE_DIR must be an absolute path')
  expect(() =>
    cargoEnvironment(['--manifest-path=native/cef-host/Cargo.toml'], {}, 'linux', '/home/dev')
  ).toThrow('A valid locked CEF package version is required for the shared CEF path')
})

test('native qualification finds artifacts in the shared target or direct Cargo target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-cargo-target-'))
  const shared = join(root, 'shared', 'cargo-target', 'release')
  const direct = join(root, 'repo', 'native', 'target', 'release')
  const env = { BUNLY_SHARED_CACHE_DIR: join(root, 'shared') }
  try {
    await mkdir(shared, { recursive: true })
    await mkdir(direct, { recursive: true })
    await writeFile(join(direct, 'probe.node'), '')
    await writeFile(join(direct, 'process-soak'), '')
    expect(await nativeReleaseDirectory(join(root, 'repo'), ['probe.node'], env, 'linux')).toBe(
      direct
    )
    await writeFile(join(shared, 'probe.node'), '')
    expect(await nativeReleaseDirectory(join(root, 'repo'), ['probe.node'], env, 'linux')).toBe(
      shared
    )
    await rm(join(shared, 'probe.node'))
    expect(
      await nativeReleaseDirectory(join(root, 'repo'), ['probe.node', 'process-soak'], env, 'linux')
    ).toBe(direct)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
