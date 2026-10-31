import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
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
import { count } from './workload.ts'
import toolchain from '../../toolchain.json'

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    'host-profile': { type: 'string' },
    output: { type: 'string' },
    trials: { type: 'string', default: '5' },
    iterations: { type: 'string', default: '1000' },
    rotations: { type: 'string', default: '1000' },
    mounts: { type: 'string', default: '100' },
    rows: { type: 'string', default: '32' },
  },
  strict: true,
  allowPositionals: false,
})
if (!values.host || !isAbsolute(values.host) || !values.output || !isAbsolute(values.output))
  throw new Error('--host and --output require absolute paths')
if (values['host-profile'] !== 'dev' && values['host-profile'] !== 'release')
  throw new Error('--host-profile must be dev or release')
const trials = count(values.trials, 'trials', 10)
const iterations = count(values.iterations, 'iterations', 10_000)
count(values.rotations, 'rotations', 10_000)
count(values.mounts, 'mounts', 1_000)
count(values.rows, 'rows', 128)
if (iterations % 10 !== 0) throw new Error('iterations must be a multiple of 10')
assert.equal(Bun.revision, toolchain.bun.revision, 'Use the checksum-pinned Bun compiler')
const source = resolve(import.meta.dir, '../..')
const output = values.output
const host = values.host
if (!statSync(host).isFile()) throw new Error('The native host must be an existing file')
mkdirSync(output) // Refuse to overwrite any previous comparison directory.

async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}

function command(
  name: string,
  argv: string[],
  timeout = 120_000,
  evidence?: { path: string; nonce: string }
) {
  const result = Bun.spawnSync(argv, {
    cwd: source,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 1_048_576,
    env: {
      ...process.env,
      BUN_NATIVE_EVIDENCE_LOG: evidence?.path ?? '',
      BUN_NATIVE_EVIDENCE_NONCE: evidence?.nonce ?? '',
    },
  })
  writeFileSync(join(output, `${name}.stdout.log`), result.stdout)
  writeFileSync(join(output, `${name}.stderr.log`), result.stderr)
  if (result.stdout.length + result.stderr.length > 1_048_576)
    throw new Error(`${name} exceeded the 1 MiB captured-log budget`)
  if (result.exitCode !== 0)
    throw new Error(`${name} failed (${result.exitCode}): ${result.stderr.toString().slice(-2000)}`)
  return result.stdout.toString().trim()
}

async function sourceFiles() {
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
  for await (const path of new Bun.Glob(
    'packages/{core,protocol,runtime,renderer,solid}/package.json'
  ).scan({
    cwd: source,
  }))
    paths.add(path)
  for await (const path of new Bun.Glob(
    'packages/{core,protocol,runtime,renderer,solid}/src/**/*.ts'
  ).scan({
    cwd: source,
  }))
    paths.add(path)
  for await (const path of new Bun.Glob('benchmarks/solid/*.{ts,tsx}').scan({ cwd: source }))
    paths.add(path)
  return Promise.all(
    [...paths].sort().map(async (path) => ({ path, ...(await digest(join(source, path))) }))
  )
}

const sourceBefore = await sourceFiles()
const nativeHost = { ...(await digest(host)), profile: values['host-profile'] }
const sourceCommit = command('source-commit', ['git', 'rev-parse', 'HEAD'])
const sourceDirty = command('source-status', ['git', 'status', '--porcelain']) !== ''
const report: Record<string, unknown> = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  source: { commit: sourceCommit, dirty: sourceDirty, files: sourceBefore },
  toolchain,
  nativeHost,
  target: {
    os: platform(),
    architecture: arch(),
    release: release(),
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    powerAndOtherLoad: 'uncontrolled',
  },
  displayRequest: {
    x11: process.env['DISPLAY'] ?? null,
    wayland: process.env['WAYLAND_DISPLAY'] ?? null,
    vulkanDriverFiles: process.env['VK_DRIVER_FILES'] ?? null,
    softwareGl: process.env['LIBGL_ALWAYS_SOFTWARE'] ?? null,
  },
  methodology: {
    runsPerPair: trials,
    warmupRunsPerPair: 1,
    ordering: 'all four adapter/mode pairs per trial; reverse order on alternating trials',
    applicationEntries: 'separate direct-core and Solid modules; direct-core does not bundle Solid',
    aotVerification:
      'controller inspects and hashes the exact executable it launches; child mode is only a declaration',
    measured:
      'submission through native acknowledgement, mutation counts, component reuse and bounded retention',
    hostProfile: 'explicit provenance label; retain the separate native build evidence',
    unsupported: [
      'input-to-paint latency',
      'display presentation latency',
      'physical input',
      'cumulative JavaScript allocations',
      'native allocation totals',
      'native RSS',
      'cold-cache startup',
      'long-term leak bounds',
    ],
  },
}
type Built = {
  adapter: 'core' | 'solid'
  mode: 'development' | 'aot'
  argv: string[]
  artifact: { bytes: number; sha256: string }
}
const built: Built[] = []
const builds: Record<string, unknown> = {}
const observations: Record<string, unknown>[] = []
const calibrations: Record<string, unknown>[] = []

async function checkedResult(build: Built, path: string, nonce: string) {
  if (statSync(path).size > 4_194_304) throw new Error('Child report exceeds 4 MiB')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid child report')
  const item = value as Record<string, unknown>
  assert.equal(item['status'], 'passed')
  assert.equal(item['nonce'], nonce)
  assert.equal(item['adapter'], build.adapter)
  assert.equal(item['declaredMode'], build.mode)
  assert.equal(item['bunRevision'], Bun.revision)
  assert.equal(typeof item['executable'], 'string')
  assert.equal(realpathSync(item['executable'] as string), realpathSync(build.argv[0]!))
  assert.deepEqual(item['cleanup'], {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
  return { item, report: await digest(path) }
}

async function checkArtifact(build: Built) {
  assert.deepEqual(
    await digest(build.argv.at(-1)!),
    build.artifact,
    'Application artifact changed before launch'
  )
}

try {
  for (const adapter of ['core', 'solid'] as const) {
    const destination = join(output, adapter)
    const entry = join(
      source,
      'benchmarks/solid',
      adapter === 'solid' ? 'reactive.tsx' : 'direct.ts'
    )
    const module = await buildSolid(entry, destination)
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
    command(`${adapter}-compile`, compileArgv)
    const inspection = inspectBunExecutable(binary)
    assert(inspection.hasCompiledProgram, 'Artifact lacks the actual compiled-program flag')
    const runtimeFeatures = platform() === 'linux' ? inspectBunRuntime(binary) : null
    if (runtimeFeatures) {
      assert(runtimeFeatures.jit === 'unused' || runtimeFeatures.jit === 'requested')
      assert(runtimeFeatures.jitRemovedRanges.count > 0, 'AOT JIT omission is not established')
    }
    const moduleHash = await digest(module)
    const binaryHash = await digest(binary)
    builds[adapter] = {
      entry,
      compileArgv,
      development: moduleHash,
      aot: { ...binaryHash, inspection, runtimeFeatures },
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
  // Separate instrumented launches establish actual native tree/GPU provenance.
  // Their timings are excluded from the uninstrumented repeated comparison.
  for (const build of built) {
    const name = `${build.adapter}-${build.mode}-calibration`
    const nonce = crypto.randomUUID()
    const resultPath = join(output, `${name}.json`)
    const evidencePath = join(output, `${name}.jsonl`)
    await checkArtifact(build)
    command(
      name,
      [
        ...build.argv,
        '--host',
        host,
        '--output',
        resultPath,
        '--nonce',
        nonce,
        '--mode',
        build.mode,
        '--iterations',
        '20',
        '--rotations',
        '20',
        '--mounts',
        '1',
        '--rows',
        values.rows!,
        '--calibration',
      ],
      180_000,
      { path: evidencePath, nonce }
    )
    const checked = await checkedResult(build, resultPath, nonce)
    calibrations.push({
      adapter: build.adapter,
      mode: build.mode,
      report: checked.report,
      nativeEvidence: await digest(evidencePath),
      initial: checked.item['initialNativePaint'],
      final: checked.item['finalNativePaint'],
    })
    console.log(JSON.stringify({ name, status: 'passed' }))
  }
  for (let trial = 0; trial <= trials; trial++) {
    const ordered = trial % 2 ? [...built].reverse() : built
    for (const build of ordered) {
      const name = `${build.adapter}-${build.mode}-${trial === 0 ? 'warmup' : trial}`
      const resultPath = join(output, `${name}.json`)
      const nonce = crypto.randomUUID()
      const argv = [
        ...build.argv,
        '--host',
        host,
        '--output',
        resultPath,
        '--nonce',
        nonce,
        '--mode',
        build.mode,
        '--iterations',
        values.iterations!,
        '--rotations',
        values.rotations!,
        '--mounts',
        values.mounts!,
        '--rows',
        values.rows!,
      ]
      await checkArtifact(build)
      command(name, argv, 180_000)
      const checked = await checkedResult(build, resultPath, nonce)
      observations.push({
        name,
        trial,
        warmup: trial === 0,
        adapter: build.adapter,
        mode: build.mode,
        command: argv,
        report: checked.report,
      })
      console.log(JSON.stringify({ name, status: 'passed' }))
    }
  }
  assert.deepEqual(await sourceFiles(), sourceBefore, 'Source changed during trials')
  assert.deepEqual(
    await digest(host),
    { bytes: nativeHost.bytes, sha256: nativeHost.sha256 },
    'Native host changed during trials'
  )
  report['status'] = 'passed'
} catch (error) {
  report['status'] = 'failed'
  report['error'] = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  report['builds'] = builds
  report['observations'] = observations
  report['calibrations'] = calibrations
  writeFileSync(join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n')
}
