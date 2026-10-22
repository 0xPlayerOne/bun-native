import { createHash } from 'node:crypto'
import { cpus, totalmem, release } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { schedule } from '../benchmarks/lib/statistics.ts'
import {
  validateRun,
  reportRun,
  compareRuns,
  type BenchmarkRun,
  type Trial,
  type Variant,
} from '../benchmarks/lib/results.ts'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { evaluateBudgets } from '../benchmarks/lib/regression-budgets.ts'
import { SCENARIOS, mockScenario } from '../benchmarks/lib/mock-scenarios.ts'
import { electronIdentity, electronScenario } from '../benchmarks/adapters/electron/driver.ts'
const root = resolve(import.meta.dir, '..')
const [command = 'record', argument = 'mock', destination = '.bunly/benchmarks/mock.json'] =
  process.argv.slice(2)
function option(name: string, fallback: number): number {
  const item = process.argv.find((value) => value.startsWith(`--${name}=`))
  const number = item ? Number(item.slice(name.length + 3)) : fallback
  if (!Number.isInteger(number) || number < 0 || number > 1000) throw new Error(`Invalid ${name}`)
  return number
}
async function fingerprint(): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [
    'benchmarks/fixtures/data.ts',
    'benchmarks/fixtures/server.ts',
    'benchmarks/fixtures/package.json',
    'examples/workbench/ui.ts',
    'examples/workbench/workbench.html',
    'examples/workbench/service.ts',
  ]) {
    hash.update(path + '\0')
    hash.update(await readFile(join(root, path)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
if (command === 'record') {
  const ids = argument.split(',')
  if (ids.some((id) => !['mock', 'electron'].includes(id)) || new Set(ids).size !== ids.length)
    throw new Error('Expected adapter list mock,electron')
  const repetitions = option('trials', 3)
  const warmups = option('warmups', 1)
  const seed = option('seed', 42)
  if (repetitions < 1) throw new Error('At least one measured trial is required')
  const variants: Variant[] = ids.map((id) =>
    id === 'electron'
      ? electronIdentity
      : {
          id: 'mock',
          framework: 'bunly-contract-mock',
          version: '0.1.0-dev.0',
          sourceCommit: null,
          runtime: 'Bun',
          runtimeVersion: Bun.version,
          engine: 'none',
          engineVersion: null,
          securityProfile: 'no-renderer-contract-only',
          configuration: 'default',
        }
  )
  const scenarios = ['app-launch', ...SCENARIOS]
  const trials: Trial[] = []
  for (const warmup of [true, false]) {
    const count = warmup ? warmups : repetitions
    if (!count) continue
    for (const { variant, trial } of schedule(ids, count, seed + Number(warmup))) {
      for (const scenario of scenarios) {
        let outcome: Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>
        try {
          outcome = await (variant === 'mock' ? mockScenario(scenario) : electronScenario(scenario))
        } catch (error) {
          outcome = {
            status: 'failed',
            reason: String(error),
            correctness: {
              passed: false,
              details: 'Execution failed; no successful timing recorded',
            },
            metrics: {},
          }
        }
        const result = { variant, scenario, trial, warmup, ...outcome }
        trials.push(result)
        if (result.status === 'failed')
          console.error(JSON.stringify({ failedTrialIncludingWarmup: result }))
      }
    }
  }
  const source = sourceIdentity(root)
  const run: BenchmarkRun = {
    schema: 1,
    createdAt: new Date().toISOString(),
    fixtureSha256: await fingerprint(),
    seed,
    repetitions,
    warmups,
    scenarios,
    variants,
    sourceCommit: source.clean && source.commit ? source.commit : 'local-uncommitted',
    parameters: { lines: 256, columns: 80, terminal: 'xterm-5.5.0' },
    environment: {
      runClass: process.env['CI']
        ? 'ci-smoke'
        : process.env['BUNLY_BENCH_CONTROLLED'] === '1'
          ? 'controlled'
          : 'local-smoke',
      target: `${process.platform}-${process.arch}`,
      os: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length || 1,
      memoryBytes: totalmem(),
      gpu: process.env['BUNLY_BENCH_GPU'] ?? 'unknown',
      display: process.env['BUNLY_BENCH_DISPLAY'] ?? 'unknown',
      power: process.env['BUNLY_BENCH_POWER'] ?? 'unknown',
      machineLabel: process.env['BUNLY_BENCH_MACHINE'] ?? 'unknown',
    },
    trials,
  }
  validateRun(run)
  const path = resolve(root, destination)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(run, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        result: destination,
        failedTrialsIncludingWarmups: trials.filter((trial) => trial.status === 'failed'),
        summary: reportRun(run),
      },
      null,
      2
    )
  )
  if (trials.some((trial) => trial.status === 'failed')) process.exitCode = 1
  else if (
    process.argv.includes('--require-complete') &&
    trials.some((trial) => trial.status === 'unsupported')
  )
    process.exitCode = 2
} else if (command === 'report')
  console.log(JSON.stringify(reportRun(JSON.parse(await readFile(argument, 'utf8'))), null, 2))
else if (command === 'inventory') console.log(JSON.stringify(await inventory(argument), null, 2))
else if (command === 'compare') {
  const before = validateRun(JSON.parse(await readFile(argument, 'utf8')))
  const after = validateRun(JSON.parse(await readFile(destination, 'utf8')))
  const result = compareRuns(before, after, before.variants[0]!.id, after.variants[0]!.id)
  const budgetOption = process.argv.find((value) => value.startsWith('--budgets='))
  if (budgetOption) {
    const policies: unknown = JSON.parse(
      await readFile(budgetOption.slice('--budgets='.length), 'utf8')
    )
    if (!Array.isArray(policies)) throw new Error('Budget policy must be an array')
    const budgets = evaluateBudgets(
      before,
      after,
      before.variants[0]!.id,
      after.variants[0]!.id,
      policies
    )
    console.log(JSON.stringify({ comparison: result, budgets }, null, 2))
    if (budgets.status === 'ineligible') process.exitCode = 2
    else if (budgets.status === 'failed') process.exitCode = 1
  } else {
    console.log(JSON.stringify(result, null, 2))
    if (!result.comparable) process.exitCode = 2
  }
} else
  throw new Error(
    'Commands: record [mock,electron] [output] --trials=N --warmups=N --seed=N; report <file>; compare <before> <after> [--budgets=policy.json]; inventory <directory>'
  )
