/** Explicit prepared-native profile; no compiler, production identity, or hidden browser fallback. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { nativeEvents } from '../benchmarks/lib/cef-acceptance.ts'
import { nativeMeasurement, nativeSummary } from '../benchmarks/foundation/native-results.ts'
import type { NativeMeasurement } from '../benchmarks/foundation/native-results.ts'
import { profileOptions } from '../benchmarks/foundation/statistics.ts'
import { schedule } from '../benchmarks/lib/statistics.ts'

const root = resolve(import.meta.dir, '..'),
  args = process.argv.slice(2)
if (args[0] !== '--app' || !args[1])
  throw new Error('Use --app PREBUILT_APP [--output PATH --samples 5..100 --warmups 1..10]')
if (!['darwin-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`))
  throw new Error('Unsupported native profiling target; no emulation or fallback')
const options = profileOptions(
  args.slice(2),
  join(root, '.bunly/profiles', 'foundation-native-' + randomUUID() + '.json')
)
if (options.warmups < 1)
  throw new Error('Native profile needs at least one warmup for reused-profile trials')
const source = resolve(args[1]),
  mac = process.platform === 'darwin'
const sourceInfo = await lstat(source)
if (
  sourceInfo.isSymbolicLink() ||
  (mac ? !sourceInfo.isDirectory() || !source.endsWith('.app') : !sourceInfo.isFile())
)
  throw new Error('Expected an unlinked prebuilt app bundle or host executable')
const sourceDirectory = mac ? source : dirname(source)
const original = await inventory(sourceDirectory)
const parent = join(root, '.bunly/profiles')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'native-'))
const app = join(work, mac ? 'Bunly Foundation Profile.app' : 'Bunly Foundation Profile')
const output = resolve(options.output)
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
const harnessPaths = [
  'scripts/profile-foundation-native.ts',
  'scripts/cef-bootstrap.ts',
  'benchmarks/foundation/native-page.ts',
  'benchmarks/foundation/native-backend.ts',
  'benchmarks/foundation/native-results.ts',
  'benchmarks/foundation/native-wire.ts',
  'benchmarks/foundation/statistics.ts',
  'benchmarks/lib/statistics.ts',
  'benchmarks/lib/observed-command.ts',
  'scripts/observe-process.py',
  'scripts/macos_clone_cleanup.py',
  'scripts/macos_process_identity.py',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      harnessPaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const hashesBefore = await fingerprints()
const trials: {
  variant: string
  trial: number
  warmup: boolean
  startupToReadyMs: number
  measurement: NativeMeasurement
  processReport: string
}[] = []
const attempts: {
  name: string
  variant: string
  trial: number
  warmup: boolean
  processReport: string
  passed: boolean
}[] = []
const report: Record<string, unknown> = {
  schema: 1,
  classification: 'descriptive-native-foundation-profile',
  passed: false,
  target: `${process.platform}-${process.arch}`,
  developerBun: Bun.version,
  sourceBefore: sourceIdentity(root),
  sourceHashes: hashesBefore,
  inputArtifact: original,
  trials,
  attempts,
  samples: options.samples,
  warmups: options.warmups,
  method:
    'Seeded paired fresh/reused user-data directory launches; monotonic observer root spawn to first renderer frame receipt. Summaries use independent trial statistics, retaining all correlated within-trial samples.',
  limitations: [
    'Fresh profile and reused profile are application cache conditions, not OS cold disk caches; no global caches are flushed.',
    'Synthetic DOM input and frame scheduling measure responsiveness; no hardware-input, compositor presentation or end-to-end user latency claim.',
    'No quiet-machine or thermal gate; no millisecond pass threshold.',
    'Active sample overlap means a fetch/body read was pending at scheduling and callback receipt; it does not identify the native worker instruction running between them.',
    'Full response content verification adds renderer WebCrypto work; request durations include content checks, which remain the same for baseline and candidate.',
    'macOS modifies and ad-hoc signs only the private copied fixture; no production signing or native compilation.',
    'Application views use ephemeral sessions; reused profile measures host/browser cache directory reuse, not persistent app sessions.',
    'Profiling does not qualify native renderer authority or choose an M4 transport.',
  ],
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
try {
  await cp(sourceDirectory, app, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  })
  assert.deepEqual(
    await inventory(app),
    original,
    'Copied prebuild inventory differs before profiling changes'
  )
  const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source))
  const resources = join(app, mac ? 'Contents/Resources' : 'resources')
  const backend = join(resources, 'backend'),
    publicRoot = join(resources, 'public')
  for (const directory of mac
    ? [join(app, 'Contents'), resources, backend]
    : [resources, backend]) {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Linked or invalid fixture resource ancestor')
  }
  const configPath = join(resources, 'runtime.json')
  const configInfo = await lstat(configPath)
  if (configInfo.isSymbolicLink() || !configInfo.isFile() || configInfo.size > 1024 * 1024)
    throw new Error('Linked or invalid runtime manifest')
  // Remove only known copied output leaves, so a copied symlink cannot redirect a build write.
  for (const name of ['main.js', 'application.js']) await rm(join(backend, name), { force: true })
  await rm(publicRoot, { recursive: true, force: true })
  await mkdir(publicRoot, { mode: 0o700 })
  const asset = Buffer.alloc(8 * 1024 * 1024, 81),
    hash = createHash('sha256').update(asset).digest('hex')
  await writeFile(join(publicRoot, 'asset.bin'), asset)
  await writeFile(
    join(publicRoot, 'index.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Bunly foundation profile</title><script type="module" src="/profile.js"></script><h1>Bunly foundation profile</h1><input id="profile-input" aria-label="Synthetic profiling input"></html>'
  )
  for (const [entry, outdir, naming, target] of [
    ['scripts/cef-bootstrap.ts', backend, 'main.js', 'bun'],
    ['benchmarks/foundation/native-backend.ts', backend, 'application.js', 'bun'],
    ['benchmarks/foundation/native-page.ts', publicRoot, 'profile.js', 'browser'],
  ] as const) {
    const build = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir,
      naming,
      target,
      format: 'esm',
      minify: false,
      define: {
        PROFILE_ASSET_BYTES: String(asset.length),
        PROFILE_ASSET_SHA256: JSON.stringify(hash),
      },
    })
    if (!build.success) throw new Error('Profile fixture build failed: ' + build.logs.join('\n'))
  }
  const files: Record<string, { bytes: number; sha256: string }> = {}
  for (const name of ['asset.bin', 'index.html', 'profile.js']) {
    const bytes = await readFile(join(publicRoot, name))
    files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(files) + '\n')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  delete config['development_origin']
  await writeFile(configPath, JSON.stringify(config) + '\n')
  report['runtime'] = config
  report['fixture'] = {
    assetBytes: asset.length,
    assetSha256: hash,
    concurrentKinds: ['full', 'range', 'head', 'conditional'],
    samplesPerPhase: 32,
    maxRequestsPerKind: 64,
  }
  if (mac) {
    const program = [
      'from pathlib import Path',
      'import sys',
      'from qualify_adhoc_signing import targets, sign_command',
      'from native_signing import native_command',
      'app = Path(sys.argv[1])',
      'for path in targets(app): native_command(sign_command(path))',
      "native_command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])",
    ].join('\n')
    const signed = await observedCommand([process.env['PYTHON'] ?? 'python', '-c', program, app], {
      cwd: join(root, 'scripts'),
      output: join(work, 'sign.process.json'),
      timeoutMs: 180000,
    }).result
    assertCleanCommand(signed)
  }
  const prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  const unrelated = join(work, 'unrelated-cwd'),
    emptyPath = join(work, 'empty-compiler-path')
  await mkdir(unrelated)
  await mkdir(emptyPath)
  const variants = ['fresh-profile', 'reused-profile']
  for (const warmup of [true, false]) {
    for (const planned of schedule(
      variants,
      warmup ? options.warmups : options.samples,
      0x434546
    )) {
      const name = `${warmup ? 'warmup' : 'trial'}-${planned.trial}-${planned.variant}`
      const processPath = join(work, name + '.process.json')
      const attempt = {
        name,
        ...planned,
        warmup,
        processReport: basename(processPath),
        passed: false,
      }
      attempts.push(attempt)
      const observation = await observedCommand([executable], {
        cwd: unrelated,
        output: processPath,
        timeoutMs: 30000,
        env: {
          PATH: emptyPath,
          BUNLY_CACHE_DIR: join(
            work,
            planned.variant === 'reused-profile' ? 'reused-cache' : name + '-cache'
          ),
          BUNLY_BENCH_SANDBOX: '1',
        },
      }).result
      assertCleanCommand(observation)
      const events = nativeEvents(observation)
      const completed = events.filter((event) => event['event'] === 'bunly.foundation.result')
      if (
        completed.length !== 1 ||
        !events.some(
          (event) => event['event'] === 'bunly.host.shutdown' && event['clean'] === true
        ) ||
        !events.some(
          (event) =>
            event['event'] === 'bunly.backend.exit' &&
            event['code'] === 0 &&
            event['forced'] === false
        )
      )
        throw new Error('Native profile did not complete with clean host/backend shutdown')
      const raw = JSON.parse(await readFile(processPath, 'utf8')) as Record<string, unknown>
      const timing = raw['eventTimes']
      if (!Array.isArray(timing) || timing.length !== 1)
        throw new Error('Observer did not record native readiness time')
      const ready = timing[0] as Record<string, unknown>
      if (
        ready['event'] !== 'bunly.foundation.ready' ||
        ready['stream'] !== 'stderr' ||
        typeof ready['elapsedMs'] !== 'number' ||
        !Number.isFinite(ready['elapsedMs']) ||
        ready['elapsedMs'] < 0 ||
        ready['elapsedMs'] > observation.elapsedMs
      )
        throw new Error('Invalid native readiness measurement')
      const measurement = nativeMeasurement(completed[0]!['measurement'])
      attempt.passed = true
      trials.push({
        ...planned,
        warmup,
        startupToReadyMs: ready['elapsedMs'],
        measurement,
        processReport: basename(processPath),
      })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      console.log(
        JSON.stringify({ variant: planned.variant, trial: planned.trial, warmup, passed: true })
      )
    }
  }
  report['summary'] = Object.fromEntries(
    variants.map((variant) => [
      variant,
      nativeSummary(trials.filter((trial) => !trial.warmup && trial.variant === variant)),
    ])
  )
  assert.deepEqual(
    await inventory(app),
    prepared,
    'Native profile must not mutate installed resources'
  )
  assert.deepEqual(
    await inventory(sourceDirectory),
    original,
    'Native profile must not mutate input prebuild'
  )
  report['inputArtifactUnchanged'] = true
  report['preparedArtifactUnchanged'] = true
  report['passed'] = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  report['sourceHashesAfter'] = await fingerprints()
  if (JSON.stringify(report['sourceHashesAfter']) !== JSON.stringify(hashesBefore)) {
    report['passed'] = false
    report['failure'] = 'Profile source changed during measurement'
    process.exitCode = 1
  }
  report['sourceAfter'] = sourceIdentity(root)
  report['rawReportsDirectory'] = work
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ passed: report['passed'], output, failure: report['failure'] }))
}
