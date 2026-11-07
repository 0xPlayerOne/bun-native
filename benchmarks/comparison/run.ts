import type { NativeApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildSolid } from '../../scripts/solid-build.ts'
import { inspectBunExecutable } from '../../experiments/aot-gpui/inspect.ts'
import { inspectBunRuntime } from '../../experiments/aot-gpui/inspect-runtime.ts'
import { count, expectedNodes, INPUT_LABEL, WINDOW_TITLE } from '../solid/workload.ts'
import { sharedWorkloadSources } from '../solid/sources.ts'
import {
  assertEquivalentPaint,
  summarize,
  summarizeInputLatency,
  type InputLaunch,
  type Launch,
} from './stats.ts'
import toolchain from '../../toolchain.json'

const ADAPTERS = ['core', 'solid', 'react'] as const
const MODES = ['development', 'aot'] as const
type Adapter = (typeof ADAPTERS)[number]
type Mode = (typeof MODES)[number]
const ENTRIES: Record<Adapter, string> = {
  core: 'benchmarks/solid/direct.ts',
  solid: 'benchmarks/solid/reactive.tsx',
  react: 'benchmarks/solid/react.tsx',
}

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    'host-profile': { type: 'string' },
    output: { type: 'string' },
    adapters: { type: 'string', default: ADAPTERS.join(',') },
    trials: { type: 'string', default: '5' },
    iterations: { type: 'string', default: '1000' },
    rotations: { type: 'string', default: '1000' },
    mounts: { type: 'string', default: '100' },
    rows: { type: 'string', default: '32' },
    'rss-interval-ms': { type: 'string', default: '20' },
    // Separate fresh launches with one real XTest click each; 0 skips them.
    'input-trials': { type: 'string', default: '0' },
    // Linux only: sync and drop the page, dentry and inode caches before every
    // timed, first, and calibration launch.
    'cold-cache': { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
})
if (!values.host || !isAbsolute(values.host) || !values.output || !isAbsolute(values.output))
  throw new Error('--host and --output require absolute paths')
if (values['host-profile'] !== 'dev' && values['host-profile'] !== 'release')
  throw new Error('--host-profile must be dev or release')
const adapters = values.adapters!.split(',') as Adapter[]
if (
  adapters.length === 0 ||
  new Set(adapters).size !== adapters.length ||
  !adapters.every((adapter) => ADAPTERS.includes(adapter))
)
  throw new Error(`--adapters must be distinct values from ${ADAPTERS.join(',')}`)
const trials = count(values.trials, 'trials', 30)
if (trials < 3) throw new Error('trials must be at least 3 for a reported interval')
const iterations = count(values.iterations, 'iterations', 10_000)
count(values.rotations, 'rotations', 10_000)
count(values.mounts, 'mounts', 1_000)
count(values.rows, 'rows', 128)
const rssInterval = count(values['rss-interval-ms'], 'rss-interval-ms', 1_000)
const inputTrials =
  values['input-trials'] === '0' ? 0 : count(values['input-trials'], 'input-trials', 30)
if (inputTrials && inputTrials < 3) throw new Error('input-trials must be 0 or at least 3')
if (inputTrials && (platform() !== 'linux' || !process.env['DISPLAY']))
  throw new Error('--input-trials requires the isolated Linux X11 session (XTest)')
const coldCache = values['cold-cache'] === true
if (coldCache && platform() !== 'linux')
  throw new Error('--cold-cache requires Linux (/proc/sys/vm/drop_caches)')
if (iterations % 10 !== 0) throw new Error('iterations must be a multiple of 10')
assert.equal(Bun.revision, toolchain.bun.revision, 'Use the checksum-pinned Bun compiler')
const source = resolve(import.meta.dir, '../..')
const output = values.output
const host = values.host
if (!statSync(host).isFile()) throw new Error('The native host must be an existing file')
mkdirSync(output) // Refuse to overwrite any previous comparison directory.
const launchesDirectory = join(output, 'launches')
mkdirSync(launchesDirectory)
const inputDirectory = join(output, 'input')
if (inputTrials) mkdirSync(inputDirectory)
const INPUT_DRIVER = join(source, 'scripts/quality/native-input-linux.py')
// The fixture button's native layout bounds are x 16..624, y 53..97 at scale 1.
const INPUT_CLICK = ['100', '75'] as const

async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}

function command(name: string, argv: string[], maxBuffer = 1_048_576) {
  const start = performance.now()
  const result = Bun.spawnSync(argv, {
    cwd: source,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 180_000,
    killSignal: 'SIGKILL',
    maxBuffer,
  })
  const wallMs = performance.now() - start
  writeFileSync(join(output, `${name}.stdout.log`), result.stdout)
  writeFileSync(join(output, `${name}.stderr.log`), result.stderr)
  if (result.exitCode !== 0)
    throw new Error(`${name} failed (${result.exitCode}): ${result.stderr.toString().slice(-2000)}`)
  return { stdout: result.stdout.toString().trim(), wallMs }
}

function optionalVersion(argv: string[]) {
  try {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  } catch {
    return null
  }
}

async function sourceFiles() {
  const workloadSources = new Map(
    (await sharedWorkloadSources(source)).map((record) => [record.path, record])
  )
  const paths = new Set([
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'bunfig.toml',
    '.bun-version',
    'toolchain.json',
    'scripts/solid-build.ts',
    'scripts/solid/transform.ts',
    'experiments/aot-gpui/inspect.ts',
    'experiments/aot-gpui/inspect-runtime.ts',
  ])
  const globs = [
    'packages/{core,protocol,runtime,renderer,solid,react}/package.json',
    'packages/{core,protocol,runtime,renderer,solid,react}/src/**/*.{ts,tsx}',
    'benchmarks/solid/*.{ts,tsx}',
    'benchmarks/comparison/*.ts',
  ]
  for (const pattern of globs)
    for await (const path of new Bun.Glob(pattern).scan({ cwd: source })) paths.add(path)
  for (const path of workloadSources.keys()) paths.add(path)
  return Promise.all(
    [...paths]
      .sort()
      .map(
        async (path) => workloadSources.get(path) ?? { path, ...(await digest(join(source, path))) }
      )
  )
}

// Process-tree RSS sampling on Linux (/proc) and macOS (ps); other platforms report null rather than a guess.
const rssSupported = platform() === 'linux' || platform() === 'darwin'
const cpuSupported = rssSupported
const pageSize = Number(optionalVersion(['getconf', 'PAGESIZE']) ?? '4096')
/** pid -> parent pid, and (macOS only) resident bytes from one consistent `ps` snapshot. */
function processTable() {
  const parents = new Map<number, number>()
  const resident = new Map<number, number>()
  if (platform() === 'darwin') {
    const listing = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss='], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    })
    for (const line of listing.stdout.toString().split('\n')) {
      const [pid, parent, kib] = line.trim().split(/\s+/).map(Number)
      if (pid === undefined || parent === undefined || kib === undefined || Number.isNaN(kib))
        continue
      parents.set(pid, parent)
      resident.set(pid, kib * 1024)
    }
    return { parents, resident }
  }
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      // The command name may contain spaces; fields resume after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      parents.set(Number(entry), Number(fields[1]))
    } catch {
      // The process exited between listing and reading.
    }
  }
  return { parents, resident }
}
function residentBytes(pid: number, resident: Map<number, number>) {
  const known = resident.get(pid)
  if (known !== undefined) return known
  try {
    return Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * pageSize
  } catch {
    return 0
  }
}
function treeRss(root: number) {
  const { parents, resident } = processTable()
  const tree = new Set([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, parent] of parents)
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid)
        grew = true
      }
  }
  const application = residentBytes(root, resident)
  let descendants = 0
  for (const pid of tree) if (pid !== root) descendants += residentBytes(pid, resident)
  return { application, descendants, total: application + descendants }
}
/** One-line system load: /proc/loadavg on Linux, `sysctl vm.loadavg` on macOS. */
function loadAverage() {
  if (platform() === 'darwin')
    return optionalVersion(['sysctl', '-n', 'vm.loadavg']) ?? 'unavailable'
  return readFileSync('/proc/loadavg', 'utf8').trim()
}

/**
 * Flush dirty pages and drop the page cache, dentries and inodes so the next launch
 * reads the executable, host and libraries from storage. Needs root or passwordless
 * sudo; the controller calls it once before any build so a refusal fails the run.
 */
function dropPageCache() {
  Bun.spawnSync(['sync'], { timeout: 60_000 })
  try {
    writeFileSync('/proc/sys/vm/drop_caches', '3\n')
    return
  } catch {
    // Not root: fall through to passwordless sudo.
  }
  const result = Bun.spawnSync(['sudo', '-n', 'tee', '/proc/sys/vm/drop_caches'], {
    stdin: Buffer.from('3\n'),
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  })
  if (result.exitCode !== 0)
    throw new Error(
      `--cold-cache could not drop the page cache (needs root or passwordless sudo): ${result.stderr.toString().trim()}`
    )
}
if (coldCache) dropPageCache()

async function launch(
  name: string,
  argv: string[],
  env: Record<string, string | undefined>
): Promise<Launch['process']> {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env }))
    if (value !== undefined) childEnv[key] = value
  if (coldCache) dropPageCache()
  const spawnEpochMs = Date.now()
  const start = performance.now()
  const child = Bun.spawn(argv, {
    cwd: source,
    stdout: Bun.file(join(launchesDirectory, `${name}.stdout.log`)),
    stderr: Bun.file(join(launchesDirectory, `${name}.stderr.log`)),
    env: childEnv,
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  let peakTree: number | null = null
  let peakApplication: number | null = null
  let peakHost: number | null = null
  let samples = 0
  let exited = false
  void child.exited.then(() => {
    exited = true
  })
  if (rssSupported) {
    peakTree = peakApplication = peakHost = 0
    while (!exited) {
      const rss = treeRss(child.pid)
      if (rss.total > 0) {
        samples++
        peakTree = Math.max(peakTree, rss.total)
        peakApplication = Math.max(peakApplication, rss.application)
        peakHost = Math.max(peakHost, rss.descendants)
      }
      await Promise.race([Bun.sleep(rssInterval), child.exited])
    }
  }
  const exitCode = await child.exited
  clearTimeout(timer)
  // wait4 resource usage of the application, including every descendant it reaped
  // (the native host is waited for on an orderly exit). A host that is killed or
  // orphaned is not counted, and GPU time is not measured.
  const usage = cpuSupported ? child.resourceUsage() : undefined
  return {
    spawnEpochMs,
    wallMs: performance.now() - start,
    exitCode,
    pageCacheDropped: coldCache,
    cpuUserMs: usage ? Number(usage.cpuTime.user) / 1_000 : null,
    cpuSystemMs: usage ? Number(usage.cpuTime.system) / 1_000 : null,
    peakTreeRssBytes: peakTree,
    peakApplicationRssBytes: peakApplication,
    peakHostRssBytes: peakHost,
    rssSamples: samples,
  }
}

const emptyDiagnostics = {
  windows: 0,
  nodes: 0,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
  serviceRequests: 0,
} satisfies NativeApplication['diagnostics']

type Built = {
  adapter: Adapter
  mode: Mode
  argv: string[]
  artifact: { bytes: number; sha256: string }
}

function childReport(build: Built, path: string, nonce: string) {
  if (!existsSync(path)) return { error: 'child wrote no report' }
  if (statSync(path).size > 4_194_304) return { error: 'child report exceeds 4 MiB' }
  const item = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  try {
    assert.equal(item['nonce'], nonce)
    assert.equal(item['adapter'], build.adapter)
    assert.equal(item['declaredMode'], build.mode)
    assert.equal(item['bunRevision'], Bun.revision)
    assert.equal(realpathSync(item['executable'] as string), realpathSync(build.argv[0]!))
    assert.equal(item['status'], 'passed')
    assert.deepEqual(item['cleanup'], emptyDiagnostics)
  } catch (error) {
    return { item, error: error instanceof Error ? error.message : String(error) }
  }
  return { item }
}

function workloadArguments(
  path: string,
  nonce: string,
  mode: Mode,
  calibration: boolean,
  input = false
) {
  return [
    '--host',
    host,
    '--output',
    path,
    '--nonce',
    nonce,
    '--mode',
    mode,
    '--iterations',
    calibration ? '20' : values.iterations!,
    '--rotations',
    calibration ? '20' : values.rotations!,
    '--mounts',
    calibration ? '2' : values.mounts!,
    '--rows',
    values.rows!,
    ...(calibration ? ['--calibration'] : []),
    ...(input ? ['--input-latency'] : []),
  ]
}

function osRelease() {
  if (platform() === 'darwin') {
    const version = optionalVersion(['sw_vers', '-productVersion'])
    const build = optionalVersion(['sw_vers', '-buildVersion'])
    return version ? `macOS ${version}${build ? ` (${build})` : ''}` : null
  }
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

const sourceBefore = await sourceFiles()
const nativeHost = { ...(await digest(host)), profile: values['host-profile'] }
const report: Record<string, unknown> = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  command: process.argv,
  source: {
    commit: command('source-commit', ['git', 'rev-parse', 'HEAD']).stdout,
    dirty: command('source-status', ['git', 'status', '--porcelain']).stdout !== '',
    files: sourceBefore,
  },
  toolchain: {
    pinned: toolchain,
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    rustc: optionalVersion(['rustc', '--version']),
    cargo: optionalVersion(['cargo', '--version']),
    mesaVulkanDrivers: optionalVersion([
      'dpkg-query',
      '-W',
      '-f=${Version}',
      'mesa-vulkan-drivers',
    ]),
    xvfb: optionalVersion(['dpkg-query', '-W', '-f=${Version}', 'xvfb']),
  },
  nativeHost,
  target: {
    os: platform(),
    osRelease: osRelease(),
    architecture: arch(),
    kernel: release(),
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    powerAndOtherLoad: `uncontrolled; ${platform() === 'darwin' ? 'sysctl vm.loadavg' : '/proc/loadavg'} is recorded before every launch`,
    ...(platform() === 'darwin'
      ? {
          macos: {
            xcode: optionalVersion(['xcodebuild', '-version']),
            powerSource: optionalVersion(['pmset', '-g', 'batt']),
            thermal: optionalVersion(['pmset', '-g', 'therm']),
            displays: optionalVersion(['system_profiler', 'SPDisplaysDataType']),
          },
        }
      : {}),
    cacheState: 'uncontrolled; no page-cache flushing',
  },
  displayRequest: {
    x11: process.env['DISPLAY'] ?? null,
    wayland: process.env['WAYLAND_DISPLAY'] ?? null,
    vulkanDriverFiles: process.env['VK_DRIVER_FILES'] ?? null,
    softwareGl: process.env['LIBGL_ALWAYS_SOFTWARE'] ?? null,
  },
  methodology: {
    adapters,
    modes: MODES,
    measuredTrials: trials,
    firstLaunch: coldCache
      ? 'trial 0 runs every artifact once immediately after its build and is reported separately; --cold-cache additionally syncs and drops the page, dentry and inode caches before this and every other timed launch, so all launches are cold-cache (input-latency launches excepted)'
      : 'trial 0 runs every artifact once immediately after its build; it is reported separately as first-launch-after-build, never as a controlled cold-cache start',
    ordering:
      'every measured trial runs all adapter/mode pairs; the start offset rotates each trial and odd trials reverse the order',
    equivalence:
      'every passed launch must report identical workload parameters, per-phase operation and native mutation counts, lifecycle ownership, retention and cleanup; calibrated initial/final native paint trees and renderer identity must match across all artifacts; otherwise the comparison is rejected',
    failures:
      'failed launches are retained with logs and excluded from distributions; they are never retried',
    intervals:
      'per-launch metrics use each fresh process as the independent unit (percentile bootstrap, 2000 resamples, seed 244); pooled per-operation samples are described but not bootstrapped',
    rss: `controller samples ${platform() === 'darwin' ? 'ps rss' : '/proc statm'} of the launched process and its descendants (native host) every ${rssInterval} ms; peaks can be missed and shared pages are counted per process`,
    cpu: 'CPU time is the wait4 user plus system time of the application including descendants it reaped (the native host on an orderly exit); GPU time is not measured',
    startup:
      'controller spawn epoch combined with child performance.timeOrigin milestones; window open and view mount are acknowledged native states, not display presentation',
    aotVerification:
      'controller inspects and hashes the exact executable it launches; child mode is only a declaration',
    developmentCalibration:
      'BUN_JSC_useDFGJIT=0 for development calibration only, as in native CI (#287); timed launches keep default tiers',
    inputLatency: inputTrials
      ? {
          trials: inputTrials,
          driver: 'scripts/quality/native-input-linux.py',
          click: INPUT_CLICK.map(Number),
          metric:
            'command_start_to_paint_observed_ms: immediately before the XTest click command to the validated complete native paint record of the clicked label (benchmarks/NATIVE_PAINT.md)',
          scope:
            'one click per fresh launch, after the expected initial paint; includes xdotool, X server delivery, adapter update, native scheduling, paint instrumentation and log I/O; not display presentation',
          ordering: 'separate launches after the timed trials, with the same rotated order',
          evidence: 'native paint evidence is enabled for these launches only',
        }
      : null,
    unsupported: [
      'direct Rust GPUI baseline (separate runner: benchmarks/rust-gpui/run.ts)',
      'Electrobun/WebView baselines',
      'display presentation (input latency ends at the validated native paint record)',
      ...(inputTrials ? [] : ['input-to-paint latency (run with --input-trials)']),
      'GPU utilization',
      ...(coldCache ? [] : ['controlled cold-cache startup (run with --cold-cache on Linux)']),
      'hardware GPU (this runner uses the session renderer, recorded per calibration)',
      'macOS and Windows',
    ],
  },
}
const built: Built[] = []
const builds: Record<string, unknown> = {}
const launches: Launch[] = []
const calibrations: Record<string, unknown>[] = []
const loads: Record<string, string> = {}
const inputLaunches: InputLaunch[] = []

function paintExpectation(label: string, revision?: number) {
  const rows = Array.from({ length: Number(values.rows) }, (_, id) => ({ id, text: `Row ${id}` }))
  return {
    type: 'rendered',
    stage: 'native-paint',
    window_id: 1,
    ...(revision === undefined ? {} : { tree_revision: revision }),
    nodes: expectedNodes(rows, label),
  }
}

/** One fresh launch driven by real XTest input; the driver owns the latency clock. */
async function runInput(build: Built, name: string, trial: number) {
  assert.deepEqual(await digest(build.argv.at(-1)!), build.artifact, 'Artifact changed')
  const path = join(inputDirectory, `${name}.json`)
  const evidence = join(inputDirectory, name)
  const nonce = crypto.randomUUID()
  loads[name] = loadAverage()
  const argv = [
    'python3',
    INPUT_DRIVER,
    '--output',
    evidence,
    '--mode',
    build.mode,
    '--title',
    WINDOW_TITLE,
    '--timeout',
    '30',
    '--require-unforced-cleanup',
    '--expect-initial-render',
    JSON.stringify(paintExpectation('Initial', 1)),
    '--expect-render',
    JSON.stringify(paintExpectation(INPUT_LABEL)),
    '--expect-event',
    JSON.stringify({
      type: 'click',
      stage: 'bun-application',
      target: 'benchmark-fixture',
      adapter: build.adapter,
    }),
    '--click',
    ...INPUT_CLICK,
    '--',
    ...build.argv,
    ...workloadArguments(path, nonce, build.mode, false, true),
  ]
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith('BUN_NATIVE_EVIDENCE_')) env[key] = value
  env['BUN_NATIVE_HOST'] = host
  env['BUN_NATIVE_HOST_PROFILE'] = values['host-profile']!
  // No RSS polling here: it would compete with the measured input interval.
  const child = Bun.spawn(argv, {
    cwd: source,
    stdout: Bun.file(join(inputDirectory, `${name}.driver.stdout.log`)),
    stderr: Bun.file(join(inputDirectory, `${name}.driver.stderr.log`)),
    env,
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const exitCode = await child.exited
  clearTimeout(timer)
  let error: string | null = null
  let latency: number | null = null
  try {
    const result = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'))
    assert.equal(result.status, 'passed', `driver status ${result.status}: ${result.error ?? ''}`)
    assert.equal(exitCode, 0, `driver exit ${exitCode}`)
    const observation = result.measurements.native_paint_file_observation
    latency = observation.command_start_to_paint_observed_ms
    assert(typeof latency === 'number' && Number.isFinite(latency) && latency >= 0)
    const checked = childReport(build, path, nonce)
    if (checked.error) throw new Error(`child report: ${checked.error}`)
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
    latency = null
  }
  inputLaunches.push({
    name,
    adapter: build.adapter,
    mode: build.mode,
    trial,
    status: error ? 'failed' : 'passed',
    commandStartToPaintObservedMs: latency,
    error,
  })
  console.log(JSON.stringify({ name, status: error ? 'failed' : 'passed', error, latency }))
}

async function run(build: Built, name: string, trial: number, warmup: boolean) {
  assert.deepEqual(await digest(build.argv.at(-1)!), build.artifact, 'Artifact changed')
  const path = join(launchesDirectory, `${name}.json`)
  const nonce = crypto.randomUUID()
  loads[name] = loadAverage()
  const processResult = await launch(
    name,
    [...build.argv, ...workloadArguments(path, nonce, build.mode, false)],
    { BUN_NATIVE_EVIDENCE_LOG: undefined, BUN_NATIVE_EVIDENCE_NONCE: undefined }
  )
  const checked = childReport(build, path, nonce)
  const passed = processResult.exitCode === 0 && !checked.error
  launches.push({
    name,
    adapter: build.adapter,
    mode: build.mode,
    trial,
    warmup,
    status: passed ? 'passed' : 'failed',
    ...(checked.item ? { report: checked.item } : {}),
    process: processResult,
  })
  const line = { name, status: passed ? 'passed' : 'failed', error: checked.error ?? null }
  console.log(JSON.stringify(line))
}

try {
  for (const adapter of adapters) {
    const destination = join(output, adapter)
    const entry = join(source, ENTRIES[adapter])
    const developmentDirectory = join(destination, 'development')
    const rebuildDirectory = join(destination, 'rebuild')
    // Build twice: the first is a fresh build, the second an unchanged rebuild.
    // Identical hashes are required so both modes start from one module.
    const buildTimes: number[] = []
    for (const directory of [developmentDirectory, rebuildDirectory]) {
      const start = performance.now()
      if (adapter === 'react')
        command(`${adapter}-bundle-${buildTimes.length}`, [
          process.execPath,
          'build',
          '--no-script',
          '--production',
          '--define',
          'process.env.NODE_ENV="production"',
          '--target=bun',
          '--format=esm',
          '--sourcemap=external',
          entry,
          '--outdir',
          directory,
          '--entry-naming=application.js',
        ])
      else await buildSolid(entry, directory)
      buildTimes.push(performance.now() - start)
    }
    const module = join(developmentDirectory, 'application.js')
    const moduleHash = await digest(module)
    assert.deepEqual(
      await digest(join(rebuildDirectory, 'application.js')),
      moduleHash,
      `${adapter} module build is not reproducible`
    )
    const binary = join(destination, platform() === 'win32' ? 'application.exe' : 'application')
    const compileArgv = [
      process.execPath,
      'compile',
      '--no-script',
      '--production',
      '--explain=json',
      module,
      '--outfile',
      binary,
    ]
    // --explain=json output exceeds 1 MiB for React.
    const compiled = command(`${adapter}-compile`, compileArgv, 16_777_216)
    const inspection = inspectBunExecutable(binary)
    assert(inspection.hasCompiledProgram, 'Artifact lacks the actual compiled-program flag')
    const runtimeFeatures = platform() === 'linux' ? inspectBunRuntime(binary) : null
    if (runtimeFeatures) {
      assert(runtimeFeatures.jit === 'unused' || runtimeFeatures.jit === 'requested')
      assert(runtimeFeatures.jitRemovedRanges.count > 0, 'AOT JIT omission is not established')
    }
    const binaryHash = await digest(binary)
    builds[adapter] = {
      entry: ENTRIES[adapter],
      moduleBuildWallMs: { fresh: buildTimes[0], unchangedRebuild: buildTimes[1] },
      aotCompileWallMs: compiled.wallMs,
      compileArgv,
      development: moduleHash,
      aot: { ...binaryHash, inspection, runtimeFeatures },
      shippedBytes: {
        developmentModulePlusHost: moduleHash.bytes + nativeHost.bytes,
        aotExecutablePlusHost: binaryHash.bytes + nativeHost.bytes,
        note: 'development additionally requires a Bun runtime installation; system libraries excluded',
      },
    }
    built.push({
      adapter,
      mode: 'development',
      argv: [process.execPath, module],
      artifact: moduleHash,
    })
    built.push({ adapter, mode: 'aot', argv: [binary], artifact: binaryHash })
  }
  assert.deepEqual(await sourceFiles(), sourceBefore, 'Source changed during compilation')

  // Trial 0: the first process launch of every freshly built artifact.
  for (const build of built) await run(build, `${build.adapter}-${build.mode}-first`, 0, true)

  // Instrumented calibrations prove the identical native tree and renderer.
  for (const build of built) {
    const name = `${build.adapter}-${build.mode}-calibration`
    const nonce = crypto.randomUUID()
    const resultPath = join(output, `${name}.json`)
    const evidencePath = join(output, `${name}.jsonl`)
    const processResult = await launch(
      name,
      [...build.argv, ...workloadArguments(resultPath, nonce, build.mode, true)],
      {
        BUN_NATIVE_EVIDENCE_LOG: evidencePath,
        BUN_NATIVE_EVIDENCE_NONCE: nonce,
        ...(build.mode === 'development' ? { BUN_JSC_useDFGJIT: '0' } : {}),
      }
    )
    const checked = childReport(build, resultPath, nonce)
    if (processResult.exitCode !== 0 || checked.error)
      throw new Error(`${name} failed: ${checked.error ?? `exit ${processResult.exitCode}`}`)
    calibrations.push({
      name,
      adapter: build.adapter,
      mode: build.mode,
      report: await digest(resultPath),
      nativeEvidence: await digest(evidencePath),
      initial: checked.item!['initialNativePaint'],
      final: checked.item!['finalNativePaint'],
    })
    console.log(JSON.stringify({ name, status: 'passed' }))
  }
  assertEquivalentPaint(calibrations as { name: string; initial: unknown; final: unknown }[])

  for (let trial = 1; trial <= trials; trial++) {
    const offset = trial % built.length
    const rotated = [...built.slice(offset), ...built.slice(0, offset)]
    const ordered = trial % 2 ? rotated.reverse() : rotated
    for (const build of ordered)
      await run(build, `${build.adapter}-${build.mode}-${trial}`, trial, false)
  }
  for (let trial = 1; trial <= inputTrials; trial++) {
    const offset = trial % built.length
    const rotated = [...built.slice(offset), ...built.slice(0, offset)]
    const ordered = trial % 2 ? rotated.reverse() : rotated
    for (const build of ordered)
      await runInput(build, `${build.adapter}-${build.mode}-input-${trial}`, trial)
  }
  assert.deepEqual(await sourceFiles(), sourceBefore, 'Source changed during trials')
  assert.deepEqual(
    await digest(host),
    { bytes: nativeHost.bytes, sha256: nativeHost.sha256 },
    'Native host changed during trials'
  )
  report['summary'] = summarize(launches)
  if (inputTrials) report['inputLatency'] = summarizeInputLatency(inputLaunches)
  const failed = [...launches, ...inputLaunches]
    .filter((item) => item.status === 'failed')
    .map((item) => item.name)
  report['failedLaunches'] = failed
  report['status'] = failed.length ? 'completed-with-failures' : 'passed'
} catch (error) {
  report['status'] = 'failed'
  report['error'] = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  report['finishedAt'] = new Date().toISOString()
  report['builds'] = builds
  report['calibrations'] = calibrations
  report['loadAverageBeforeLaunch'] = loads
  report['inputLaunches'] = await Promise.all(
    inputLaunches.map(async (item) => {
      const path = join(inputDirectory, `${item.name}.json`)
      const driver = join(inputDirectory, item.name, 'result.json')
      return {
        ...item,
        childReport: existsSync(path) ? await digest(path) : null,
        driverReport: existsSync(driver) ? await digest(driver) : null,
      }
    })
  )
  // Raw per-launch records: process observations plus each child's full report digest.
  report['launches'] = await Promise.all(
    launches.map(async ({ report: child, ...rest }) => {
      const path = join(launchesDirectory, `${rest.name}.json`)
      return { ...rest, childReport: child && existsSync(path) ? await digest(path) : null }
    })
  )
  writeFileSync(join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n')
}
