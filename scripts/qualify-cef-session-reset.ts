/** Actual CEF storage persistence and complete offline reset. No production profile is used. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { nativeEvents, acceptNativeRejection } from '../benchmarks/lib/cef-acceptance.ts'
import {
  observeNativeShutdown,
  requireNativeShutdown,
} from '../benchmarks/foundation/native-shutdown.ts'
import {
  observedCommand,
  assertCleanCommand,
  type CommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import { resetPersistentSessionStorage } from '../packages/runtime/src/session-reset.ts'

const root = resolve(import.meta.dir, '..')
const input = process.argv[2]
if (
  !input ||
  process.argv.length !== 3 ||
  !['darwin-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`)
)
  throw new Error('Pass one prepared native application on a declared target')
const mac = process.platform === 'darwin'
const source = mac ? resolve(input) : dirname(resolve(input))
const original = await inventory(source)
await mkdir(join(root, '.bunly/m3/session-reset'), { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(root, '.bunly/m3/session-reset/run-'))
const app = join(work, mac ? 'Reset Unicode Ω.app' : 'Reset Unicode Ω')
const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(input))
const resources = join(app, mac ? 'Contents/Resources' : 'resources')
// Keep the pinned Windows cache layout below legacy path bounds without changing
// machine policy. Reports and Unicode executable coverage stay in the original run.
const profileWork = process.platform === 'win32' ? await mkdtemp(join(root, '.bunly/r-')) : work
const profileRoot = join(profileWork, 'reset-root')
const profile = (partition: string) =>
  join(profileRoot, 'bunly-profile-' + createHash('sha256').update(partition).digest('hex'))
const sourceBefore = sourceIdentity(root)
const tracked = [
  'scripts/qualify-cef-session-reset.ts',
  'examples/cef/session-reset.ts',
  'examples/cef/session-reset-client.ts',
  'packages/runtime/src/session-reset.ts',
  'native/cef-host/src/session_reset.rs',
  'native/cef-host/src/session.rs',
  'native/cef-host/src/lib.rs',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      tracked.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex'),
      ])
    )
  )
const hashes = await fingerprints()
const trials: Record<string, unknown>[] = []
const report: Record<string, unknown> = {
  schema: 1,
  classification: 'native-offline-whole-profile-reset',
  target: `${process.platform}-${process.arch}`,
  profileRootUtf16Units: profileRoot.length,
  profileLayout: 'explicit-private-root-with-pinned-Windows-storage-budget',
  passed: false,
  sourceBefore,
  sourceHashes: hashes,
  inputArtifact: original,
  trials,
  limitations: [
    'Entire selected profile is deleted offline under the native root lock; this is not selective in-place live clearing.',
    'LocalStorage, IndexedDB, CacheStorage and service-worker persistence are exercised by actual CEF.',
    'The whole selected profile directory is removed, including nested origin/partition stores, without enumerating a partial origin list.',
    'No secure-overwrite, OS credential-key deletion, hostile same-user race defense or power-loss atomicity claim.',
    'Interrupted reset is an expected unclean control; retained intent fences reuse until explicit recovery.',
  ],
}
let releaseHold = () => {}
let holdReady = () => {}
const held = new Promise<void>((resolve) => {
  holdReady = resolve
})
const released = new Promise<void>((resolve) => {
  releaseHold = resolve
})
let server: Bun.Server<undefined> | undefined
let prepared: Awaited<ReturnType<typeof inventory>> | undefined
const successful: CommandObservation[] = []

function fileReady(path: string) {
  let close = () => {}
  const promise = new Promise<void>((resolveReady, reject) => {
    let finished = false
    const watcher = watch(dirname(path), () => {
      void inspect()
    })
    const timer = setTimeout(
      () => finish(new Error('Native reset interruption checkpoint was not observed')),
      5000
    )
    function finish(error?: Error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      watcher.close()
      if (error) reject(error)
      else resolveReady()
    }
    async function inspect() {
      try {
        if ((await lstat(path)).isFile() && (await readFile(path, 'utf8')) === 'quarantined\n')
          finish()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error)
      }
    }
    close = () => finish(new Error('Checkpoint observation cancelled'))
    void inspect()
  })
  void promise.catch(() => {})
  return { promise, close: () => close() }
}

try {
  const browser = await Bun.build({
    entrypoints: [join(root, 'examples/cef/session-reset-client.ts')],
    target: 'browser',
  })
  assert.ok(browser.success, String(browser.logs))
  const javascript = await browser.outputs[0]!.text()
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/client.js')
        return new Response(javascript, { headers: { 'content-type': 'text/javascript' } })
      if (path === '/worker.js')
        return new Response(
          "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
          { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } }
        )
      if (path === '/hold' && request.method === 'POST') {
        holdReady()
        await released
        return new Response('released')
      }
      return new Response(
        '<!doctype html><title>Owned offline storage fixture</title><script type="module" src="/client.js"></script>',
        { headers: { 'content-type': 'text/html' } }
      )
    },
  })
  await cp(source, app, { recursive: true, dereference: false, errorOnExist: true, force: false })
  const config = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(
    config['maintenance_protocol'],
    1,
    'Prepared host must declare offline reset protocol'
  )
  config['development_origin'] = server.url.origin
  await writeFile(join(resources, 'runtime.json'), JSON.stringify(config))
  const backend = await Bun.build({
    entrypoints: [join(root, 'examples/cef/session-reset.ts')],
    target: 'bun',
    outdir: join(resources, 'backend'),
    naming: 'application.js',
  })
  assert.ok(backend.success, String(backend.logs))
  if (mac) {
    const helper = join(work, 'sign.py')
    await writeFile(
      helper,
      `import sys,subprocess\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})\nfrom qualify_adhoc_signing import targets\nfor p in targets(Path(${JSON.stringify(app)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)\n`
    )
    assertCleanCommand(
      await observedCommand([process.env['PYTHON'] ?? 'python3', helper], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30000,
      }).result
    )
  }
  prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  const launch = (mode: string, signal?: AbortSignal) =>
    observedCommand([executable], {
      cwd: work,
      output: join(work, `${mode}.process.json`),
      timeoutMs: 30000,
      ...(signal ? { signal } : {}),
      env: {
        BUNLY_PROFILE_ROOT: profileRoot,
        BUNLY_TEST_RESET_ORIGIN: server!.url.origin,
        BUNLY_TEST_RESET_MODE: mode,
        BUNLY_CACHE_DIR: join(work, `${mode}-cache`),
      },
    })
  async function accept(mode: string, observation: CommandObservation) {
    trials.push({ name: mode, observation, classification: 'native-storage-launch' })
    assertCleanCommand(observation)
    requireNativeShutdown(observeNativeShutdown(observation))
    assert.deepEqual(
      nativeEvents(observation).filter((event) => event['event'] === 'bunly.native.session-reset'),
      [
        {
          event: 'bunly.native.session-reset',
          schema: 1,
          mode,
          passed: true,
          stores:
            mode === 'blocked'
              ? []
              : ['localStorage', 'indexedDB', 'cacheStorage', 'serviceWorker'],
          nativeAuthority: 'remote-unprivileged',
        },
      ]
    )
    successful.push(observation)
  }
  await accept('seed', await launch('seed').result)
  await accept('present', await launch('present').result)
  const holdController = new AbortController()
  const heldRun = launch('hold', holdController.signal)
  const heldOutcome = heldRun.result
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      held,
      heldOutcome.then(() => {
        throw new Error('Hold application exited before lock test')
      }),
      new Promise<never>((_, reject) => {
        holdTimer = setTimeout(
          () => reject(new Error('Hold application did not become ready')),
          12000
        )
      }),
    ])
    await assert.rejects(
      resetPersistentSessionStorage({
        hostExecutable: executable,
        persistentRoot: profileRoot,
        partition: 'A',
        confirmation: 'delete-entire-profile',
      })
    )
    const lockRejection = await observedCommand(
      [executable, '--bunly-reset-profile=A', '--bunly-confirm-profile-reset'],
      {
        cwd: work,
        output: join(work, 'live-lock-rejection.process.json'),
        timeoutMs: 10000,
        env: { BUNLY_PROFILE_ROOT: profileRoot },
      }
    ).result
    trials.push({
      name: 'native-live-lock-rejected',
      classification: 'expected-native-lock-rejection',
      observation: lockRejection,
    })
    acceptNativeRejection(
      lockRejection,
      'Persistent profile root is already in use or cannot be locked'
    )
    assert.equal(
      nativeEvents(lockRejection).filter((event) => event['event'] === 'bunly.backend.exit').length,
      0,
      'Maintenance rejection must not launch the application backend'
    )
    assert.ok((await lstat(profile('A'))).isDirectory())
    trials.push({
      name: 'live-root-rejected',
      passed: true,
      classification: 'expected-maintenance-rejection',
    })
  } catch (error) {
    releaseHold()
    holdController.abort()
    trials.push({
      name: 'hold-failure',
      classification: 'failed-owned-launch',
      observation: await heldOutcome,
    })
    throw error
  } finally {
    if (holdTimer) clearTimeout(holdTimer)
    releaseHold()
  }
  await accept('hold', await heldOutcome)

  const ready = fileReady(join(profileRoot, '.bunly-reset-fixture-ready'))
  const interrupted = new AbortController()
  const attempt = observedCommand(
    [executable, '--bunly-reset-profile=A', '--bunly-confirm-profile-reset'],
    {
      cwd: work,
      output: join(work, 'interrupted.process.json'),
      timeoutMs: 15000,
      signal: interrupted.signal,
      env: { BUNLY_PROFILE_ROOT: profileRoot, BUNLY_RESET_FIXTURE_PAUSE: 'quarantined' },
    }
  )
  let checkpointFailure: unknown
  try {
    await Promise.race([
      ready.promise,
      attempt.result.then(() => {
        throw new Error('Reset finished before the deliberate interruption checkpoint')
      }),
    ])
    interrupted.abort()
  } catch (error) {
    checkpointFailure = error
  } finally {
    ready.close()
    interrupted.abort()
  }
  const stopped = await attempt.result
  trials.push({
    name: 'interrupted-reset',
    classification: 'expected-unclean-interruption',
    observation: stopped,
  })
  if (checkpointFailure) throw checkpointFailure
  assert.equal(stopped.cancelled, true)
  assert.equal(stopped.timedOut, false)
  assert.equal(stopped.outputOverflow, false)
  assert.deepEqual(stopped.observedOrphans, [])
  assert.deepEqual(stopped.cleanupSurvivors, [])
  await accept('blocked', await launch('blocked').result)
  const reset = await resetPersistentSessionStorage({
    hostExecutable: executable,
    persistentRoot: profileRoot,
    partition: 'A',
    confirmation: 'delete-entire-profile',
  })
  assert.equal(reset.recoveredInterruption, true)
  await assert.rejects(lstat(profile('A')), { code: 'ENOENT' })
  assert.ok((await lstat(profile('B'))).isDirectory())
  trials.push({
    name: 'recovered-reset',
    passed: true,
    result: reset,
    selectedDirectoryRemoved: true,
    otherProfilePreserved: true,
  })
  await accept('cleared', await launch('cleared').result)
  if (mac)
    assert.ok(
      successful.some((observation) => observation.postExitCleanup?.qualified),
      'No positive helper/clone observation in the fixed suite'
    )
  assert.deepEqual(await inventory(app), prepared)
  assert.deepEqual(await inventory(source), original)
  report['inputArtifactUnchanged'] = true
  report['preparedArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  releaseHold()
  await server?.stop(true)
  report['sourceAfter'] = sourceIdentity(root)
  if (JSON.stringify(report['sourceAfter']) !== JSON.stringify(sourceBefore)) {
    report.passed = false
    report['failure'] = 'Reset qualification checkout changed during execution'
  }
  report['sourceHashesAfter'] = await fingerprints()
  if (JSON.stringify(report['sourceHashesAfter']) !== JSON.stringify(hashes)) {
    report.passed = false
    report['failure'] = 'Reset qualification source changed during execution'
  }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  console.log(
    JSON.stringify({
      passed: report.passed,
      trials: trials.length,
      output: join(work, 'report.json'),
      failure: report['failure'],
    })
  )
}
if (!report.passed) process.exitCode = 1
