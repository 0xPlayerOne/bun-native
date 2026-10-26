/** Actual prepared-CEF + Bun PTY + graphical xterm functional qualification. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import {
  observedCommand,
  assertCleanCommand,
  type CommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import { distribution, profileOptions } from '../benchmarks/foundation/statistics.ts'
import { acceptGraphicalTerminal } from '../benchmarks/lib/cef-terminal-acceptance.ts'
import { phaseSummary, type ObservationSample } from '../benchmarks/lib/observation.ts'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const input = args.shift()
if (!input || Bun.version !== '1.4.3')
  throw new Error(
    'Use Bun 1.4.3: qualify-cef-terminals PREPARED_APP [--functional | --samples 5..100 --warmups 0..10]'
  )
const functional = args.length === 1 && args[0] === '--functional'
const options = functional ? { samples: 1, warmups: 0, output: '' } : profileOptions(args, '')
if (!functional && options.output) throw new Error('The qualifier owns its immutable run directory')
const mac = process.platform === 'darwin'
const source = resolve(input)
const inputRoot = mac ? source : dirname(source)
const inputInventory = await inventory(inputRoot)
const parent = join(root, '.bunly/m5/graphical-terminals')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const sourcePaths = [
  'package.json',
  'bun.lock',
  'scripts/qualify-cef-terminals.ts',
  'examples/cef-terminal/terminal-fixture.ts',
  'examples/cef-terminal/terminal-client.ts',
  'examples/cef-terminal/terminal-records.ts',
  'examples/cef-terminal/terminal-child.ts',
  'examples/cef-terminal/terminal-contract.ts',
  'examples/cef-terminal/public/index.html',
  'examples/cef-terminal/public/fixture.css',
  'benchmarks/lib/cef-terminal-acceptance.ts',
  'benchmarks/lib/observed-command.ts',
  'benchmarks/lib/observation.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'benchmarks/foundation/native-shutdown.ts',
  'packages/runtime/src/cef.ts',
  'packages/runtime/src/terminal.ts',
  'packages/runtime/src/stream-source.ts',
  'packages/client/src/cef-streams.ts',
  'packages/contracts/src/streams.ts',
  'native/cef-host/src/host.rs',
  'native/cef-host/src/renderer_rpc.rs',
  'native/cef-host/src/rpc_authority.rs',
  'native/cef-host/src/rpc_protocol.rs',
  'native/cef-host/src/process.rs',
  'native/cef-host/src/event_queue.rs',
  'native/cef-host/src/exit_notification.rs',
  'scripts/observe-process.py',
  'scripts/probe_cef_identity.py',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const before = sourceIdentity(root)
const report: Record<string, unknown> = {
  schema: 1,
  classification: functional
    ? 'graphical-native-terminal-functional-qualification'
    : 'graphical-native-terminal-descriptive-profile',
  passed: false,
  target: `${process.platform}-${process.arch}`,
  bun: Bun.version,
  sourceBefore: before,
  sourceHashes: await fingerprints(),
  inputArtifact: inputInventory,
  samples: options.samples,
  warmups: options.warmups,
  trials: [],
  limitations: [
    'Functional runs establish correctness and bounded behavior, not a throughput or latency win.',
    'Foreground uses the maintained visible-window API. Background and minimized modes are NOT qualified because no maintained native visibility/minimize control exists.',
    'No baseline comparison is claimed without the identical workload on a pinned comparison runtime.',
    'Direct owned children only; detached-descendant supervision is not claimed.',
    'Linux PTY status 1 remains an ambiguous read lifecycle result, never generic clean EOF.',
    'Ordinary runtime default cookies remain disabled. This fixture does not alter credential policy or use a personal credential store.',
  ],
}
const trials = report['trials'] as Record<string, unknown>[]
const python = process.env['PYTHON'] ?? 'python3'
try {
  if (!functional) assert.equal(before.clean, true, 'Profiling requires clean committed source')
  const app = join(work, mac ? 'Graphical Terminals.app' : 'Graphical Terminals Unicode é Ω')
  await cp(inputRoot, app, { recursive: true, dereference: false })
  const resources = join(app, mac ? 'Contents/Resources' : 'resources')
  const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(
    runtime['development_origin'],
    undefined,
    'Prepared app must not use a development origin'
  )
  assert.equal(runtime['bun_version'], '1.4.3')
  assert.equal(runtime['cef_version'], '156.0.7')

  const backend = await Bun.build({
    entrypoints: [join(root, 'examples/cef-terminal/terminal-fixture.ts')],
    outdir: join(resources, 'backend'),
    naming: 'application.js',
    target: 'bun',
    format: 'esm',
    minify: false,
  })
  assert.equal(backend.success, true, backend.logs.join('\n'))
  const child = await Bun.build({
    entrypoints: [join(root, 'examples/cef-terminal/terminal-child.ts')],
    outdir: join(resources, 'backend'),
    naming: 'terminal-child.js',
    target: 'bun',
    format: 'esm',
    minify: false,
  })
  assert.equal(child.success, true, child.logs.join('\n'))
  const publicRoot = join(resources, 'public')
  await rm(publicRoot, { recursive: true, force: true })
  await mkdir(publicRoot)
  await cp(join(root, 'examples/cef-terminal/public/index.html'), join(publicRoot, 'index.html'))
  await cp(join(root, 'examples/cef-terminal/public/fixture.css'), join(publicRoot, 'fixture.css'))
  const xtermPackage = join(root, 'node_modules/@xterm/xterm')
  assert.equal(
    JSON.parse(await readFile(join(xtermPackage, 'package.json'), 'utf8')).version,
    '5.5.0'
  )
  await cp(join(xtermPackage, 'css/xterm.css'), join(publicRoot, 'xterm.css'))
  await cp(join(xtermPackage, 'LICENSE'), join(publicRoot, 'xterm-LICENSE.txt'))
  const browser = await Bun.build({
    entrypoints: [join(root, 'examples/cef-terminal/terminal-client.ts')],
    outdir: publicRoot,
    naming: 'terminal-client.js',
    target: 'browser',
    format: 'esm',
    minify: false,
  })
  assert.equal(browser.success, true, browser.logs.join('\n'))
  const assets: Record<string, { bytes: number; sha256: string }> = {}
  for (const name of (await readdir(publicRoot)).sort()) {
    const path = join(publicRoot, name)
    const stat = await lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Public assets must be regular files')
    const bytes = await readFile(path)
    assets[name] = {
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  await writeFile(join(publicRoot, 'assets.json'), JSON.stringify(assets, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })

  if (mac) {
    const signer = join(work, 'sign.py')
    await writeFile(
      signer,
      [
        'import sys,subprocess',
        'from pathlib import Path',
        `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
        'from qualify_adhoc_signing import targets',
        `for p in targets(Path(${JSON.stringify(app)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)`,
        '',
      ].join('\n'),
      { mode: 0o600 }
    )
    assertCleanCommand(
      await observedCommand([python, signer], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30_000,
      }).result
    )
  }
  const prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  report['assets'] = assets
  const library = join(
    app,
    mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : process.platform === 'win32'
        ? 'libcef.dll'
        : 'libcef.so'
  )
  const libraryHash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(library).arrayBuffer())
    .digest('hex')
  const identity = await observedCommand(
    [
      python,
      join(root, 'scripts/probe_cef_identity.py'),
      '--library',
      library,
      '--sha256',
      libraryHash,
    ],
    { cwd: work, output: join(work, 'identity.process.json'), timeoutMs: 30_000 }
  ).result
  assertCleanCommand(identity)
  const identityLine = identity.stdoutTail.find((line) => line.startsWith('{'))
  assert.ok(identityLine)
  report['runtimeIdentity'] = JSON.parse(identityLine)
  const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source))
  const accepted: ReturnType<typeof acceptGraphicalTerminal>[] = []
  for (let index = -options.warmups; index < options.samples; index++) {
    const observation = await observedCommand([executable], {
      cwd: work,
      output: join(work, `trial-${index}.process.json`),
      timeoutMs: 30_000,
      env: {
        BUNLY_CACHE_DIR: join(work, `trial-${index}-cache`),
        BUNLY_BENCH_SANDBOX: '1',
      },
    }).result
    const trial: Record<string, unknown> = { index, warmup: index < 0, passed: false, observation }
    trials.push(trial)
    const metrics = acceptGraphicalTerminal(observation)
    trial['metrics'] = metrics
    trial['processPhases'] = phaseSummary(
      observation.samples as unknown as readonly ObservationSample[]
    )
    trial.passed = true
    if (index >= 0) accepted.push(metrics)
    console.log(JSON.stringify({ index, warmup: index < 0, passed: true }))
  }
  report['distributions'] = {
    elapsedMs: distribution(accepted.map((entry) => entry.elapsedMs)),
    workloadElapsedMs: distribution(accepted.map((entry) => entry.workloadElapsedMs)),
    totalBytes: distribution(accepted.map((entry) => entry.bytes)),
    controlRoundtripMs: distribution(accepted.flatMap((entry) => entry.controlRoundtripsMs)),
    consumerCallbackMs: distribution(
      accepted.flatMap((entry) => entry.consumerCallbackDurationsMs)
    ),
    peakTreeRssBytes: distribution(accepted.map((entry) => entry.peakTreeRssBytes)),
    peakTreeThreads: distribution(accepted.map((entry) => entry.peakTreeThreads)),
    queuePeakFrames: distribution(accepted.map((entry) => entry.queuePeakFrames)),
    queuePeakBytes: distribution(accepted.map((entry) => entry.queuePeakBytes)),
    processPhases: (trials as { observation: CommandObservation }[]).map((trial) =>
      phaseSummary(trial.observation.samples as unknown as readonly ObservationSample[])
    ),
  }
  assert.deepEqual(await inventory(app), prepared, 'Prepared artifact changed during qualification')
  assert.deepEqual(
    await inventory(inputRoot),
    inputInventory,
    'Input artifact changed during qualification'
  )
  report['preparedArtifactUnchanged'] = true
  report['inputArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  const after = sourceIdentity(root)
  report['sourceAfter'] = after
  report['sourceHashesAfter'] = await fingerprints().catch((error) => ({ failure: String(error) }))
  if (JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])) {
    report.passed = false
    report['failure'] = 'Qualifier sources changed during execution'
  }
  if (!functional && (!after.clean || after.commit !== before.commit)) {
    report.passed = false
    report['failure'] = 'Committed source changed during profile'
  }
  const output = join(work, 'report.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ passed: report.passed, output, failure: report['failure'] }))
}
if (!report.passed) process.exitCode = 1
