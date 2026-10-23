/** Real prepared-native session qualification through the maintained process observer. */
import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { nativeEvents } from '../benchmarks/lib/cef-acceptance.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'
import {
  observeNativeShutdown,
  requireNativeShutdown,
} from '../benchmarks/foundation/native-shutdown.ts'

if (Bun.version !== '1.4.3') throw new Error('Use the pinned Bun 1.4.3')
const argument = process.argv[2]
if (!argument || process.argv.length !== 3)
  throw new Error('Usage: bun scripts/qualify-cef-sessions.ts PREPARED_APP')
const supplied = resolve(argument)
const info = await lstat(supplied)
if (info.isSymbolicLink()) throw new Error('CEF fixture must not be a symbolic link')
const mac = process.platform === 'darwin'
const executable = mac ? join(supplied, 'Contents/MacOS/bunly_host') : supplied
if (!(await lstat(executable)).isFile()) throw new Error('Expected prepared native executable')
const sourceDirectory = mac ? supplied : resolve(supplied, '..')
const before = await inventory(sourceDirectory)
const root = resolve(import.meta.dir, '..')
const parent = join(root, '.bunly/m4-sessions')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
await chmod(work, 0o700)
const profileRoot = join(work, 'persistent-root')
const runtimeCache = join(work, 'runtime-cache')
const emptyPath = join(work, 'empty-compiler-path')
await mkdir(emptyPath, { mode: 0o700 })
const trials: Record<string, unknown>[] = []
const active = new Set<{ controller: AbortController; result: Promise<CommandObservation> }>()
const report: Record<string, unknown> = {
  schema: 1,
  target: `${process.platform}-${process.arch}`,
  classification: 'native-session-functional-qualification',
  sourceBefore: sourceIdentity(root),
  inputArtifact: before,
  passed: false,
  trials,
  limitations: [
    'Private prepared fixture; not production signing, encrypted credential qualification or M4 renderer authentication.',
    'Persistent cookies are disabled pending credential-provider qualification; persistent localStorage is supported.',
    'Complete HTML5 storage clearing is explicitly unsupported by this implementation.',
    'Interrupted launch is an expected negative control, never a clean shutdown or helper-cleanup qualification.',
    'Known intermittent shutdown issue 92 remains separately tracked.',
  ],
}
const output = join(work, 'report.json')
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
let launchIndex = 0
function launch(mode: string, changes: Record<string, string> = {}) {
  const name = `${String(++launchIndex).padStart(2, '0')}-${mode}`
  const controller = new AbortController()
  const row: Record<string, unknown> = {
    name,
    mode,
    passed: false,
    processReport: name + '.process.json',
  }
  trials.push(row)
  const command = observedCommand([executable], {
    cwd: work,
    output: join(work, String(row['processReport'])),
    timeoutMs: 60000,
    signal: controller.signal,
    env: {
      PATH: emptyPath,
      BUNLY_CACHE_DIR: runtimeCache,
      BUNLY_PROFILE_ROOT: profileRoot,
      BUNLY_SESSION_FIXTURE: mode,
      BUNLY_TEST_PAGE_TIMEOUT_MS: '20000',
      BUNLY_BENCH_SANDBOX: '1',
      ...changes,
    },
  })
  const entry = { controller, result: command.result }
  active.add(entry)
  const result = command.result
    .then((observation) => {
      row['observation'] = observation
      row['shutdown'] = observeNativeShutdown(observation)
      return observation
    })
    .catch((error: unknown) => {
      row['failure'] = error instanceof Error ? error.message : String(error)
      throw error
    })
    .finally(() => {
      active.delete(entry)
    })
  void result.catch(() => {})
  return { ...entry, result, row }
}
function accepted(mode: string, observation: CommandObservation): void {
  assertCleanCommand(observation)
  requireNativeShutdown(observeNativeShutdown(observation))
  if (mac)
    assert.equal(
      observation.postExitCleanup?.qualified,
      true,
      'Exact helper/clone cleanup was not qualified'
    )
  const events = nativeEvents(observation).filter(
    (event) => event['event'] === 'bunly.native.sessions'
  )
  assert.equal(events.length, 1, 'Missing or repeated session result')
  assert.equal(events[0]!['mode'], mode, 'Wrong session fixture mode')
  assert.equal(events[0]!['passed'], true)
}
async function execute(mode: string, changes: Record<string, string> = {}) {
  const run = launch(mode, changes)
  const observation = await run.result
  accepted(mode, observation)
  run.row['passed'] = true
  return observation
}
async function readiness(file: string, result: Promise<CommandObservation>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: ReturnType<typeof watch> | undefined
  const ready = new Promise<void>((resolve, reject) => {
    const inspect = () => {
      void lstat(file)
        .then(async (stat) => {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
            throw new Error('Invalid bounded readiness file')
          await readFile(file, 'utf8')
          resolve()
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') reject(error)
        })
    }
    watcher = watch(work, { persistent: false }, inspect)
    watcher.on('error', reject)
    timer = setTimeout(() => reject(new Error('Session holder readiness deadline')), 20000)
    inspect()
  })
  try {
    await Promise.race([
      ready,
      result.then(() => {
        throw new Error('Session holder exited before readiness')
      }),
    ])
  } finally {
    watcher?.close()
    if (timer) clearTimeout(timer)
  }
}

try {
  await execute('ephemeral')
  await execute('cookies')
  await execute('persistent-write')
  await execute('persistent-read')
  const ready = join(work, 'hold.ready'),
    release = join(work, 'hold.release')
  const holder = launch('lock-hold', { BUNLY_SESSION_READY: ready, BUNLY_SESSION_RELEASE: release })
  try {
    await readiness(ready, holder.result)
    const collision = launch('persistent-read')
    const observation = await collision.result
    assertCleanCommand(observation, 78)
    assert.ok(
      nativeEvents(observation).some(
        (event) =>
          event['event'] === 'bunly.host.error' &&
          String(event['error']).includes('profile root is already in use')
      )
    )
    collision.row['disposition'] = 'expected-root-lock-rejection'
    collision.row['passed'] = true
    await writeFile(release, 'release\n', { flag: 'wx', mode: 0o600 })
    accepted('lock-hold', await holder.result)
    holder.row['passed'] = true
  } finally {
    holder.controller.abort()
    await holder.result.catch(() => {})
  }

  const interruptedReady = join(work, 'interrupted.ready')
  const interrupted = launch('lock-hold', {
    BUNLY_SESSION_READY: interruptedReady,
    BUNLY_SESSION_RELEASE: join(work, 'unreleased'),
  })
  try {
    await readiness(interruptedReady, interrupted.result)
    interrupted.controller.abort()
    const observation = await interrupted.result
    assert.equal(observation.cancelled, true, 'Observer did not record controlled interruption')
    assert.equal(
      observation.cleanupSurvivors.length,
      0,
      'Owned descendants survived controlled cleanup'
    )
    assert.notEqual(observation.exitCode, 0, 'Interrupted app unexpectedly exited normally')
    interrupted.row['disposition'] = 'expected-unclean-interruption; not shutdown qualification'
    interrupted.row['passed'] = true
  } finally {
    interrupted.controller.abort()
    await interrupted.result.catch(() => {})
  }
  await execute('persistent-read')

  const corruptRoot = join(work, 'corrupt-root')
  await mkdir(corruptRoot, { mode: 0o700 })
  await writeFile(join(corruptRoot, 'unknown'), 'not a Bunly root\n', { mode: 0o600 })
  for (const [name, folder, expected] of [
    ['corrupt-root', corruptRoot, 'nonempty persistent root'],
    ...(process.platform === 'win32'
      ? []
      : [['symlink-root', join(work, 'symlink-root'), 'symbolic link']]),
  ]) {
    if (name === 'symlink-root') await symlink(corruptRoot, folder!)
    const rejected = launch('persistent-read', { BUNLY_PROFILE_ROOT: folder! })
    const observation = await rejected.result
    assertCleanCommand(observation, 78)
    assert.ok(
      nativeEvents(observation).some(
        (event) =>
          event['event'] === 'bunly.host.error' && String(event['error']).includes(expected!)
      )
    )
    rejected.row['disposition'] = `expected-${name}-rejection`
    rejected.row['passed'] = true
  }
  assert.deepEqual(await inventory(sourceDirectory), before)
  report['inputArtifactUnchanged'] = true
  report['passed'] = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  for (const entry of active) entry.controller.abort()
  await Promise.allSettled([...active].map((entry) => entry.result))
  report['sourceAfter'] = sourceIdentity(root)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(
    JSON.stringify({
      passed: report['passed'],
      output,
      trials: trials.length,
      failure: report['failure'],
    })
  )
}
