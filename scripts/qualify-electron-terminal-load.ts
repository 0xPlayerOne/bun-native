/** Pinned Electron with equal Bun PTY producers; not ordinary Electron Node PTYs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import {
  acceptLoadRows,
  loadProcessPhases,
  loadProcessQuarterTrends,
} from '../benchmarks/lib/terminal-load-acceptance.ts'
import { profileOptions } from '../benchmarks/foundation/statistics.ts'
import { schedule } from '../benchmarks/lib/statistics.ts'
import type { ObservationSample } from '../benchmarks/lib/observation.ts'
import { LOAD_DEFINES, LOAD_OBSERVER_MS } from '../examples/cef-terminal-load/profile.ts'
import { LOAD } from '../examples/cef-terminal-load/workload.ts'
const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const functional = args.length === 1 && args[0] === '--functional'
const options = functional ? { samples: 1, warmups: 0, output: '' } : profileOptions(args, '')
assert.equal(Bun.version, '1.4.3')
assert.equal(options.output, '')
const before = sourceIdentity(root)
if (!functional) assert.ok(before.clean, 'Profile requires clean source')
const adapter = join(root, 'benchmarks/adapters/electron')
const require = createRequire(join(adapter, 'driver.ts'))
// An existing pinned installation may be supplied; no downloads or repinning here.
const executable = process.env['BUNLY_ELECTRON_EXECUTABLE'] ?? (require('electron') as string)
const parent = join(root, '.bunly/m5/electron-terminal-load')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const sources = [
  'benchmarks/adapters/electron/package.json',
  'benchmarks/adapters/electron/bun.lock',
  'benchmarks/adapters/electron/terminal-load/main.cjs',
  'benchmarks/adapters/electron/terminal-load/preload.cjs',
  'benchmarks/adapters/electron/terminal-load/controller.ts',
  'benchmarks/adapters/electron/terminal-load/client.ts',
  'examples/cef-terminal-load/consumer.ts',
  'examples/cef-terminal-load/diagnostics.ts',
  'examples/cef-terminal-load/probe.ts',
  'examples/cef-terminal-load/workload.ts',
  'examples/cef-terminal-load/profile.ts',
  'examples/cef-terminal-load/mode-state.ts',
  'scripts/qualify-terminal-window-load.ts',
  'scripts/qualify-terminal-soak.ts',
  'examples/cef-terminal-load/contract.ts',
  'examples/cef-terminal-load/child.ts',
  'examples/cef-terminal/terminal-records.ts',
  'examples/cef-terminal/terminal-contract.ts',
  'packages/runtime/src/terminal.ts',
  'packages/runtime/src/fair-scheduler.ts',
  'packages/runtime/src/cef-lane-transport.ts',
  'packages/runtime/src/stream-source.ts',
  'packages/contracts/src/streams.ts',
  'scripts/qualify-electron-terminal-load.ts',
  'benchmarks/lib/terminal-load-acceptance.ts',
  'scripts/observe-process.py',
]
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const report: Record<string, unknown> = {
  schema: 1,
  workload: LOAD,
  observerTimeoutMs: LOAD_OBSERVER_MS,
  sourceBefore: before,
  sourceHashes: await hashes(),
  passed: false,
  topology:
    'Electron Node main + one Bun controller + two Bun PTYs; shared graphical consumer and standard stream protocol over Electron IPC/base64 stdio',
  classification: 'descriptive-transport-renderer-baseline-not-ordinary-Electron-Node-backend',
  ratios: null,
  trials: [],
  executableSha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  limitations: [
    'Different Chromium versions and transports; no comparative admission or ratio.',
    'No physical input/paint measurement or true PTY production timestamp.',
    'External HTTP asset server and observer excluded; Node main, Bun controller and both PTYs included.',
    'Visible is not OS foreground; hidden is not minimized. Default Chromium throttling retained.',
  ],
}
const trials = report['trials'] as Record<string, unknown>[]
const assets = join(work, 'public')
await mkdir(assets)
for (const name of ['index.html', 'fixture.css'])
  await cp(join(root, 'examples/cef-terminal/public', name), join(assets, name))
assert.equal(
  JSON.parse(await readFile(join(root, 'node_modules/@xterm/xterm/package.json'), 'utf8')).version,
  '5.5.0'
)
await cp(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(assets, 'xterm.css'))
const build = await Bun.build({
  entrypoints: [join(adapter, 'terminal-load/client.ts')],
  outdir: assets,
  naming: 'terminal-client.js',
  target: 'browser',
  format: 'esm',
  define: LOAD_DEFINES,
})
assert.ok(build.success, build.logs.join('\n'))
// Compile controller and child with the same explicit fixed workload as the page.
// No runtime environment selector can silently disagree with renderer compilation.
const backendRoot = join(work, 'backend')
await mkdir(backendRoot)
for (const [source, name] of [
  [join(adapter, 'terminal-load/controller.ts'), 'controller.js'],
  [join(root, 'examples/cef-terminal-load/child.ts'), 'child.js'],
] as const) {
  const result = await Bun.build({
    entrypoints: [source],
    outdir: backendRoot,
    naming: name,
    target: 'bun',
    format: 'esm',
    minify: false,
    define: LOAD_DEFINES,
  })
  assert.ok(result.success, result.logs.join('\n'))
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (!['/', '/fixture.css', '/xterm.css', '/terminal-client.js'].includes(path))
      return new Response(null, { status: 404 })
    return new Response(Bun.file(join(assets, path === '/' ? 'index.html' : path.slice(1))))
  },
})
try {
  const order = schedule([...LOAD.modes], options.samples + options.warmups, 2709)
  report['trialOrder'] = order
  for (const item of order) {
    const index = item.trial - options.warmups,
      mode = item.variant
    const rawPath = join(work, `trial-${index}-${mode}.jsonl`)
    const profile = join(work, `profile-${index}-${mode}`)
    await mkdir(profile)
    const observation = await observedCommand(
      [
        executable,
        join(adapter, 'terminal-load/main.cjs'),
        `http://127.0.0.1:${server.port}`,
        profile,
        process.execPath,
        join(backendRoot, 'controller.js'),
        mode,
        rawPath,
        join(backendRoot, 'child.js'),
        LOAD.id,
      ],
      {
        cwd: root,
        output: join(work, `trial-${index}-${mode}.process.json`),
        timeoutMs: LOAD_OBSERVER_MS,
      }
    ).result
    const trial: Record<string, unknown> = {
      index,
      mode,
      warmup: index < 0,
      observation,
      passed: false,
    }
    trials.push(trial)
    try {
      const raw = await readFile(rawPath, 'utf8')
      trial['rawSha256'] = createHash('sha256').update(raw).digest('hex')
      const rows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      trial['failureDiagnostic'] = rows.find((row) => row.kind === 'failure') ?? null
      trial['quarterTrends'] = loadProcessQuarterTrends(
        observation.samples as unknown as ObservationSample[]
      )
      trial['phases'] = acceptLoadRows(raw, mode, observation.environment['os'], 'electron')
      trial['process'] = loadProcessPhases(observation.samples as unknown as ObservationSample[])
      assertCleanCommand(observation)
      const result = observation.stdoutTail
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((row) => row.scenario === LOAD.id)
      assert.equal(result?.passed, true)
      assert.equal(result.frameworkVersion, '44.9.3')
      assert.equal(result.platform, process.platform)
      assert.equal(result.arch, process.arch)
      assert.equal(result.backgroundThrottling, true)
      assert.deepEqual(result.security, {
        sandboxed: true,
        contextIsolated: true,
        nodeDisabled: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      })
      assert.ok(result.node && result.chromium)
      trial['identity'] = result
      trial.passed = true
    } catch (error) {
      trial['failure'] = error instanceof Error ? error.message : String(error)
    }
    console.log(JSON.stringify({ index, mode, passed: trial.passed, failure: trial['failure'] }))
  }
  report.passed = trials.length > 0 && trials.every((trial) => trial.passed)
} catch (error) {
  report['failure'] = String(error)
} finally {
  server.stop(true)
  report['sourceAfter'] = sourceIdentity(root)
  report['sourceHashesAfter'] = await hashes()
  if (
    JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter']) ||
    (!functional && !sourceIdentity(root).clean)
  )
    report.passed = false
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(JSON.stringify({ passed: report.passed, output: join(work, 'report.json') }))
}
if (!report.passed) process.exitCode = 1
