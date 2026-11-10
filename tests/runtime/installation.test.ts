import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedRelease, reportHealthy } from '../../packages/runtime/src/installation.ts'

const names = [
  'BUN_NATIVE_DATA_DIR',
  'BUN_NATIVE_INSTALL_ROOT',
  'BUN_NATIVE_RELEASE',
  'BUN_NATIVE_HEALTH_FILE',
] as const
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const release = 'a'.repeat(64)
let directory: string | undefined

afterEach(async () => {
  for (const name of names)
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

function started(health?: string) {
  process.env['BUN_NATIVE_DATA_DIR'] = '/install/data'
  process.env['BUN_NATIVE_INSTALL_ROOT'] = '/install'
  process.env['BUN_NATIVE_RELEASE'] = release
  if (health) process.env['BUN_NATIVE_HEALTH_FILE'] = health
  else delete process.env['BUN_NATIVE_HEALTH_FILE']
}

test('an application not started by the verifying launcher has no installed release', async () => {
  for (const name of names) delete process.env[name]
  expect(installedRelease()).toBeUndefined()
  expect(await reportHealthy()).toBe(false)
  started()
  process.env['BUN_NATIVE_RELEASE'] = 'not-a-digest'
  expect(installedRelease()).toBeUndefined()
})

test('a confirmed release reports nothing; a pending one writes its digest', async () => {
  started()
  expect(installedRelease()).toEqual({
    dataDirectory: '/install/data',
    root: '/install',
    release,
    healthPending: false,
  })
  expect(await reportHealthy()).toBe(false)
  directory = await mkdtemp(join(tmpdir(), 'bun-native-health-'))
  const file = join(directory, release)
  started(file)
  expect(installedRelease()?.healthPending).toBe(true)
  expect(await reportHealthy()).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(release + '\n')
})
