import { test, beforeAll, afterAll } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetPersistentSessionStorage } from '../packages/runtime/src/session-reset.ts'
import { removeSessionResetFixture } from './helpers/remove-session-reset-fixture.ts'
import type { PersistentSessionResetOptions } from '../packages/contracts/src/session-reset.ts'

let work: string, host: string, config: string, profile: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'bunly-reset-peer-'))
  const mac = process.platform === 'darwin'
  const directory = mac ? join(work, 'Test.app/Contents/MacOS') : join(work, 'native')
  const resources = mac ? join(work, 'Test.app/Contents/Resources') : join(directory, 'resources')
  await mkdir(directory, { recursive: true })
  await mkdir(resources, { recursive: true })
  host = join(directory, process.platform === 'win32' ? 'bunly_host.exe' : 'bunly_host')
  config = join(resources, 'runtime.json')
  profile = join(work, 'private-profile')
  await mkdir(profile, { mode: 0o700 })
  const child = Bun.spawn(
    [
      process.execPath,
      'build',
      '--compile',
      join(import.meta.dir, 'helpers/session-reset-peer.ts'),
      '--outfile',
      host,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  assert.equal(code, 0, output)
  await writeFile(
    config,
    JSON.stringify({
      schema: 1,
      protocol: 1,
      bun_version: '1.4.4',
      cef_version: 'fixture',
      maintenance_protocol: 1,
    })
  )
})
afterAll(async () => {
  if (!work) return
  // Every reset call already awaits its child's exit and both output streams.
  // Bound temporary-file cleanup retries; a persistent Windows filesystem lock
  // must still reject. This does not change native/application exit deadlines.
  await removeSessionResetFixture(work)
  await assert.rejects(lstat(work), { code: 'ENOENT' })
})
const options = (partition = 'success'): PersistentSessionResetOptions => ({
  hostExecutable: host,
  persistentRoot: profile,
  partition,
  confirmation: 'delete-entire-profile',
})

test('offline reset requires an exact structured native success receipt', async () => {
  const value = await resetPersistentSessionStorage(options())
  assert.equal(value.storageCleared, true)
  assert.equal(value.offline, true)
  assert.ok(Object.isFrozen(value))
  for (const partition of ['duplicate', 'malformed', 'wrong-partition', 'error'])
    await assert.rejects(resetPersistentSessionStorage(options(partition)))
})

test('offline reset validates explicit intent before starting native maintenance', async () => {
  for (const change of [
    { confirmation: 'yes' },
    { hostExecutable: './relative' },
    { persistentRoot: './relative' },
    { partition: '../outside' },
    { partition: 'a\0b' },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
  ])
    await assert.rejects(
      resetPersistentSessionStorage({ ...options(), ...change } as PersistentSessionResetOptions)
    )
  const signal = AbortSignal.abort(new Error('already-cancelled'))
  await assert.rejects(resetPersistentSessionStorage({ ...options(), signal }), /already-cancelled/)
})

test('older runtime metadata is rejected before a maintenance flag can start its app', async () => {
  const before = await readFile(config)
  try {
    await writeFile(config, JSON.stringify({ schema: 1, protocol: 1, bun_version: '1.4.4' }))
    await assert.rejects(resetPersistentSessionStorage(options()), {
      code: 'UNSUPPORTED_CAPABILITY',
    })
  } finally {
    await writeFile(config, before)
  }
})

test('offline reset cancels and bounds output without declaring a partial clear successful', async () => {
  await assert.rejects(resetPersistentSessionStorage({ ...options('hang'), timeoutMs: 100 }), {
    name: 'TimeoutError',
  })
  const controller = new AbortController()
  const call = resetPersistentSessionStorage({ ...options('hang'), signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(call, { name: 'AbortError' })
  } finally {
    clearTimeout(timer)
  }
  await assert.rejects(resetPersistentSessionStorage(options('overflow')), /output exceeded/)
})
