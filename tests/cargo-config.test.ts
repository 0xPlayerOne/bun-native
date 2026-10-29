import { expect, test } from 'bun:test'
import { basename, dirname, resolve, win32 } from 'node:path'
import { cargoEnvironment } from '../scripts/cargo-config.ts'

test('separates local Cargo outputs while retaining the shared versioned CEF path', () => {
  const result = cargoEnvironment(
    ['+1.91.0', 'check', '--manifest-path', resolve('native/cef-host/Cargo.toml')],
    {},
    'darwin',
    '/Users/dev',
    '156.0.0+156.0.7'
  )
  expect(dirname(result.targetDir!)).toBe('/Users/dev/Library/Caches/Bunly/cargo-target/workspaces')
  expect(basename(result.targetDir!)).toMatch(/^[a-f0-9]{64}$/)
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

test('program arguments cannot select a different Cargo output namespace or CEF SDK', () => {
  const ordinary = cargoEnvironment([], {})
  const program = cargoEnvironment(
    ['run', '--', '--manifest-path', '/missing/native/cef-host/Cargo.toml'],
    {}
  )
  expect(program.targetDir).toBe(ordinary.targetDir)
  expect(program.env.CEF_PATH).toBeUndefined()
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

test('CI retains workspace-local Cargo defaults unless an explicit override opts in', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const result = cargoEnvironment(
      ['--manifest-path=native/cef-host/Cargo.toml'],
      { CI: 'true' },
      platform
    )
    expect(result.targetDir).toBeUndefined()
    expect(result.env.CARGO_TARGET_DIR).toBeUndefined()
    expect(result.env.CEF_PATH).toBeUndefined()
  }
  expect(cargoEnvironment([], { CI: 'true', CARGO_TARGET_DIR: '/private/target' }).targetDir).toBe(
    '/private/target'
  )
  expect(
    dirname(
      cargoEnvironment([], { CI: 'true', BUNLY_SHARED_CACHE_DIR: '/explicit/cache' }, 'linux')
        .targetDir!
    )
  ).toBe('/explicit/cache/cargo-target/workspaces')
  expect(dirname(cargoEnvironment([], { CI: 'false' }, 'linux', '/home/dev').targetDir!)).toBe(
    '/home/dev/.cache/bunly/cargo-target/workspaces'
  )
  expect(
    win32.dirname(cargoEnvironment([], { BUNLY_SHARED_CACHE_DIR: 'C:\\cache' }, 'win32').targetDir!)
  ).toBe('C:\\cache\\cargo-target\\workspaces')
})
