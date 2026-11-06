import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  dataDirectory,
  directorySource,
  install,
  readState,
  recover,
  rollback,
  type InstallationState,
} from '../../scripts/native/installation.ts'
import { confirmHealthy, launch, reportUnhealthy } from '../../scripts/native/lifecycle.ts'
import { verifyUpdate } from '../../scripts/native/update-manifest.ts'
import {
  clean,
  cleanup,
  installed,
  leftovers,
  rejects,
  release,
  repository,
  requirements,
  signed,
  temporary,
} from './update-fixture.ts'

const posix = process.platform !== 'win32'
/** Payloads live in per-test temporary directories, so the cache is per test too. */
const releases = new Map<number, Awaited<ReturnType<typeof release>>>()
afterEach(async () => {
  releases.clear()
  await cleanup()
})

async function payload(sequence: number) {
  if (!releases.has(sequence)) releases.set(sequence, await release(`r${sequence}`, sequence))
  return releases.get(sequence)!
}

async function put(root: string, sequence: number, health?: number) {
  const update = await payload(sequence)
  return install(
    root,
    verifyUpdate(update.bytes, update.signature, signed, requirements),
    directorySource(update.payload),
    health === undefined ? {} : { health: { limit: health } }
  )
}

async function state(root: string): Promise<InstallationState> {
  return (await readState(root))!
}

test('launch resolves the verified application executable of the committed release', async () => {
  const root = join(await temporary(), 'install')
  await rejects(launch(root), 'state')
  await put(root, 1)
  const resolved = await launch(root)
  const { current } = await state(root)
  const application = posix ? 'application' : 'application.exe'
  expect(resolved).toEqual({
    executable: join(root, current.directory, application),
    directory: join(root, current.directory),
    data: dataDirectory(root),
    release: current,
    health: { status: 'confirmed' },
    rolledBack: null,
  })
  expect(await readFile(resolved.executable, 'utf8')).toBe('application r1\n')

  // Any modified or missing recorded file refuses the start.
  const script = join(resolved.directory, 'development/application.js')
  const original = await readFile(script, 'utf8')
  await writeFile(script, 'evil\n')
  expect((await rejects(launch(root), 'integrity')).message).toBe(
    `integrity: ${current.directory}/development/application.js was modified`
  )
  await writeFile(script, original)
  await writeFile(resolved.executable, 'application rX\n')
  await rejects(launch(root), 'integrity')
  await writeFile(resolved.executable, 'application r1\n')
  if (posix) {
    await chmod(resolved.executable, 0o644)
    expect((await rejects(launch(root), 'integrity')).message).toContain('is not executable')
    await chmod(resolved.executable, 0o755)
  }
  expect((await launch(root)).executable).toBe(resolved.executable)

  // The executable must be the build manifest's application, recorded as executable.
  const text = await readFile(join(root, 'state.json'), 'utf8')
  const edited = JSON.parse(text) as InstallationState
  edited.current.files[application]!.executable = false
  await writeFile(join(root, 'state.json'), JSON.stringify(edited))
  expect((await rejects(launch(root), 'integrity')).message).toBe(
    'integrity: Build manifest names no recorded application executable'
  )
  // State written before health checks existed has no health or failed fields.
  const legacy = JSON.parse(text) as Partial<InstallationState>
  delete legacy.health
  delete legacy.failed
  await writeFile(join(root, 'state.json'), JSON.stringify(legacy))
  expect((await launch(root)).health).toEqual({ status: 'confirmed' })
  for (const health of [
    { status: 'pending', attempts: 0, limit: 0 },
    { status: 'pending', attempts: 3, limit: 2 },
    { status: 'pending', attempts: 0, limit: 17 },
    { status: 'confirmed' },
    // A pending release always has a retained release to fall back to.
    { status: 'pending', attempts: 0, limit: 1 },
  ]) {
    await writeFile(join(root, 'state.json'), JSON.stringify({ ...legacy, health }))
    await rejects(launch(root), 'state')
  }
  await writeFile(
    join(root, 'state.json'),
    JSON.stringify({ ...legacy, failed: { version: '1', sequence: 1, reason: 'failed' } })
  )
  await rejects(launch(root), 'state')
  await writeFile(join(root, 'state.json'), '{not json')
  await rejects(launch(root), 'state')
})

test('an unconfirmed release rolls back automatically after its start limit', async () => {
  const root = join(await temporary(), 'install')
  await put(root, 1)
  await writeFile(join(dataDirectory(root), 'notes.txt'), 'kept\n')
  await rejects(put(join(await temporary(), 'first'), 1, 2), 'state')
  for (const limit of [0, 17, 1.5]) await rejects(put(root, 2, limit), 'state')
  const pending = await put(root, 2, 2)
  expect(pending.health).toEqual({ status: 'pending', attempts: 0, limit: 2 })
  await rejects(put(root, 3), 'state')

  for (const attempt of [1, 2]) {
    const started = await launch(root)
    expect(started.release.version).toBe('1.0.2')
    expect(started.health).toEqual({ status: 'pending', attempt, limit: 2 })
    expect(started.rolledBack).toBeNull()
  }
  const fallback = await launch(root)
  expect(fallback.release.version).toBe('1.0.1')
  expect(fallback.health).toEqual({ status: 'confirmed' })
  expect(fallback.rolledBack).toEqual({
    version: '1.0.2',
    sequence: 2,
    manifestSha256: pending.current.manifestSha256,
    reason: 'unconfirmed',
  })
  expect(await state(root)).toMatchObject({ previous: null, health: null })
  expect((await readdir(join(root, 'versions'))).length).toBe(1)
  expect(await leftovers(root)).toEqual(clean)
  expect(await readFile(join(dataDirectory(root), 'notes.txt'), 'utf8')).toBe('kept\n')
  expect((await launch(root)).rolledBack).toBeNull()

  // The failed release cannot come back; a later sequence can, and confirms itself.
  await rejects(put(root, 2), 'downgrade')
  const third = await put(root, 3, 1)
  const sha = third.current.manifestSha256
  expect((await launch(root)).health).toEqual({ status: 'pending', attempt: 1, limit: 1 })
  await rejects(confirmHealthy(root, pending.current.manifestSha256), 'state')
  expect((await confirmHealthy(root, sha)).health).toBeNull()
  const confirmed = await readFile(join(root, 'state.json'), 'utf8')
  expect((await confirmHealthy(root, sha)).health).toBeNull()
  expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(confirmed)
  expect(await launch(root)).toMatchObject({ health: { status: 'confirmed' }, rolledBack: null })
  await rejects(reportUnhealthy(root, sha), 'state')
  expect((await state(root)).failed?.sequence).toBe(2)
  await installed(root, 'r3')
  expect((await rollback(root)).current.version).toBe('1.0.1')
})

test('an explicit failure rolls back at once; a manual rollback ends a pending check', async () => {
  const root = join(await temporary(), 'install')
  await put(root, 1)
  const pending = await put(root, 2, 3)
  expect((await launch(root)).health).toMatchObject({ attempt: 1 })
  await rejects(reportUnhealthy(root, '0'.repeat(64)), 'state')
  const failed = await reportUnhealthy(root, pending.current.manifestSha256)
  expect(failed.current.version).toBe('1.0.1')
  expect(failed.previous).toBeNull()
  expect(failed.failed).toMatchObject({ sequence: 2, reason: 'failed' })
  expect(await launch(root)).toMatchObject({ health: { status: 'confirmed' }, rolledBack: null })
  await rejects(reportUnhealthy(root, pending.current.manifestSha256), 'state')

  await put(root, 3, 2)
  const rolled = await rollback(root)
  expect(rolled).toMatchObject({ health: null, current: { version: '1.0.1' } })
  expect(rolled.previous?.version).toBe('1.0.3')
  expect((await launch(root)).health).toEqual({ status: 'confirmed' })
})

test('an automatic rollback re-verifies the retained release and fails closed', async () => {
  const root = join(await temporary(), 'install')
  const first = await put(root, 1)
  await put(root, 2, 1)
  await launch(root)
  const retained = join(root, first.current.directory, 'development/application.js')
  const original = await readFile(retained, 'utf8')
  await writeFile(retained, 'evil\n')
  const before = await readFile(join(root, 'state.json'), 'utf8')
  await rejects(launch(root), 'integrity')
  await rejects(launch(root), 'integrity')
  expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(before)
  await writeFile(retained, original)
  expect((await launch(root)).rolledBack?.reason).toBe('unconfirmed')
  await installed(root, 'r1')
})

const crashScript = `
import { launch, reportUnhealthy } from ${JSON.stringify(join(repository, 'scripts/native/lifecycle.ts'))}
const [root, operation, phase, sha] = process.argv.slice(2)
const onPhase = (current) => { if (current === phase) process.kill(process.pid, 'SIGKILL') }
if (operation === 'launch') await launch(root, { onPhase })
else await reportUnhealthy(root, sha, { onPhase })
`

test.skipIf(!posix)(
  'a launcher or health report killed at every phase recovers to a deterministic state',
  async () => {
    const work = await temporary()
    const script = join(work, 'crash.ts')
    await writeFile(script, crashScript)
    // [operation, limit, starts before the crash, phase, expected next launch]
    const cases = [
      ['launch', 2, 0, 'locked', { attempt: 1 }],
      ['launch', 2, 0, 'committed', { attempt: 2 }],
      ['launch', 1, 1, 'locked', { rolledBack: 'unconfirmed' }],
      ['launch', 1, 1, 'verified', { rolledBack: 'unconfirmed' }],
      ['launch', 1, 1, 'committed', { recovered: 'unconfirmed' }],
      ['report', 2, 0, 'locked', { attempt: 1 }],
      ['report', 2, 0, 'verified', { attempt: 1 }],
      ['report', 2, 0, 'committed', { recovered: 'failed' }],
    ] as const
    for (const [index, [operation, limit, starts, phase, expected]] of cases.entries()) {
      const root = join(work, `install-${index}`)
      await put(root, 1)
      await writeFile(join(dataDirectory(root), 'notes.txt'), phase)
      const pending = await put(root, 2, limit)
      for (let start = 0; start < starts; start += 1) await launch(root)
      const child = Bun.spawnSync(
        [process.execPath, script, root, operation, phase, pending.current.manifestSha256],
        { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
      )
      expect(child.signalCode).toBe('SIGKILL')
      expect(existsSync(join(root, 'lock'))).toBe(true)
      const next = await launch(root)
      if ('attempt' in expected) {
        expect(next.release.version).toBe('1.0.2')
        expect(next.health).toEqual({ status: 'pending', attempt: expected.attempt, limit })
      } else {
        expect(next.release.version).toBe('1.0.1')
        expect(next.health).toEqual({ status: 'confirmed' })
        if ('rolledBack' in expected) expect(next.rolledBack?.reason).toBe(expected.rolledBack)
        else {
          expect(next.rolledBack).toBeNull()
          expect((await state(root)).failed?.reason).toBe(expected.recovered)
        }
      }
      await recover(root)
      expect(await leftovers(root)).toEqual(clean)
      expect((await readdir(join(root, 'versions'))).length).toBe('attempt' in expected ? 2 : 1)
      expect(await readFile(join(dataDirectory(root), 'notes.txt'), 'utf8')).toBe(phase)
    }
  },
  60_000
)
