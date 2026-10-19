/** Sequential randomized actual framework subsets; differences stay visible, not a speed ranking. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { desktopEditTrial } from '../benchmarks/adapters/desktop-edit/driver.ts'
import { referenceDesktopTrial } from '../benchmarks/adapters/references/driver.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { schedule } from '../benchmarks/lib/statistics.ts'
const root = resolve(import.meta.dir, '..'),
  python = process.env['PYTHON'] ?? 'python3'
const adapters = ['electron', 'electrobun', 'mirin', 'butter'] as const
const repetitions = Number(process.argv[2] ?? 3),
  warmups = 1,
  seed = 71
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Expected 1..20 independent repetitions')
const parent = join(root, '.bunly/acceptance/m2-completion')
await mkdir(parent, { recursive: true, mode: 0o700 })
const output = await mkdtemp(join(parent, 'matrix-'))
const source = sourceIdentity(root)
const trials: Record<string, unknown>[] = []
const report = {
  schema: 1,
  createdAt: new Date().toISOString(),
  classification: 'condition-monitored-local-benchmark',
  source,
  plan: { adapters, repetitions, warmups, seed, idleMs: 5000 },
  trials,
  comparableAsEquivalentEngines: false,
  limitations: [
    'Different engine/security profiles, not an equivalent-engine speed ranking',
    'Pre/post system-load observations do not prove continuous hardware isolation',
    'Main-process bundling is not full Electron assembly',
    'Butter is a source/helper-primed system-webview profile',
    'M2 explicit stop-build-relaunch, not default watcher latency',
  ],
  passed: false,
}
async function snapshot() {
  const child = Bun.spawn([python, join(root, 'scripts/benchmark_environment.py')], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const text = await new Response(child.stdout).text()
  if (await child.exited) throw new Error('Environment probe failed')
  return JSON.parse(text)
}
for (const warmup of [true, false])
  for (const task of schedule(
    [...adapters],
    warmup ? warmups : repetitions,
    seed + Number(warmup)
  )) {
    const name = task.variant as (typeof adapters)[number]
    const before = await snapshot()
    const dir = join(output, `${warmup ? 'warmup' : 'trial'}-${task.trial}-${name}`)
    let result: unknown
    try {
      if (name === 'electron' || name === 'electrobun')
        result = await desktopEditTrial(name, dir, undefined, 5000)
      else {
        const lock = await readFile(
          join(
            root,
            `benchmarks/adapters/references/locks/${name === 'mirin' ? 'mirin' : 'butter-source'}.bun.lock`
          )
        )
        result = await referenceDesktopTrial(name, {
          installation: join(root, '.bunly/references', name),
          lockSha256: createHash('sha256').update(lock).digest('hex'),
          output: dir,
          idleObservationMs: 5000,
        })
      }
      const typed = result as {
        commands: readonly { phase: string; report: string; observation: unknown }[]
        passed: boolean
      }
      const app = typed.commands.find((c) => c.phase === 'app')
      let idle: unknown = null
      if (app) {
        const child = Bun.spawn(
          [python, join(root, 'scripts/summarize_runtime_observation.py'), join(dir, app.report)],
          { stdout: 'pipe', stderr: 'pipe' }
        )
        const text = await new Response(child.stdout).text()
        if (await child.exited) throw new Error('Idle reduction failed')
        idle = JSON.parse(text)
        const summary = idle as {
          observed: boolean
          sampleCount: number
          sampledDurationMs: number
          kernel: { status: string }
        }
        if (
          !summary.observed ||
          summary.sampleCount < 20 ||
          summary.sampledDurationMs < 4500 ||
          summary.kernel.status !== 'observed'
        )
          throw new Error('No qualified complete idle interval')
      } else if (typed.passed) throw new Error('Passing adapter is missing its process report')
      const after = await snapshot()
      trials.push({ adapter: name, trial: task.trial, warmup, before, after, result, idle })
      console.log(
        JSON.stringify({
          adapter: name,
          trial: task.trial,
          warmup,
          passed: (result as { passed: boolean }).passed,
          conditionsMet: before.conditionsMet && after.conditionsMet,
        })
      )
    } catch (error) {
      trials.push({ adapter: name, trial: task.trial, warmup, failed: String(error), result })
    }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    })
  }
report.passed =
  trials.length === adapters.length * (repetitions + warmups) &&
  trials.every((t) => (t['result'] as { passed?: boolean } | undefined)?.passed === true)
Object.assign(report, { sourceAfter: sourceIdentity(root) })
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
})
console.log(JSON.stringify({ passed: report.passed, output }))
if (!report.passed) process.exitCode = 1
